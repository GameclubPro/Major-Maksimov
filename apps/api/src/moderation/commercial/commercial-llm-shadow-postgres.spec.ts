import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { createPrismaClient, type PrismaClient, type Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CommercialReviewService, type Candidate } from './commercial-review.service';
import {
  CommercialLlmShadowStore,
  commercialLlmCandidate,
  COMMERCIAL_LLM_SCAN_LIMIT,
  COMMERCIAL_LLM_PRISMA_POOL,
} from './commercial-llm-shadow.store';
import {
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_INTERVAL_MS,
} from './commercial-llm-shadow.lease';
import { CommercialLlmShadowProcessor } from './commercial-llm-shadow.processor';
import {
  COMMERCIAL_LLM_MODEL_ALIAS,
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_POLICY_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
} from './commercial-llm.protocol';
import type { CommercialLlmClient } from './commercial-llm.client';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
(databaseUrl && redisUrl ? describe : describe.skip)(
  'commercial LLM shadow with native stores',
  () => {
    let prisma: PrismaClient;
    let shadowPrisma: PrismaClient;
    let redis: Redis;
    let review: CommercialReviewService;
    let store: CommercialLlmShadowStore;
    let lease: CommercialLlmShadowLease;
    const chatId = `llm-shadow-${randomUUID()}`;
    const base: Candidate = {
      chatId,
      userId: 'synthetic-user',
      messageId: 'synthetic-message',
      source: 'TEXT',
      text: 'Продам свой старый холодильник после переезда, один, б/у',
      score: 50,
      actionBand: 'REVIEW_ONLY',
      decisionFingerprint: 'synthetic-fingerprint',
      detectorVersion: 'synthetic-version',
      messageDisposition: 'KEEP',
      requiredPolicyCohorts: [],
      samplingProbability: 0.1,
      samplingStratum: 'NO_HIT',
      logicalMessageKey: 'a'.repeat(64),
      sourceSnapshotSha256: 'b'.repeat(64),
      settingsProfileDigest: 'c'.repeat(64),
      sourceExcerptComplete: true,
      analysisOutcome: 'COMPLETE',
    };
    const result: Awaited<ReturnType<CommercialLlmClient['classify']>> = {
      classification: 'NOT_COMMERCIAL',
      reasonCodes: ['PERSONAL_SALE'],
      durationMs: 10,
      modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
      runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
      runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
      chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
      policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    };
    const governor = {
      decide: jest.fn(async () => ({
        action: 'run' as 'run' | 'slow' | 'pause',
        retryAfterMs: 0,
        reason: 'synthetic-test',
      })),
    };
    const classify = jest.fn<
      ReturnType<CommercialLlmClient['classify']>,
      Parameters<CommercialLlmClient['classify']>
    >();
    const processor = () =>
      new CommercialLlmShadowProcessor(
        store,
        lease,
        () => ({ classify }),
        governor,
        async () => true,
      );
    const current = () => prisma.commercialReviewSample.findFirstOrThrow({ where: { chatId } });
    beforeAll(async () => {
      for (const raw of [databaseUrl, redisUrl]) {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname))
          throw new Error('Shadow tests require disposable loopback stores');
      }
      if (!new URL(databaseUrl).pathname.includes('race_test'))
        throw new Error('Expected race_test database');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      redis = createCommercialLlmRedis(redisUrl);
      await redis.connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Synthetic shadow test' } });
      review = new CommercialReviewService(prisma as unknown as PrismaService);
      shadowPrisma = createPrismaClient(databaseUrl, COMMERCIAL_LLM_PRISMA_POOL);
      store = new CommercialLlmShadowStore(shadowPrisma);
      lease = new CommercialLlmShadowLease(redis);
    });
    beforeEach(async () => {
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
      classify.mockReset().mockResolvedValue(result);
      governor.decide.mockResolvedValue({
        action: 'run',
        retryAfterMs: 0,
        reason: 'synthetic-test',
      });
      await review.recordCandidate(base);
    });
    afterAll(async () => {
      await shadowPrisma?.$disconnect();
      if (redis) {
        await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
        redis.disconnect();
      }
      if (prisma) {
        await prisma.chat.deleteMany({ where: { id: chatId } });
        await prisma.$disconnect();
      }
    });

    it('deduplicates mirrored observations while preserving blind labels and execution enrichment', async () => {
      await review.recordCandidate(base);
      const candidate = (await store.select()).candidate!;
      classify.mockImplementation(async () => {
        const row = await current();
        await review.labelItem(row.id, 'independent-reviewer', {
          expectedUpdatedAt: row.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          reason: 'Личная вещь',
        });
        await review.recordCandidate({ ...base, executionOutcome: 'NOT_REQUESTED' });
        return result;
      });
      expect((await processor().run()).outcome).toBe('COMPLETE');
      const row = await current();
      expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(1);
      expect(row.independentReviewCount).toBe(1);
      expect(row.llmShadow).toMatchObject({
        mode: 'SHADOW',
        status: 'COMPLETE',
        inputSha256: candidate.inputSha256,
      });
      await review.recordCandidate({ ...base, executionOutcome: 'PENDING' });
      expect((await current()).llmShadow).toEqual(row.llmShadow);
      expect((await store.select()).candidate).toBeNull();
    });

    it('rejects expired, truncated, OCR and incomplete observations without inference', async () => {
      for (const changes of [
        { source: 'OCR' as const },
        { sourceExcerptComplete: false },
        { text: 'я'.repeat(2501) },
        { analysisOutcome: 'TECHNICAL_INCOMPLETE' as const },
      ]) {
        await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
        await review.recordCandidate({ ...base, ...changes });
        expect((await store.select()).candidate).toBeNull();
      }
      const row = await current();
      await prisma.commercialReviewSample.update({
        where: { id: row.id },
        data: { expiresAt: new Date(0) },
      });
      expect((await store.select()).candidate).toBeNull();
      expect(classify).not.toHaveBeenCalled();
    });

    it('does not persist a source that expires or changes while inference is running', async () => {
      classify.mockImplementation(async () => {
        const row = await current();
        await prisma.commercialReviewSample.update({
          where: { id: row.id },
          data: { expiresAt: new Date(0) },
        });
        return result;
      });
      expect((await processor().run()).outcome).toBe('source_changed');
      expect((await current()).llmShadow).toBeNull();
      await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      await review.recordCandidate(base);
      const row = await current();
      const candidate = commercialLlmCandidate(row, new Date())!;
      await prisma.commercialReviewSample.update({
        where: { id: row.id },
        data: {
          qualityMetadata: {
            ...(row.qualityMetadata as Prisma.JsonObject),
            sourceSnapshotSha256: 'd'.repeat(64),
          },
        },
      });
      expect(await store.persist(candidate, { status: 'COMPLETE', ...result })).toBe(false);
    });

    it('serializes consumers and retains global cooldown across owner release', async () => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      classify.mockImplementation(async () => {
        entered();
        await pending;
        return result;
      });
      const first = processor().run();
      await started;
      expect((await processor().run()).outcome).toBe('not_admitted');
      finish();
      expect((await first).outcome).toBe('COMPLETE');
      expect(await lease.acquire()).toBeNull();
      expect(classify).toHaveBeenCalledTimes(1);
    });

    it('enforces the shorter global cooldown while preserving long inference ownership', async () => {
      const first = await lease.acquire();
      expect(first).not.toBeNull();
      const cooldown = await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY);
      expect(cooldown).toBeGreaterThan(COMMERCIAL_LLM_INTERVAL_MS - 1000);
      expect(cooldown).toBeLessThanOrEqual(COMMERCIAL_LLM_INTERVAL_MS);
      // FLAG: The test advances only its isolated cooldown; active inference still owns its lease.
      await redis.pexpire(COMMERCIAL_LLM_COOLDOWN_KEY, 1);
      await new Promise((done) => setTimeout(done, 20));
      expect(await lease.acquire()).toBeNull();
      await lease.release(first!);
      const next = await lease.acquire();
      expect(next).not.toBeNull();
      await lease.release(first!);
      expect(await lease.owns(next!)).toBe(true);
      await lease.release(next!);
      expect(await lease.acquire()).toBeNull();
    });

    it('fails closed on lost lease, pressure, shutdown and inference error', async () => {
      governor.decide.mockResolvedValueOnce({
        action: 'slow',
        retryAfterMs: 1000,
        reason: 'pressure',
      });
      expect((await processor().run()).outcome).toBe('pressure_paused');
      expect((await processor().run(AbortSignal.abort())).outcome).toBe('stopped');
      expect(classify).not.toHaveBeenCalled();
      classify.mockImplementation(async () => {
        await redis.set(COMMERCIAL_LLM_LEASE_KEY, 'different-owner', 'PX', 120_000);
        return result;
      });
      expect((await processor().run()).outcome).toBe('lease_lost');
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe('different-owner');
      expect((await current()).llmShadow).toBeNull();
      await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
      classify.mockRejectedValue(new Error('untrusted text must not be persisted'));
      expect((await processor().run()).outcome).toBe('TECHNICAL_FAILURE');
      const row = await current();
      expect(row.llmShadow).toMatchObject({ status: 'TECHNICAL_FAILURE', mode: 'SHADOW' });
      expect(JSON.stringify(row.llmShadow)).not.toContain('untrusted');
      expect((row.llmShadow as Prisma.JsonObject).classification).toBeUndefined();
    });

    it('bounds blocked writes with the dedicated optional pool timeout', async () => {
      const candidate = (await store.select()).candidate!;
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let unlock!: () => void;
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locker = prisma.$transaction(
        async (tx) => {
          await tx.commercialReviewSample.update({
            where: { id: candidate.id },
            data: { score: 0.1 },
          });
          locked();
          await release;
        },
        { timeout: 5000 },
      );
      await acquired;
      const startedAt = Date.now();
      try {
        await expect(store.persist(candidate, { status: 'COMPLETE', ...result })).rejects.toThrow();
        expect(Date.now() - startedAt).toBeLessThan(3500);
      } finally {
        unlock();
        await locker;
      }
      expect((await current()).llmShadow).toBeNull();
    });

    it('bounds admission to the indexed recent head even when older history is eligible', async () => {
      const row = await current();
      await prisma.commercialReviewSample.createMany({
        data: Array.from({ length: 5000 }, (_, i) => ({
          chatId,
          userId: base.userId,
          messageId: `retained-${i}`,
          source: 'TEXT',
          score: 0,
          evidenceHash: `${chatId}-retained-${i}`,
          evidence: {},
          observedAt: new Date(Date.now() - 86_400_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      });

      await prisma.commercialReviewSample.createMany({
        data: Array.from({ length: 80 }, (_, i) => ({
          chatId,
          userId: base.userId,
          messageId: `recent-${i}`,
          source: 'OCR',
          score: 0,
          evidenceHash: `${chatId}-recent-${i}`,
          evidence: {},
          observedAt: new Date(Date.now() + i),
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      });
      const selection = await store.select(new Date(Date.now() + 1000));
      expect(selection).toEqual({
        candidate: null,
        scanned: COMMERCIAL_LLM_SCAN_LIMIT,
        ineligible: COMMERCIAL_LLM_SCAN_LIMIT,
        pageCapped: true,
      });
      const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (COSTS OFF) SELECT id FROM commercial_review_samples
       WHERE observed_at >= $1 AND observed_at <= $2 ORDER BY observed_at DESC,id DESC LIMIT 64`,
        new Date(Date.now() - 900_000),
        new Date(Date.now() + 1000),
      );
      expect(plan.map((x) => x['QUERY PLAN']).join('\n')).toContain(
        'commercial_review_samples_blind_queue_idx',
      );
      expect(
        (await prisma.commercialReviewSample.findUniqueOrThrow({ where: { id: row.id } }))
          .llmShadow,
      ).toBeNull();
    });
  },
);
