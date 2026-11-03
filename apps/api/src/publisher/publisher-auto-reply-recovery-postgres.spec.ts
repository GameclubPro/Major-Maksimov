import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPrismaAdapter,
  Prisma,
  PrismaClient,
  PublisherAutoReplyAssetUploadStatus,
  PublisherAutoReplyDeliveryStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildPublisherAutoReplyJobId,
  PublisherAutoReplyQueueService,
  type PublisherAutoReplyJob,
} from './publisher-auto-reply.queue';
import { PublisherAutoReplyRecoveryService } from './publisher-auto-reply-recovery.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import type { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import type { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import type { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  buildPublisherRuntimeHeartbeatKey,
  PublisherRuntimeHeartbeatReaderService,
  type PublisherRuntimeHeartbeatSnapshot,
} from './publisher-runtime-heartbeat.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;
const batchSize = 100;
const createClient = () =>
  new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 3_000 }),
    log: [{ emit: 'event', level: 'query' }],
  });

jest.setTimeout(30_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function planNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (typeof value !== 'object' || value === null) return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(planNodes),
  ];
}

function requireBoundedPlan(condition: boolean, invariant: string, evidence: unknown): void {
  if (!condition) {
    throw new Error(`${invariant}\nNative PostgreSQL plan:\n${JSON.stringify(evidence, null, 2)}`);
  }
}

function examinedRows(node: Record<string, unknown>): number {
  return (
    (Number(node['Actual Rows']) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)) *
    Number(node['Actual Loops'])
  );
}

integration('Publisher auto-reply bounded recovery on PostgreSQL and Redis', () => {
  let db: ReturnType<typeof createClient>;
  let redis: Redis;
  let queue: Queue<PublisherAutoReplyJob>;
  let queueService: PublisherAutoReplyQueueService;
  let heartbeat: PublisherRuntimeHeartbeatReaderService;
  let backgroundWork: PublisherBackgroundWorkCoordinatorService;
  let recovery: PublisherAutoReplyRecoveryService;
  let chatId: string;
  let botId: string;
  let ruleId: string;
  let contentRevisionId: string;
  let now: Date;
  let originalRole: string | undefined;
  const queries: Prisma.QueryEvent[] = [];
  const ownedAdmissionIds = new Set<string>();

  beforeAll(async () => {
    const pgUrl = new URL(databaseUrl);
    const queueUrl = new URL(redisUrl);
    const local = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!local(pgUrl) || !pgUrl.pathname.includes('race_test') || !local(queueUrl)) {
      throw new Error('Disposable local race_test PostgreSQL and Redis required');
    }
    db = createClient();
    db.$on('query', (event) => queries.push(event));
    await db.$connect();
    expect(await db.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`).toEqual([
      { TimeZone: 'UTC' },
    ]);
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 3_000 });
    await redis.ping();
  });

  beforeEach(async () => {
    originalRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'publisher';
    now = new Date();
    chatId = `auto-reply-recovery-chat-${randomUUID()}`;
    botId = `auto-reply-recovery-bot-${randomUUID()}`;
    queries.length = 0;
    ownedAdmissionIds.clear();
    await db.chat.create({ data: { id: chatId, title: 'Synthetic auto-reply recovery' } });
    const rule = await db.publisherAutoReplyRule.create({
      data: {
        chatId,
        phrase: 'прайс',
        normalizedPhrase: 'прайс',
        createdByUserId: 'synthetic-admin',
        updatedByUserId: 'synthetic-admin',
        contentRevisions: {
          create: { revision: 1, text: 'Synthetic reply', createdByUserId: 'synthetic-admin' },
        },
      },
      include: { contentRevisions: true },
    });
    ruleId = rule.id;
    contentRevisionId = rule.contentRevisions[0]!.id;
    await db.publisherAutoReplyRule.update({
      where: { id: ruleId },
      data: { currentContentRevisionId: contentRevisionId },
    });
    queue = new Queue<PublisherAutoReplyJob>(`{maxim-auto-reply-recovery-${randomUUID()}}`, {
      connection: { url: redisUrl },
      prefix: 'maxim-test',
    });
    await queue.waitUntilReady();
    const config = new ConfigService({
      MAX_PUBLISHER_BOT_ID: botId,
      PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT: 1_000,
      REDIS_URL: redisUrl,
    });
    heartbeat = new PublisherRuntimeHeartbeatReaderService(config);
    queueService = new PublisherAutoReplyQueueService(queue, config, heartbeat);
    const enabled = {
      version: 1,
      botId,
      dispatchEnabled: true,
      blocker: null,
      observedAt: new Date().toISOString(),
      instanceId: `synthetic-${randomUUID()}`,
    } satisfies PublisherRuntimeHeartbeatSnapshot;
    await redis.set(buildPublisherRuntimeHeartbeatKey(botId), JSON.stringify(enabled), 'EX', 45);
    backgroundWork = new PublisherBackgroundWorkCoordinatorService();
    const runtime = { dispatchEnabled: true } satisfies Pick<
      PublisherRuntimeBoundaryService,
      'dispatchEnabled'
    >;
    const health = {
      isGloballyPaused: async () => false,
    } satisfies Pick<PublisherDispatchHealthService, 'isGloballyPaused'>;
    const attestation = {
      assertAttested: async () => undefined,
    } satisfies Pick<PublisherIdentityAttestationService, 'assertAttested'>;
    recovery = new PublisherAutoReplyRecoveryService(
      db as unknown as PrismaService,
      queueService,
      runtime as PublisherRuntimeBoundaryService,
      health as PublisherDispatchHealthService,
      attestation as PublisherIdentityAttestationService,
      backgroundWork,
    );
  });

  afterEach(async () => {
    recovery?.onModuleDestroy();
    backgroundWork?.onModuleDestroy();
    heartbeat?.onModuleDestroy();
    const cleanup = await Promise.allSettled([
      (async () => {
        try {
          await queueService?.onModuleDestroy();
          if (queue) {
            await queue.obliterate({ force: true });
            // FLAG: BullMQ does not own these admission keys. Derive only this fixture's
            // exact operation keys; never scan or clear the shared Redis database.
            const admissionKeys = [...ownedAdmissionIds].map((id) => {
              const operationId = createHash('sha256')
                .update(buildPublisherAutoReplyJobId(id))
                .digest('hex')
                .slice(0, 32);
              return queue.toKey(`auto-reply-backlog-attempts:${operationId}`);
            });
            await redis.del(queue.toKey('auto-reply-backlog-inflight'), ...admissionKeys);
          }
        } finally {
          try {
            if (botId) await redis.del(buildPublisherRuntimeHeartbeatKey(botId));
          } finally {
            await queue?.close();
          }
        }
      })(),
      (async () => {
        if (!db || !chatId) return;
        await db.publisherAutoReplyDelivery.deleteMany({ where: { chatId } });
        await db.publisherAutoReplyRule.updateMany({
          where: { chatId },
          data: { currentContentRevisionId: null },
        });
        await db.publisherAutoReplyRule.deleteMany({ where: { chatId } });
        await db.publisherAutoReplyAsset.deleteMany({ where: { chatId } });
        await db.chat.deleteMany({ where: { id: chatId } });
      })(),
    ]);
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'Recovery fixture cleanup failed');
  });

  afterAll(async () => {
    const closed = await Promise.allSettled([db?.$disconnect(), redis?.quit()]);
    const failures = closed.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'Recovery store cleanup failed');
  });

  async function seedDeliveries(
    count: number,
    label: string,
    options: { dueAt?: Date; status?: PublisherAutoReplyDeliveryStatus; lockedAt?: Date } = {},
  ): Promise<string[]> {
    const ids = Array.from(
      { length: count },
      (_, index) => `${chatId}-${label}-${String(index).padStart(5, '0')}`,
    );
    if (
      options.status === PublisherAutoReplyDeliveryStatus.SENDING ||
      ((!options.status || options.status === PublisherAutoReplyDeliveryStatus.PENDING) &&
        (!options.dueAt || options.dueAt <= now))
    ) {
      for (const id of ids) ownedAdmissionIds.add(id);
    }
    for (let offset = 0; offset < ids.length; offset += 500) {
      await db.publisherAutoReplyDelivery.createMany({
        data: ids.slice(offset, offset + 500).map((id) => ({
          id,
          chatId,
          ruleId,
          contentRevisionId,
          publisherBotId: botId,
          sourceMessageId: id,
          matchedRuleVersion: 1,
          matchedNormalizedPhrase: 'прайс',
          autoReplyConfigRevision: 1,
          publisherSettingsRevision: 1,
          publicationPolicyRevision: 1,
          dueAt: options.dueAt ?? new Date(now.getTime() - 1_000),
          status: options.status ?? PublisherAutoReplyDeliveryStatus.PENDING,
          ...(options.status === PublisherAutoReplyDeliveryStatus.SENDING
            ? {
                lockedAt: options.lockedAt ?? new Date(now.getTime() - 5 * 60_000),
                lockToken: `old-${id}`,
              }
            : {}),
          ...(options.status === PublisherAutoReplyDeliveryStatus.SENT
            ? { remoteMessageId: `synthetic-sent-${id}` }
            : {}),
        })),
      });
    }
    return ids;
  }

  async function delayedJobs(ids: string[]): Promise<void> {
    await queue.addBulk(
      ids.map((deliveryId) => ({
        name: 'deliver',
        data: {
          version: 1 as const,
          kind: 'deliver' as const,
          retryPolicyName: 'publisher-auto-reply' as const,
          deliveryId,
        },
        opts: { jobId: buildPublisherAutoReplyJobId(deliveryId), delay: 5 * 60_000 },
      })),
    );
  }

  async function recoverUntilJob(deliveryId: string, maxPasses = 6) {
    const results: Awaited<ReturnType<PublisherAutoReplyRecoveryService['recoverOnce']>>[] = [];
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await recovery.recoverOnce(now);
      expect(result.scanned).toBeLessThanOrEqual(batchSize);
      expect(result.errors).toBe(0);
      results.push(result);
      if (await queue.getJob(buildPublisherAutoReplyJobId(deliveryId))) return results;
    }
    throw new Error(`Missing delivery job after ${maxPasses} bounded recovery passes`);
  }

  async function seedUploads(
    count: number,
    label: string,
    options: {
      status?: PublisherAutoReplyAssetUploadStatus;
      lockedAt?: Date;
      updatedAt?: Date;
    } = {},
  ): Promise<string[]> {
    const ids = Array.from(
      { length: count },
      (_, index) => `${chatId}-${label}-${String(index).padStart(5, '0')}`,
    );
    const status = options.status ?? PublisherAutoReplyAssetUploadStatus.UPLOADING;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const slice = ids.slice(offset, offset + 500);
      await db.publisherAutoReplyAsset.createMany({
        data: slice.map((id) => {
          const bytes = Buffer.from(id);
          return {
            id: `${id}-asset`,
            chatId,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            mimeType: 'image/png',
            sizeBytes: bytes.length,
            bytes,
            createdByUserId: 'synthetic-admin',
          };
        }),
      });
      await db.publisherAutoReplyAssetUpload.createMany({
        data: slice.map((id) => ({
          id,
          assetId: `${id}-asset`,
          publisherBotId: botId,
          status,
          attemptCount: 3,
          ...(status === PublisherAutoReplyAssetUploadStatus.UPLOADING
            ? {
                lockedAt: options.lockedAt ?? new Date(now.getTime() - 5 * 60_000),
                lockToken: `old-${id}`,
              }
            : {}),
          ...(status === PublisherAutoReplyAssetUploadStatus.READY
            ? { payload: { token: `synthetic-${id}` }, expiresAt: new Date(now.getTime() + 60_000) }
            : {}),
          updatedAt: options.updatedAt ?? new Date(now.getTime() - 5 * 60_000),
        })),
      });
    }
    return ids;
  }

  async function withUploadLocks(
    ids: string[],
    operation: () => Promise<void>,
    change?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const locked = gate();
    const release = gate();
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM publisher_auto_reply_asset_uploads
          WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
        `);
        await change?.(tx);
        locked.resolve();
        await release.promise;
      },
      { timeout: 20_000 },
    );
    try {
      await Promise.race([
        locked.promise,
        holder.then(() => {
          throw new Error('Upload lock holder completed before reaching its gate');
        }),
      ]);
      await operation();
    } finally {
      release.resolve();
      await holder;
    }
  }

  async function assertDeliverySelectionPlans(selections: Prisma.QueryEvent[]): Promise<void> {
    for (const selection of selections) {
      const values = JSON.parse(selection.params) as unknown[];
      const plainEvidence = await db.$queryRawUnsafe(
        `EXPLAIN (FORMAT JSON) ${selection.query}`,
        ...values,
      );
      const plain = planNodes(plainEvidence);
      requireBoundedPlan(
        !plain.some(
          (node) =>
            node['Relation Name'] === 'publisher_auto_reply_deliveries' &&
            node['Node Type'] === 'Seq Scan',
        ),
        'Initial and cursor delivery pages must avoid scanning the active backlog',
        plainEvidence,
      );
      const actualEvidence = await db.$queryRawUnsafe(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${selection.query}`,
        ...values,
      );
      const actual = planNodes(actualEvidence);
      const reads = actual.filter(
        (node) => node['Relation Name'] === 'publisher_auto_reply_deliveries',
      );
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        requireBoundedPlan(
          examinedRows(read) <= 250 &&
            Number(read['Shared Hit Blocks'] ?? 0) + Number(read['Shared Read Blocks'] ?? 0) <= 512,
          'Initial and cursor delivery pages must bound examined tuples and buffers',
          actualEvidence,
        );
      }
      for (const sort of actual.filter((node) => String(node['Node Type']).includes('Sort'))) {
        const inputs = planNodes(sort.Plans).filter(
          (node) => node['Parent Relationship'] === 'Outer',
        );
        expect(inputs.length).toBeGreaterThan(0);
        for (const input of inputs) {
          requireBoundedPlan(
            Number(input['Actual Rows']) * Number(input['Actual Loops']) <= 250,
            'Delivery sorting must receive only a bounded input, not the entire due backlog',
            actualEvidence,
          );
        }
      }
    }
  }

  it('advances past 100 delayed jobs with tied due dates and finds an earlier insert after wrap', async () => {
    const ids = await seedDeliveries(101, 'tied');
    await delayedJobs(ids.slice(0, batchSize));
    const tail = ids[100]!;
    const passes = await recoverUntilJob(tail);
    expect(passes[0]).toMatchObject({ addAcknowledged: 0, reset: 0, ambiguous: 0 });
    expect(passes.reduce((total, result) => total + result.scanned, 0)).toBe(101);
    for (const [index, result] of passes.entries()) {
      const addAcknowledged = index === passes.length - 1 ? 1 : 0;
      expect(result).toMatchObject({
        alreadyLive: result.scanned - addAcknowledged,
        addAcknowledged,
      });
    }
    expect(await queue.getJobCounts('delayed', 'prioritized', 'waiting')).toMatchObject({
      delayed: 100,
      prioritized: 1,
      waiting: 0,
    });
    const inserted = await seedDeliveries(1, 'earlier', {
      dueAt: new Date(now.getTime() - 10_000),
    });
    const wrapped = await recoverUntilJob(inserted[0]!);
    expect(wrapped.some((result) => result.scanned > 0)).toBe(true);
    const rows = await db.publisherAutoReplyDelivery.findMany({ where: { chatId } });
    expect(rows).toHaveLength(102);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        dispatchStartedAt: null,
        remoteMessageId: null,
        lockToken: null,
      });
    }
  });

  it('wraps an exhausted full page and can recover a newly inserted earlier delivery', async () => {
    const ids = await seedDeliveries(100, 'full');
    await delayedJobs(ids);
    let scanned = 0;
    for (let pass = 0; pass < 6 && scanned < ids.length; pass += 1) {
      const result = await recovery.recoverOnce(now);
      expect(result.scanned).toBeLessThanOrEqual(batchSize);
      expect(result).toMatchObject({ addAcknowledged: 0, errors: 0 });
      scanned += result.scanned;
    }
    expect(scanned).toBe(100);
    await db.publisherAutoReplyDelivery.updateMany({
      where: { chatId },
      data: { status: PublisherAutoReplyDeliveryStatus.CANCELED },
    });
    await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ scanned: 0 });
    const inserted = await seedDeliveries(1, 'before-full-page', {
      dueAt: new Date(now.getTime() - 30_000),
    });
    await recoverUntilJob(inserted[0]!);
  });

  it('resets only 100 stale uploads per pass and preserves fresh leases and READY payloads', async () => {
    const stale = await seedUploads(101, 'stale');
    const fresh = await seedUploads(1, 'fresh', { lockedAt: now });
    const ready = await seedUploads(1, 'ready', {
      status: PublisherAutoReplyAssetUploadStatus.READY,
    });
    const protectedBefore = await db.publisherAutoReplyAssetUpload.findMany({
      where: { id: { in: [...fresh, ...ready] } },
      orderBy: { id: 'asc' },
    });
    await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 100 });
    expect(
      await db.publisherAutoReplyAssetUpload.count({
        where: { id: { in: stale }, status: PublisherAutoReplyAssetUploadStatus.UPLOADING },
      }),
    ).toBe(1);
    await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 1 });
    await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 0 });
    const reset = await db.publisherAutoReplyAssetUpload.findMany({ where: { id: { in: stale } } });
    for (const row of reset) {
      expect(row).toMatchObject({
        publisherBotId: botId,
        status: 'PENDING',
        attemptCount: 3,
        lockedAt: null,
        lockToken: null,
        failureCode: 'STALE_UPLOAD_LEASE',
      });
    }
    expect(
      await db.publisherAutoReplyAssetUpload.findMany({
        where: { id: { in: [...fresh, ...ready] } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(protectedBefore);
  });

  it('retains the migrated database guard against an UPLOADING row without a lease', async () => {
    const [id] = await seedUploads(1, 'null-lease');
    await expect(
      db.publisherAutoReplyAssetUpload.update({
        where: { id },
        data: { lockedAt: null },
      }),
    ).rejects.toThrow(/publisher_auto_reply_asset_uploads_lock_check/u);
    expect(
      await db.publisherAutoReplyAssetUpload.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'UPLOADING',
      lockedAt: new Date(now.getTime() - 5 * 60_000),
      lockToken: `old-${id}`,
    });
  });

  it('skips rows being renewed or completed and preserves the committed new owner and READY result', async () => {
    const [renewed, completed, free] = await seedUploads(3, 'race');
    const payload = { token: 'synthetic-concurrent-upload-result' };
    await withUploadLocks(
      [renewed!, completed!],
      async () => {
        await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 1 });
        expect(
          await db.publisherAutoReplyAssetUpload.findUniqueOrThrow({ where: { id: free } }),
        ).toMatchObject({ status: 'PENDING' });
      },
      async (tx) => {
        await tx.publisherAutoReplyAssetUpload.update({
          where: { id: renewed },
          data: { lockedAt: now, lockToken: 'synthetic-new-owner', attemptCount: 4 },
        });
        await tx.publisherAutoReplyAssetUpload.update({
          where: { id: completed },
          data: { status: 'READY', payload, lockedAt: null, lockToken: null },
        });
      },
    );
    await expect(recovery.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 0 });
    expect(
      await db.publisherAutoReplyAssetUpload.findUniqueOrThrow({ where: { id: renewed } }),
    ).toMatchObject({
      status: 'UPLOADING',
      lockedAt: now,
      lockToken: 'synthetic-new-owner',
      attemptCount: 4,
    });
    expect(
      await db.publisherAutoReplyAssetUpload.findUniqueOrThrow({ where: { id: completed } }),
    ).toMatchObject({ status: 'READY', payload, attemptCount: 3, publisherBotId: botId });
  });

  it('advances beyond 100 locked uploads with tied lease timestamps to recover the unlocked tail', async () => {
    const ids = await seedUploads(101, 'locked-tie');
    const tail = ids[100]!;
    await withUploadLocks(ids.slice(0, 100), async () => {
      let recovered = false;
      for (let pass = 0; pass < 4 && !recovered; pass += 1) {
        const result = await recovery.recoverOnce(now);
        expect(result.uploadsReset).toBeLessThanOrEqual(100);
        recovered =
          (await db.publisherAutoReplyAssetUpload.findUniqueOrThrow({ where: { id: tail } }))
            .status === PublisherAutoReplyAssetUploadStatus.PENDING;
      }
      expect(recovered).toBe(true);
      expect(
        await db.publisherAutoReplyAssetUpload.count({
          where: {
            id: { in: ids.slice(0, 100) },
            status: PublisherAutoReplyAssetUploadStatus.UPLOADING,
          },
        }),
      ).toBe(100);
    });
    let remaining = 100;
    for (let pass = 0; pass < 4 && remaining; pass += 1) {
      const result = await recovery.recoverOnce(now);
      expect(result.uploadsReset).toBeLessThanOrEqual(100);
      remaining = await db.publisherAutoReplyAssetUpload.count({
        where: { id: { in: ids }, status: PublisherAutoReplyAssetUploadStatus.UPLOADING },
      });
    }
    expect(remaining).toBe(0);
  });

  it('bounds indexed selection and UPDATE target probes with retained history and future-lease skew', async () => {
    await seedDeliveries(6_000, 'retained', { status: PublisherAutoReplyDeliveryStatus.SENT });
    await seedDeliveries(3_000, 'future', { dueAt: new Date(now.getTime() + 60_000) });
    const due = await seedDeliveries(101, 'due');
    await delayedJobs(due.slice(0, 100));
    await seedUploads(6_000, 'retained-upload', {
      status: PublisherAutoReplyAssetUploadStatus.READY,
    });
    await seedUploads(3_000, 'future-upload', { lockedAt: new Date(now.getTime() + 60_000) });
    const stale = await seedUploads(3_001, 'plan-stale');
    await db.$executeRawUnsafe('ANALYZE publisher_auto_reply_deliveries');
    await db.$executeRawUnsafe('ANALYZE publisher_auto_reply_asset_uploads');
    queries.length = 0;
    await recovery.recoverOnce(now);
    const observed = [...queries];
    const deliveryQuery = observed.find(
      (event) =>
        /^(?:SELECT|WITH)\b/iu.test(event.query.trim()) &&
        event.query.includes('publisher_auto_reply_deliveries') &&
        event.query.includes('ORDER BY') &&
        !event.query.includes('UPDATE'),
    );
    const uploadQuery = observed.find(
      (event) =>
        event.query.includes('UPDATE') &&
        event.query.includes('publisher_auto_reply_asset_uploads'),
    );
    expect(deliveryQuery).toBeDefined();
    expect(uploadQuery).toBeDefined();

    const explain = async (event: Prisma.QueryEvent, analyze = false) =>
      db.$queryRawUnsafe(
        `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, TIMING OFF, ' : ''}FORMAT JSON) ${event.query}`,
        ...(JSON.parse(event.params) as unknown[]),
      );
    const deliveryPlainEvidence = await explain(deliveryQuery!);
    const uploadPlainEvidence = await explain(uploadQuery!);
    const plainEvidence = { delivery: deliveryPlainEvidence, upload: uploadPlainEvidence };
    const deliveryPlain = planNodes(deliveryPlainEvidence);
    requireBoundedPlan(
      !deliveryPlain.some(
        (node) =>
          node['Relation Name'] === 'publisher_auto_reply_deliveries' &&
          node['Node Type'] === 'Seq Scan',
      ),
      'Retained-history delivery selection must avoid scanning the whole relation',
      plainEvidence,
    );
    const uploadPlain = planNodes(uploadPlainEvidence);
    const uploadScans = uploadPlain.filter(
      (node) =>
        node['Relation Name'] === 'publisher_auto_reply_asset_uploads' &&
        node['Node Type'] !== 'ModifyTable',
    );
    expect(uploadScans.length).toBeGreaterThanOrEqual(2);
    requireBoundedPlan(
      uploadScans.every((node) => /^Index (Only )?Scan$/u.test(String(node['Node Type']))),
      'Upload candidate selection and UPDATE targets must use bounded indexed access',
      plainEvidence,
    );
    expect(
      uploadScans.some((node) => node['Index Name'] === 'publisher_auto_reply_asset_uploads_pkey'),
    ).toBe(true);
    expect(
      uploadPlain.some((node) => node['Node Type'] === 'Limit' && Number(node['Plan Rows']) <= 100),
    ).toBe(true);

    // FLAG: Plain plans are inspected first. ANALYZE executes only the captured query
    // against this disposable fixture, never against production or a MAX worker.
    await db.publisherAutoReplyAssetUpload.updateMany({
      where: { id: { in: stale } },
      data: {
        status: PublisherAutoReplyAssetUploadStatus.UPLOADING,
        lockedAt: new Date(now.getTime() - 5 * 60_000),
        lockToken: 'synthetic-plan-observed-lease',
        updatedAt: new Date(now.getTime() - 5 * 60_000),
      },
    });
    const actualUploadEvidence = await explain(uploadQuery!, true);
    const actualDeliveryEvidence = await explain(deliveryQuery!, true);
    const actualEvidence = { delivery: actualDeliveryEvidence, upload: actualUploadEvidence };
    const actualUploads = planNodes(actualUploadEvidence);
    const actualDeliveries = planNodes(actualDeliveryEvidence);
    for (const [relation, nodes] of [
      ['publisher_auto_reply_asset_uploads', actualUploads],
      ['publisher_auto_reply_deliveries', actualDeliveries],
    ] as const) {
      const scans = nodes.filter(
        (node) => node['Relation Name'] === relation && node['Node Type'] !== 'ModifyTable',
      );
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        requireBoundedPlan(
          examinedRows(scan) <= 250,
          `${relation} must examine at most 250 tuples per bounded recovery query`,
          actualEvidence,
        );
      }
    }
    const primaryKeyProbes = actualUploads.filter(
      (node) => node['Index Name'] === 'publisher_auto_reply_asset_uploads_pkey',
    );
    expect(primaryKeyProbes.length).toBeGreaterThan(0);
    for (const probe of primaryKeyProbes) {
      requireBoundedPlan(
        examinedRows(probe) <= 100 && Number(probe['Actual Loops']) <= 100,
        'Upload primary-key probes must stay within the 100-row batch, including array probes',
        actualEvidence,
      );
    }
    expect(
      await db.publisherAutoReplyAssetUpload.count({
        where: { id: { in: stale }, status: PublisherAutoReplyAssetUploadStatus.PENDING },
      }),
    ).toBe(100);
  });

  it('bounds both initial and cursor delivery reads across a large due backlog with timestamp ties', async () => {
    await seedDeliveries(6_000, 'active-plan-history', {
      status: PublisherAutoReplyDeliveryStatus.SENT,
    });
    await seedDeliveries(1_000, 'active-plan-future', {
      dueAt: new Date(now.getTime() + 60_000),
    });
    const due = await seedDeliveries(5_000, 'active-plan-due');
    await delayedJobs(due.slice(0, 100));
    await db.$executeRawUnsafe('ANALYZE publisher_auto_reply_deliveries');
    queries.length = 0;
    const first = await recovery.recoverOnce(now);
    expect(first.scanned).toBeGreaterThan(0);
    expect(first.scanned).toBeLessThanOrEqual(100);
    const second = await recovery.recoverOnce(now);
    expect(second.scanned).toBeGreaterThan(0);
    expect(second.scanned).toBeLessThanOrEqual(100);
    const selections = [...queries].filter(
      (event) =>
        /^(?:SELECT|WITH)\b/iu.test(event.query.trim()) &&
        event.query.includes('publisher_auto_reply_deliveries') &&
        event.query.includes('ORDER BY') &&
        !event.query.includes('UPDATE'),
    );
    const pendingSelections = selections.filter(
      (event) => event.query.includes("'PENDING'") || event.params.includes('"PENDING"'),
    );
    expect(pendingSelections).toHaveLength(2);
    expect(pendingSelections[1]!.params).toContain(due[first.scanned - 1]!);

    await assertDeliverySelectionPlans(selections);
  });

  it('rotates to tied stale SENDING leases while pending work stays live and fresh leases stay intact', async () => {
    const pending = await seedDeliveries(1_000, 'family-pending');
    await delayedJobs(pending.slice(0, 100));
    const sending = await seedDeliveries(3_000, 'family-sending', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      dueAt: new Date(now.getTime() + 60_000),
    });
    const fresh = await seedDeliveries(1_000, 'family-fresh', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      lockedAt: now,
    });
    const freshBefore = await db.publisherAutoReplyDelivery.findMany({
      where: { id: { in: fresh } },
      orderBy: { id: 'asc' },
    });
    await db.$executeRawUnsafe('ANALYZE publisher_auto_reply_deliveries');
    queries.length = 0;
    let reset = 0;
    let sendingPasses = 0;
    let firstSendingReset = 0;
    for (let pass = 0; pass < 8 && sendingPasses < 2; pass += 1) {
      const result = await recovery.recoverOnce(now);
      expect(result.errors).toBe(0);
      expect(result.scanned).toBeLessThanOrEqual(100);
      if (result.reset > 0) {
        sendingPasses += 1;
        firstSendingReset ||= result.reset;
      }
      reset += result.reset;
    }
    expect(sendingPasses).toBe(2);
    expect(reset).toBeGreaterThan(firstSendingReset);
    const selections = [...queries].filter(
      (event) =>
        /^(?:SELECT|WITH)\b/iu.test(event.query.trim()) &&
        event.query.includes('publisher_auto_reply_deliveries') &&
        event.query.includes('ORDER BY') &&
        !event.query.includes('UPDATE'),
    );
    const sendingSelections = selections.filter(
      (event) => event.query.includes("'SENDING'") && event.query.includes('locked_at <='),
    );
    expect(sendingSelections.length).toBeGreaterThanOrEqual(2);
    expect(sendingSelections[1]!.params).toContain(sending[firstSendingReset - 1]!);
    const restored = await db.publisherAutoReplyDelivery.findMany({
      where: { id: { in: sending }, status: PublisherAutoReplyDeliveryStatus.PENDING },
      orderBy: { id: 'asc' },
    });
    expect(restored).toHaveLength(reset);
    expect(await queue.getJob(buildPublisherAutoReplyJobId(restored[0]!.id))).toBeDefined();
    expect(await queue.getJob(buildPublisherAutoReplyJobId(restored.at(-1)!.id))).toBeDefined();
    for (const row of restored) {
      expect(row).toMatchObject({
        attemptCount: 0,
        dueAt: new Date(now.getTime() + 60_000),
        lockedAt: null,
        lockToken: null,
        dispatchStartedAt: null,
        remoteMessageId: null,
        failureCode: 'STALE_PREPARATION_LEASE',
      });
    }
    expect(
      await db.publisherAutoReplyDelivery.findMany({
        where: { id: { in: fresh } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(freshBefore);
    await assertDeliverySelectionPlans(selections);
  });
});
