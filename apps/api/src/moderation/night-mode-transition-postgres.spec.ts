import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { NightModeTransitionReconcileService } from './night-mode-transition-reconcile.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import { RedisCounterService } from './redis-counter.service';
import { isNightModeTransitionMembershipCandidate } from './night-mode-transition-eligibility.util';
import {
  buildNightModeTransitionScheduleFingerprint,
  buildNightModeTransitionSideEffectFingerprint,
} from './night-mode-transition-generation.util';
import { NightModeTransitionRuntimeService } from './night-mode-transition-runtime.service';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import type { MaxClientService } from '../max/max-client.service';
import { BotSpeechMediaService } from './bot-speech-media.service';
import {
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
  type NightModeTransitionJob,
  type NightModeTransitionOpenEventRecovery,
} from './night-mode-transition.queue';
import {
  resolveNextNightModeTransitionOccurrences,
  resolveCurrentNightModeOpenOccurrence,
} from './night-mode-transition-time.util';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ModerationExecutionService,
  type ModerationExecutionLegacy,
} from './moderation-execution.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

describePostgres('PostgreSQL night mode transition recovery SQL', () => {
  let prisma: PrismaClient;
  const createdRequestChatIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
  });

  afterEach(async () => {
    if (createdRequestChatIds.length > 0) {
      await prisma.nightModeTransitionReconcileRequest.deleteMany({
        where: { chatId: { in: createdRequestChatIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('acquires an advisory transaction lock without deserializing its void result', async () => {
    await expect(
      prisma.$transaction((tx) =>
        tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${'night-mode-event-race-test'}, 0::BIGINT))
        `),
      ),
    ).resolves.toEqual(expect.any(Number));
  });

  it('executes the void durable-reconcile function without decoding a result column', async () => {
    const chatId = `night-mode-void-${randomUUID()}`;
    createdRequestChatIds.push(chatId);

    await expect(
      prisma.$executeRaw(Prisma.sql`
        SELECT enqueue_night_mode_transition_reconcile_request(${chatId})
      `),
    ).resolves.toEqual(expect.any(Number));
    await expect(
      prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).resolves.toMatchObject({ chatId, generation: 1n });
  });

  it('renews bigint generation leases through an explicitly typed VALUES relation', async () => {
    const chatId = `night-mode-lease-${randomUUID()}`;
    const leaseToken = randomUUID();
    const initialLeaseExpiresAt = new Date(Date.now() + 15_000);
    createdRequestChatIds.push(chatId);
    await prisma.nightModeTransitionReconcileRequest.create({
      data: {
        chatId,
        generation: 7n,
        leaseToken,
        leaseExpiresAt: initialLeaseExpiresAt,
      },
    });
    const service = new NightModeTransitionReconcileService(prisma as never, {} as never);

    await expect(
      (
        service as unknown as {
          renewBatchLeases(
            requests: Array<{ chat_id: string; generation: bigint }>,
            token: string,
          ): Promise<void>;
        }
      ).renewBatchLeases([{ chat_id: chatId, generation: 7n }], leaseToken),
    ).resolves.toBeUndefined();

    const renewed = await prisma.nightModeTransitionReconcileRequest.findUniqueOrThrow({
      where: { chatId },
      select: { leaseExpiresAt: true },
    });
    expect(renewed.leaseExpiresAt?.getTime()).toBeGreaterThan(initialLeaseExpiresAt.getTime());
  });
});

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl);
const describeNative = databaseUrl && localRedis ? describe : describe.skip;

describeNative('night mode durable handoffs with PostgreSQL and BullMQ', () => {
  let prisma: PrismaClient;
  const connection = { url: redisUrl, maxRetriesPerRequest: null } satisfies ConnectionOptions;
  let redis: RedisCounterService;
  let queue: Queue<NightModeTransitionJob>;
  let worker: Worker<NightModeTransitionJob> | undefined;
  let chatId: string;
  const backlogChatIds: string[] = [];
  const settings = {
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'UTC',
  };
  const permissions = {
    isAdmin: true,
    isOwner: false,
    permissionsKnown: true,
    permissions: ['write', 'read_all_messages'],
  };
  const createScheduler = () =>
    new NightModeTransitionSchedulerService(
      prisma as unknown as PrismaService,
      queue,
      undefined,
      undefined,
      redis,
    );

  beforeEach(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 4 });
    await prisma.$connect();
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl }));
    chatId = `night-native-${randomUUID()}`;
    queue = new Queue<NightModeTransitionJob>(chatId, { connection });
    await prisma.chat.create({
      data: {
        id: chatId,
        title: 'isolated night-mode handoff',
        routingState: 'READY',
        settings: {
          create: {
            ...settings,
            nightModeBotMessageEnabled: true,
            nightModeOpenMessageEnabled: true,
          },
        },
        botMemberships: {
          create: {
            botId: 'native-bot',
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessExpiresAt: new Date(Date.now() + 600_000),
            permissionsSnapshot: permissions,
          },
        },
      },
    });
    await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    // The queue name is a per-test UUID on the wrapper's disposable loopback Redis.
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.onModuleDestroy();
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId } });
    await prisma.nightModeTransitionScheduledJob.deleteMany({ where: { chatId } });
    await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
    await prisma.nightModeTransitionReconcileRequest.deleteMany({
      where: { chatId: { in: backlogChatIds.splice(0) } },
    });
    await prisma.$disconnect();
  });

  it.each([false, true])(
    'retains the next cycle after both stale jobs complete (crash=%s)',
    async (crash) => {
      const now = new Date();
      const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
      // Keep this fixture open and outside the two-hour OPEN catch-up window at any CI hour.
      const openPhaseSettings = {
        ...settings,
        nightModeStartTimeMinutes: (minute + 4 * 60) % 1440,
        nightModeEndTimeMinutes: (minute + 20 * 60) % 1440,
      };
      await prisma.chatSettings.update({ where: { chatId }, data: openPhaseSettings });
      await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
      const before = new Date(now);
      before.setUTCDate(before.getUTCDate() - 2);
      before.setUTCHours(12, 0, 0, 0);
      const fingerprint = buildNightModeTransitionScheduleFingerprint(openPhaseSettings);
      const jobs = resolveNextNightModeTransitionOccurrences(openPhaseSettings, before).map(
        (occurrence) => ({
          chatId,
          transition: occurrence.transition,
          scheduledFor: occurrence.dueAt.toISOString(),
          sessionKey: occurrence.sessionKey,
          scheduleFingerprint: fingerprint,
          transitionRuntimeVersion: 4 as const,
        }),
      );
      await prisma.nightModeTransitionScheduledJob.createMany({
        data: jobs.map((job) => ({
          chatId,
          jobId: buildNightModeTransitionJobId(
            chatId,
            job.transition,
            job.scheduledFor,
            job.sessionKey,
          ),
          transition: job.transition,
          sessionKey: job.sessionKey,
          scheduledFor: new Date(job.scheduledFor),
          scheduleFingerprint: fingerprint,
          runtimeVersion: 4,
          createdAt: before,
        })),
      });
      for (const job of jobs)
        await queue.add(NIGHT_MODE_TRANSITION_JOB_NAME, job, {
          jobId: buildNightModeTransitionJobId(
            chatId,
            job.transition,
            job.scheduledFor,
            job.sessionKey,
          ),
          removeOnComplete: true,
        });
      const runtime = {
        processWebhookEvent: jest.fn<Promise<void>, [string]>(),
        processNightModeTransitionJob: jest.fn<
          ReturnType<ModerationExecutionLegacy['processNightModeTransitionJob']>,
          Parameters<ModerationExecutionLegacy['processNightModeTransitionJob']>
        >(),
      } satisfies ModerationExecutionLegacy;
      const processor = new NightModeTransitionProcessor(
        new ModerationExecutionService(runtime),
        createScheduler(),
      );
      worker = new Worker<NightModeTransitionJob>(
        chatId,
        (job, token) => processor.process(job, token),
        {
          connection,
          concurrency: 2,
          autorun: false,
        },
      );
      const completed: Array<Job<NightModeTransitionJob>> = [];
      const settled = new Promise<void>((resolve, reject) => {
        worker!.on('failed', (_job, error) => reject(error));
        worker!.on('error', reject);
        worker!.on('completed', (job) => {
          void (async () => {
            if (!crash) await processor.onCompleted(job);
            completed.push(job);
            if (completed.length === jobs.length) resolve();
          })().catch(reject);
        });
      });
      void worker.run();
      await settled;
      await worker.close();
      worker = undefined;
      expect(runtime.processNightModeTransitionJob).not.toHaveBeenCalled();
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
      ).not.toBeNull();

      const restarted = createScheduler();
      if (crash) {
        expect(await prisma.nightModeTransitionScheduledJob.count({ where: { chatId } })).toBe(2);
        for (const job of completed) await restarted.completeScheduledJob(job.data, job.id);
      }
      expect(await prisma.nightModeTransitionScheduledJob.count({ where: { chatId } })).toBe(0);
      const reconcile = new NightModeTransitionReconcileService(
        prisma as unknown as PrismaService,
        restarted,
        redis,
      );
      const oldest = await prisma.nightModeTransitionReconcileRequest.findFirstOrThrow({
        orderBy: [{ requestedAt: 'asc' }, { chatId: 'asc' }],
        select: { requestedAt: true },
      });
      const pendingRequest = await prisma.nightModeTransitionReconcileRequest.findUniqueOrThrow({
        where: { chatId },
        select: { generation: true },
      });
      // Deleted chats leave durable cleanup requests shared by all native suites.
      // Prove that a full earlier batch defers this request without losing it.
      backlogChatIds.push(...Array.from({ length: 5 }, () => `night-backlog-${randomUUID()}`));
      await prisma.nightModeTransitionReconcileRequest.createMany({
        data: backlogChatIds.map((id, index) => ({
          chatId: id,
          requestedAt: new Date(oldest.requestedAt.getTime() - 10 + index),
        })),
      });
      const repair = jest.spyOn(restarted, 'repairAccessSchedule');
      const batches = reconcile as unknown as { reconcileBatch(): Promise<number> };
      expect(await batches.reconcileBatch()).toBe(4);
      expect(new Set(repair.mock.calls.map(([id]) => id))).toEqual(
        new Set(backlogChatIds.slice(0, 4)),
      );
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
      ).toMatchObject({ generation: pendingRequest.generation, attemptCount: 0, leaseToken: null });
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({
          where: { chatId: backlogChatIds[4] },
        }),
      ).toMatchObject({ generation: 1n, attemptCount: 0, leaseToken: null });
      expect(await prisma.nightModeTransitionScheduledJob.count({ where: { chatId } })).toBe(0);

      // Select only our fixture first; do not clear or rewrite other suites' requests.
      await prisma.nightModeTransitionReconcileRequest.update({
        where: { chatId },
        data: { requestedAt: new Date(oldest.requestedAt.getTime() - 11) },
      });
      await batches.reconcileBatch();
      expect(repair.mock.calls.filter(([id]) => id === chatId)).toHaveLength(1);
      expect(repair).toHaveBeenCalledWith(chatId, {
        generation: pendingRequest.generation,
        leaseToken: expect.any(String),
      });
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
      ).toBeNull();
      const future = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
      expect(future).toHaveLength(2);
      expect(future.every((row) => row.scheduledFor.getTime() > Date.now())).toBe(true);
      for (const row of future) expect(await queue.getJob(row.jobId)).not.toBeUndefined();
      expect(runtime.processNightModeTransitionJob).not.toHaveBeenCalled();
    },
    20_000,
  );

  it('restores a committed receipt obligation after queue loss and schedule disable', async () => {
    const recovery: NightModeTransitionOpenEventRecovery = {
      kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      version: 1,
      sessionKey: 'v1:UTC:23:00:08:00:2026-01-01',
      messageId: 'native-open',
      botId: 'native-bot',
      timezone: 'UTC',
      startMinutes: 1380,
      endMinutes: 480,
    };
    const scheduler = createScheduler();
    await scheduler.scheduleRecoveryObligation(chatId, recovery);
    const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    await (await queue.getJob(jobId))!.remove();
    await prisma.chatSettings.update({ where: { chatId }, data: { nightModeEnabled: false } });
    await createScheduler().repairAccessSchedule(chatId);
    expect((await queue.getJob(jobId))?.data.recoveryOnly).toEqual(recovery);
    expect(
      (
        await prisma.nightModeTransitionScheduledJob.findUnique({
          where: { chatId_jobId: { chatId, jobId } },
        })
      )?.recoveryPayload,
    ).toEqual(recovery);
  });

  it('restores legacy fold recovery timestamps unchanged after queue loss and disable', async () => {
    const sessionKey = 'v1:Europe/Berlin:23:00:02:30:2026-10-24';
    const oldTime = '2026-10-25T01:30:00.000Z';
    const current = await prisma.chatSettings.update({
      where: { chatId },
      data: {
        nightModeStartTimeMinutes: 1380,
        nightModeEndTimeMinutes: 150,
        nightModeTimezone: 'Europe/Berlin',
      },
    });
    const cleanup = {
      kind: NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      version: 1 as const,
      sessionKey,
      timezone: 'Europe/Berlin',
      startMinutes: 1380,
      endMinutes: 150,
      openScheduledFor: oldTime,
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(current),
      sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(current),
    };
    const receipt: NightModeTransitionOpenEventRecovery = {
      kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      version: 1,
      sessionKey,
      timezone: 'Europe/Berlin',
      startMinutes: 1380,
      endMinutes: 150,
      messageId: 'old-fold-opening',
      botId: 'native-bot',
    };
    const scheduler = createScheduler();
    await scheduler.scheduleRecoveryObligation(chatId, cleanup);
    await scheduler.scheduleRecoveryObligation(chatId, receipt);
    const receiptId = buildNightModeTransitionRecoveryJobId(chatId, receipt);
    await prisma.nightModeTransitionScheduledJob.update({
      where: { chatId_jobId: { chatId, jobId: receiptId } },
      data: { scheduledFor: new Date(oldTime) },
    });
    for (const recovery of [cleanup, receipt])
      await (await queue.getJob(buildNightModeTransitionRecoveryJobId(chatId, recovery)))!.remove();
    await prisma.chatSettings.update({ where: { chatId }, data: { nightModeEnabled: false } });
    await createScheduler().repairAccessSchedule(chatId);
    for (const recovery of [cleanup, receipt]) {
      const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
      const restored = (await queue.getJob(jobId))!;
      expect(restored.data.scheduledFor).toBe(oldTime);
      expect(restored.data.recoveryOnly).toEqual(recovery);
      const row = await prisma.nightModeTransitionScheduledJob.findUniqueOrThrow({
        where: { chatId_jobId: { chatId, jobId } },
      });
      expect(row.scheduledFor.toISOString()).toBe(oldTime);
      expect(row.recoveryPayload).toEqual(recovery);
    }
  });

  it.each([false, true])(
    'retains CLOSE receipt or uncertainty after an absorbed job retires (ambiguous=%s)',
    async (ambiguous) => {
      const sessionKey = 'v1:Europe/Berlin:03:00:02:30:2026-03-29';
      const ownerKey = 'v1:Europe/Berlin:03:00:02:30:2026-03-28';
      const scheduledFor = '2026-03-29T01:00:00.000Z';
      const current = await prisma.chatSettings.update({
        where: { chatId },
        data: {
          nightModeStartTimeMinutes: 180,
          nightModeEndTimeMinutes: 150,
          nightModeTimezone: 'Europe/Berlin',
        },
      });
      const fingerprint = buildNightModeTransitionScheduleFingerprint(current);
      const job: NightModeTransitionJob = {
        chatId,
        transition: 'close',
        sessionKey,
        scheduledFor,
        transitionRuntimeVersion: 4,
        scheduleFingerprint: fingerprint,
      };
      const jobId = buildNightModeTransitionJobId(chatId, 'close', scheduledFor, sessionKey);
      const ledgerJobId = buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey);
      await prisma.maxActionLedgerEntry.create({
        data: {
          chatId,
          jobId: ledgerJobId,
          actionType: 'SEND_MESSAGE',
          sourceTag: 'night_mode_transition',
          status: ambiguous ? 'AMBIGUOUS' : 'SUCCEEDED',
          terminal: true,
          ambiguous,
          attemptCount: 1,
          dispatchStartedAt: new Date(scheduledFor),
          dispatchBotId: 'native-bot',
          completedAt: ambiguous ? null : new Date(scheduledFor),
          remoteMessageId: ambiguous ? null : 'accepted-legacy-closing',
        },
      });
      await prisma.nightModeTransitionScheduledJob.create({
        data: {
          chatId,
          jobId,
          transition: 'close',
          sessionKey,
          scheduledFor: new Date(scheduledFor),
          scheduleFingerprint: fingerprint,
          runtimeVersion: 4,
          createdAt: new Date('2026-03-28T20:00:00.000Z'),
        },
      });
      await queue.add(NIGHT_MODE_TRANSITION_JOB_NAME, job, { jobId, removeOnComplete: true });
      await prisma.chatSettings.update({ where: { chatId }, data: { nightModeEnabled: false } });
      const unexpectedExecution = {
        processWebhookEvent: jest.fn<Promise<void>, [string]>(),
        processNightModeTransitionJob: jest.fn<
          ReturnType<ModerationExecutionLegacy['processNightModeTransitionJob']>,
          Parameters<ModerationExecutionLegacy['processNightModeTransitionJob']>
        >(),
      } satisfies ModerationExecutionLegacy;
      const processor = new NightModeTransitionProcessor(
        new ModerationExecutionService(unexpectedExecution),
        createScheduler(),
      );
      worker = new Worker<NightModeTransitionJob>(
        chatId,
        (entry, token) => processor.process(entry, token),
        { connection, autorun: false },
      );
      const completed = new Promise<void>((resolve, reject) => {
        worker!.once('failed', (_entry, error) => reject(error));
        worker!.once('error', reject);
        worker!.once('completed', (entry) => {
          void processor.onCompleted(entry).then(resolve, reject);
        });
      });
      void worker.run();
      await completed;
      await worker.close();
      worker = undefined;
      expect(unexpectedExecution.processNightModeTransitionJob).not.toHaveBeenCalled();
      expect(
        await prisma.nightModeTransitionScheduledJob.findUnique({
          where: { chatId_jobId: { chatId, jobId } },
        }),
      ).toBeNull();
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
      ).not.toBeNull();
      await createScheduler().repairAccessSchedule(chatId);
      const rows = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
      const max = { sendMessage: jest.fn(), deleteMessage: jest.fn() };
      const ledger = new MaxActionLedgerService(prisma as unknown as PrismaService);
      const delivery = new NightModeTransitionDeliveryService(
        max as unknown as MaxClientService,
        new BotSpeechMediaService(max as unknown as MaxClientService),
        new NightModeTransitionEventService(prisma as unknown as PrismaService),
        undefined,
        undefined,
        undefined,
        ledger,
      );
      const adapters = {
        getBotSpeechProfile: () => ({ persona: 'male' as const, characterName: 'Major' }),
        buildClosedNoticeOptions: () => null,
        resolveBotId: async () => 'native-bot',
      };
      if (ambiguous) expect(rows).toHaveLength(0);
      else {
        const recovery = (await queue.getJob(rows[0]!.jobId))!;
        expect(recovery.data.recoveryOnly?.kind).toBe('close_notice_event');
        expect(recovery.data.sessionKey).toBe(sessionKey);
        const runtime = new NightModeTransitionRuntimeService(
          prisma as unknown as PrismaService,
          redis,
        );
        await runtime.processNightModeTransitionJob(recovery.data, delivery.createHooks(adapters));
        expect(
          await prisma.moderationEvent.count({
            where: {
              chatId,
              ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
              messageId: 'accepted-legacy-closing',
            },
          }),
        ).toBe(1);
      }
      await expect(
        delivery.sendClosedNotice(
          current,
          { sessionKey: ownerKey, timezone: 'Europe/Berlin', startMinutes: 180, endMinutes: 150 },
          adapters,
        ),
      ).rejects.toThrow('retains another SEND identity');
      const retained = await prisma.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId: ledgerJobId },
      });
      expect(retained.ambiguous).toBe(ambiguous);
      expect(retained.status).toBe(ambiguous ? 'AMBIGUOUS' : 'SUCCEEDED');
      expect(await prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
      expect(max.sendMessage).not.toHaveBeenCalled();
      expect(max.deleteMessage).not.toHaveBeenCalled();
    },
    20_000,
  );

  it.each([
    {
      sessionKey: 'v1:Europe/Berlin:23:00:02:30:2026-10-24',
      scheduledFor: '2026-10-25T01:30:00.000Z',
      start: 1380,
      end: 150,
    },
    {
      sessionKey: 'v1:Europe/Berlin:03:00:02:30:2026-03-29',
      scheduledFor: '2026-03-30T00:30:00.000Z',
      start: 180,
      end: 150,
    },
  ])(
    'repairs an accepted legacy OPEN event for $sessionKey without another send',
    async ({ sessionKey, scheduledFor, start, end }) => {
      await prisma.maxActionLedgerEntry.create({
        data: {
          chatId,
          jobId: buildNightModeNoticeIdempotencyKey('open', chatId, sessionKey),
          actionType: 'SEND_MESSAGE',
          sourceTag: 'night_mode_transition',
          status: 'SUCCEEDED',
          terminal: true,
          ambiguous: false,
          completedAt: new Date(scheduledFor),
          dispatchBotId: 'native-bot',
          remoteMessageId: 'accepted-legacy-opening',
        },
      });
      const scheduler = createScheduler();
      await scheduler.retireTransition({
        chatId,
        transition: 'open',
        sessionKey,
        scheduledFor,
        transitionRuntimeVersion: 4,
        scheduleFingerprint: buildNightModeTransitionScheduleFingerprint({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: start,
          nightModeEndTimeMinutes: end,
          nightModeTimezone: 'Europe/Berlin',
        }),
      });
      const row = (
        await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } })
      ).find(
        (entry) =>
          (entry.recoveryPayload as { kind?: string } | null)?.kind ===
          NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      )!;
      expect(row).toBeDefined();
      await (await queue.getJob(row.jobId))!.remove();
      await prisma.chatSettings.update({ where: { chatId }, data: { nightModeEnabled: false } });
      await createScheduler().repairAccessSchedule(chatId);
      const restored = (await queue.getJob(row.jobId))!;
      const max = { sendMessage: jest.fn(), deleteMessage: jest.fn() };
      const events = new NightModeTransitionEventService(prisma as unknown as PrismaService);
      const delivery = new NightModeTransitionDeliveryService(
        max as unknown as MaxClientService,
        new BotSpeechMediaService(max as unknown as MaxClientService),
        events,
        undefined,
        undefined,
        undefined,
        new MaxActionLedgerService(prisma as unknown as PrismaService),
      );
      const hooks = delivery.createHooks({
        getBotSpeechProfile: () => ({ persona: 'male', characterName: 'Major' }),
        buildClosedNoticeOptions: () => null,
        resolveBotId: async () => 'native-bot',
      });
      const runtime = new NightModeTransitionRuntimeService(
        prisma as unknown as PrismaService,
        redis,
      );
      await Promise.all([
        runtime.processNightModeTransitionJob(restored.data, hooks),
        runtime.processNightModeTransitionJob(restored.data, hooks),
      ]);
      expect(
        await prisma.moderationEvent.count({
          where: {
            chatId,
            ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
            messageId: 'accepted-legacy-opening',
          },
        }),
      ).toBe(1);
      expect(max.sendMessage).not.toHaveBeenCalled();
      expect(max.deleteMessage).not.toHaveBeenCalled();
      expect(await prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
    },
  );

  it('repairs an accepted opening event exactly once after Redis job loss without a second send', async () => {
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const current = await prisma.chatSettings.update({
      where: { chatId },
      data: {
        nightModeStartTimeMinutes: (minute + 1380) % 1440,
        nightModeEndTimeMinutes: minute,
      },
    });
    const occurrence = resolveCurrentNightModeOpenOccurrence(current, now)!;
    expect(occurrence).not.toBeNull();
    const job: NightModeTransitionJob = {
      chatId,
      transition: 'open',
      sessionKey: occurrence.sessionKey,
      scheduledFor: occurrence.dueAt.toISOString(),
      transitionRuntimeVersion: 4,
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(current),
    };
    const scheduler = createScheduler();
    const ledger = new MaxActionLedgerService(prisma as unknown as PrismaService);
    const events = new NightModeTransitionEventService(prisma as unknown as PrismaService);
    const writeEvent = jest
      .spyOn(events, 'createTransitionEvent')
      .mockRejectedValueOnce(new Error('transient event insert failure'));
    const maxClient = {
      sendMessage: jest.fn(async (...args: Parameters<MaxClientService['sendMessage']>) => {
        await args[3]?.beforeImmediateSendMutation?.();
        await prisma.maxActionLedgerEntry.create({
          data: {
            chatId,
            jobId: buildNightModeNoticeIdempotencyKey('open', chatId, occurrence.sessionKey),
            actionType: 'SEND_MESSAGE',
            sourceTag: 'night_mode_transition',
            status: 'SUCCEEDED',
            terminal: true,
            ambiguous: false,
            completedAt: new Date(),
            dispatchBotId: 'native-bot',
            remoteMessageId: 'native-accepted-opening',
          },
        });
        return { messageId: 'native-accepted-opening', url: null };
      }),
      deleteMessage: jest.fn(),
    };
    const media: Pick<BotSpeechMediaService, 'resolveMedia' | 'withMediaOptions'> = {
      resolveMedia: () => null,
      withMediaOptions: async (options) => options,
    };
    const delivery = new NightModeTransitionDeliveryService(
      maxClient as unknown as MaxClientService,
      media as BotSpeechMediaService,
      events,
      undefined,
      undefined,
      undefined,
      ledger,
      undefined,
      scheduler,
    );
    const hooks = delivery.createHooks({
      getBotSpeechProfile: () => ({ persona: 'male', characterName: 'Майор Максимов' }),
      buildClosedNoticeOptions: () => null,
      resolveBotId: async () => 'native-bot',
    });
    const runtime = new NightModeTransitionRuntimeService(
      prisma as unknown as PrismaService,
      redis,
    );
    await expect(runtime.processNightModeTransitionJob(job, hooks)).rejects.toThrow(
      'event persistence failed after MAX accepted notice',
    );
    writeEvent.mockRestore();
    const rows = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
    const eventRow = rows.find(
      (row) =>
        (row.recoveryPayload as { kind?: string } | null)?.kind ===
        NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
    )!;
    expect(eventRow).toBeDefined();
    expect(
      rows.some(
        (row) =>
          (row.recoveryPayload as { kind?: string } | null)?.kind ===
          NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      ),
    ).toBe(true);
    expect(await redis.getString(`night-mode-transition-state:v1:${chatId}`)).toContain(
      '"status":"open"',
    );
    await (await queue.getJob(eventRow.jobId))!.remove();
    await prisma.chatSettings.update({ where: { chatId }, data: { nightModeEnabled: false } });
    await scheduler.repairAccessSchedule(chatId);
    const restored = (await queue.getJob(eventRow.jobId))!;
    expect(restored).toBeDefined();
    // FLAG: Two recovery workers may overlap after Redis loss; the SQL advisory lock owns exact event identity.
    await Promise.all([
      runtime.processNightModeTransitionJob(restored.data, hooks),
      runtime.processNightModeTransitionJob(restored.data, hooks),
    ]);
    expect(
      await prisma.moderationEvent.count({
        where: { chatId, ruleCode: 'NIGHT_MODE_OPEN_NOTICE', messageId: 'native-accepted-opening' },
      }),
    ).toBe(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  }, 20_000);

  it('keeps a new future close verifiable when PostgreSQL is ahead of the application clock', async () => {
    const realNow = new Date();
    const minute = realNow.getUTCHours() * 60 + realNow.getUTCMinutes();
    await prisma.chatSettings.update({
      where: { chatId },
      data: {
        nightModeStartTimeMinutes: (minute + 4 * 60) % 1440,
        nightModeEndTimeMinutes: (minute + 20 * 60) % 1440,
      },
    });
    // FLAG: Control the JS wall clock only; PostgreSQL/Redis clocks and all I/O timers stay real.
    jest.useFakeTimers({
      now: realNow.getTime() - 60_000,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const scheduler = createScheduler();
      await expect(scheduler.repairAccessSchedule(chatId)).resolves.toMatchObject({
        queueAvailable: true,
        scheduleEnabled: true,
      });
      const rows = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
      const closeRow = rows.find(
        (row) => row.transition === 'close' && row.scheduledFor.getTime() > Date.now(),
      )!;
      expect(closeRow).toBeDefined();
      expect(closeRow.createdAt.getTime()).toBeGreaterThan(Date.now());
      const closeJob = (await queue.getJob(closeRow.jobId))!;
      const marker = closeJob.data.stickyRouteProbe!;
      expect(marker).toBeDefined();
      expect(Date.parse(marker.authorizedAt)).toBeGreaterThanOrEqual(closeRow.createdAt.getTime());
      expect(Date.parse(marker.authorizedAt)).toBeLessThan(closeRow.scheduledFor.getTime());
      await expect(scheduler.repairAccessSchedule(chatId)).resolves.toMatchObject({
        queueAvailable: true,
        scheduleEnabled: true,
      });
      expect((await queue.getJob(closeRow.jobId))!.data).toEqual(closeJob.data);
      expect(
        (
          await prisma.nightModeTransitionScheduledJob.findUniqueOrThrow({
            where: { chatId_jobId: { chatId, jobId: closeRow.jobId } },
          })
        ).createdAt,
      ).toEqual(closeRow.createdAt);
    } finally {
      jest.useRealTimers();
    }
  }, 20_000);

  it('fences an ambiguous close cleanup without retrying it or stopping the future schedule', async () => {
    const current = await prisma.chatSettings.findUniqueOrThrow({
      where: { chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: { select: { publishedUrl: true, publishedMessageId: true } },
          },
        },
      },
    });
    const recovery = {
      kind: NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      version: 1 as const,
      sessionKey: 'v1:UTC:23:00:08:00:2026-01-01',
      timezone: 'UTC',
      startMinutes: 1380,
      endMinutes: 480,
      openScheduledFor: '2026-01-02T08:00:00.000Z',
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(current),
      sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(current),
    };
    await prisma.maxActionLedgerEntry.create({
      data: {
        chatId,
        jobId: buildNightModeNoticeIdempotencyKey('close', chatId, recovery.sessionKey),
        actionType: 'SEND_MESSAGE',
        sourceTag: 'night_mode_transition',
        status: 'FAILED_TERMINAL',
        terminal: true,
        ambiguous: true,
        dispatchStartedAt: new Date(recovery.openScheduledFor),
        dispatchBotId: 'native-bot',
      },
    });
    const scheduler = createScheduler();
    await scheduler.scheduleRecoveryObligation(chatId, recovery);
    const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    const runtime = {
      processWebhookEvent: jest.fn<Promise<void>, [string]>(),
      processNightModeTransitionJob: jest.fn<
        ReturnType<ModerationExecutionLegacy['processNightModeTransitionJob']>,
        Parameters<ModerationExecutionLegacy['processNightModeTransitionJob']>
      >(),
    } satisfies ModerationExecutionLegacy;
    const processor = new NightModeTransitionProcessor(
      new ModerationExecutionService(runtime),
      scheduler,
    );
    worker = new Worker<NightModeTransitionJob>(
      chatId,
      (job, token) => processor.process(job, token),
      { connection, autorun: false },
    );
    const failed = new Promise<void>((resolve, reject) => {
      worker!.on('failed', (job, error) => {
        void processor.onFailed(job, error).then(resolve, reject);
      });
      worker!.on('error', reject);
    });
    void worker.run();
    await failed;
    await worker.close();
    worker = undefined;
    const failedJob = (await queue.getJob(jobId))!;
    expect(await failedJob.getState()).toBe('failed');
    expect(failedJob.attemptsMade).toBe(1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await scheduler.repairAccessSchedule(chatId);
      expect(result.manualReview?.jobId).toBe(jobId);
      expect((await queue.getJob(jobId))!.attemptsMade).toBe(1);
      expect(
        await prisma.nightModeTransitionScheduledJob.count({
          where: { chatId, recoveryPayload: { equals: Prisma.DbNull } },
        }),
      ).toBe(2);
    }
    expect(runtime.processNightModeTransitionJob).not.toHaveBeenCalled();
  }, 20_000);

  it('preserves an expired accepted OPEN before scheduler cleanup removes its original job', async () => {
    const sessionKey = 'v1:UTC:23:00:08:00:2026-01-01';
    const scheduledFor = '2026-01-02T08:00:00.000Z';
    const jobId = buildNightModeTransitionJobId(chatId, 'open', scheduledFor, sessionKey);
    const fingerprint = buildNightModeTransitionScheduleFingerprint(settings);
    await prisma.maxActionLedgerEntry.create({
      data: {
        jobId: buildNightModeNoticeIdempotencyKey('open', chatId, sessionKey),
        chatId,
        actionType: 'SEND_MESSAGE',
        sourceTag: 'night_mode_transition',
        status: 'SUCCEEDED',
        terminal: true,
        ambiguous: false,
        completedAt: new Date(scheduledFor),
        remoteMessageId: 'accepted-before-outage',
        dispatchBotId: 'native-bot',
      },
    });
    await prisma.nightModeTransitionScheduledJob.create({
      data: {
        chatId,
        jobId,
        transition: 'open',
        sessionKey,
        scheduledFor: new Date(scheduledFor),
        scheduleFingerprint: fingerprint,
        runtimeVersion: 4,
      },
    });
    await queue.add(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      {
        chatId,
        transition: 'open',
        sessionKey,
        scheduledFor,
        scheduleFingerprint: fingerprint,
        transitionRuntimeVersion: 4,
      },
      { jobId },
    );
    await createScheduler().repairAccessSchedule(chatId);
    expect(await queue.getJob(jobId)).toBeUndefined();
    const rows = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
    const event = rows.find((row) => row.recoveryPayload !== null);
    expect(event?.recoveryPayload).toMatchObject({
      kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      messageId: 'accepted-before-outage',
      sessionKey,
    });
    expect((await queue.getJob(event!.jobId))?.data.recoveryOnly?.kind).toBe(
      NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
    );
    expect(rows.filter((row) => row.recoveryPayload === null)).toHaveLength(2);
  });

  it('replaces a failed accepted OPEN with receipt-only work without a manual send fence', async () => {
    const nowMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const currentSettings = {
      ...settings,
      nightModeStartTimeMinutes: (nowMinutes + 60) % 1440,
      nightModeEndTimeMinutes: (nowMinutes + 1435) % 1440,
    };
    await prisma.chatSettings.update({ where: { chatId }, data: currentSettings });
    const occurrence = resolveCurrentNightModeOpenOccurrence(currentSettings)!;
    const fingerprint = buildNightModeTransitionScheduleFingerprint(currentSettings);
    const job: NightModeTransitionJob = {
      chatId,
      transition: 'open',
      sessionKey: occurrence.sessionKey,
      scheduledFor: occurrence.dueAt.toISOString(),
      scheduleFingerprint: fingerprint,
      transitionRuntimeVersion: 4,
    };
    const jobId = buildNightModeTransitionJobId(chatId, 'open', job.scheduledFor, job.sessionKey);
    await prisma.maxActionLedgerEntry.create({
      data: {
        jobId: buildNightModeNoticeIdempotencyKey('open', chatId, job.sessionKey),
        chatId,
        actionType: 'SEND_MESSAGE',
        sourceTag: 'night_mode_transition',
        status: 'SUCCEEDED',
        terminal: true,
        completedAt: occurrence.dueAt,
        remoteMessageId: 'accepted-open-event-failed',
        dispatchBotId: 'native-bot',
      },
    });
    await prisma.nightModeTransitionScheduledJob.create({
      data: {
        chatId,
        jobId,
        transition: 'open',
        sessionKey: job.sessionKey,
        scheduledFor: occurrence.dueAt,
        scheduleFingerprint: fingerprint,
        runtimeVersion: 4,
        createdAt: new Date(occurrence.dueAt.getTime() - 60_000),
      },
    });
    await queue.add(NIGHT_MODE_TRANSITION_JOB_NAME, job, { jobId, attempts: 1 });
    worker = new Worker<NightModeTransitionJob>(
      chatId,
      async () => {
        throw new Error(
          'Night mode NIGHT_MODE_OPEN_NOTICE event persistence failed after MAX accepted notice',
        );
      },
      { connection, autorun: false },
    );
    const failed = new Promise<void>((resolve, reject) => {
      worker!.once('failed', () => resolve());
      worker!.once('error', reject);
    });
    void worker.run();
    await failed;
    await worker.close();
    worker = undefined;
    const result = await createScheduler().repairAccessSchedule(chatId);
    expect(result.manualReview).toBeUndefined();
    expect(await queue.getJob(jobId)).toBeUndefined();
    const payloads = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
    expect(
      payloads.some(
        (row) =>
          (row.recoveryPayload as { kind?: string } | null)?.kind ===
          NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      ),
    ).toBe(true);
  }, 20_000);

  it('durably recovers capability-only grants without an application callback', async () => {
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId: 'native-bot' } },
      data: { permissionsSnapshot: { ...permissions, permissions: [] } },
    });
    await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId: 'native-bot' } },
      data: {
        permissionsSnapshot: permissions,
        botAccessExpiresAt: new Date(Date.now() + 900_000),
      },
    });
    expect(
      await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).not.toBeNull();
    const restarted = createScheduler();
    await restarted.repairAccessSchedule(chatId);
    expect(await prisma.nightModeTransitionScheduledJob.count({ where: { chatId } })).toBe(2);
    await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
    await prisma.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId: 'native-bot' } },
      data: {
        permissionsSnapshot: {
          ...permissions,
          checkedAt: new Date().toISOString(),
          permissions: ['read_all_messages', 'write', 'write'],
        },
      },
    });
    expect(
      await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).toBeNull();
  });

  it('retains source-only activation recovery and fences malformed cleanup independently', async () => {
    const identity = { chatId_botId: { chatId, botId: 'native-bot' } };
    await prisma.chatBotMembership.update({
      where: identity,
      data: { botAccessSource: 'major_explicit_activation_pending' },
    });
    await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
    await prisma.chatBotMembership.update({
      where: identity,
      data: { botAccessSource: 'explicit_start' },
    });
    expect(
      await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).not.toBeNull();
    const recovery = {
      kind: NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      version: 1 as const,
      sessionKey: 'v1:UTC:23:00:08:00:2026-01-01',
      timezone: 'UTC',
      startMinutes: 1380,
      endMinutes: 480,
      openScheduledFor: '2026-01-02T08:00:00.000Z',
      scheduleFingerprint: `sha256:${'0'.repeat(64)}`,
      sideEffectFingerprint: `sha256:${'1'.repeat(64)}`,
    };
    const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    await prisma.nightModeTransitionScheduledJob.create({
      data: {
        chatId,
        jobId,
        transition: 'open',
        sessionKey: recovery.sessionKey,
        scheduledFor: new Date(recovery.openScheduledFor),
        scheduleFingerprint: recovery.scheduleFingerprint,
        runtimeVersion: 4,
        recoveryPayload: recovery,
      },
    });
    const result = await createScheduler().repairAccessSchedule(chatId);
    expect(result.manualReview?.jobId).toBe(jobId);
    const rows = await prisma.nightModeTransitionScheduledJob.findMany({ where: { chatId } });
    expect(rows.filter((row) => !row.recoveryPayload)).toHaveLength(2);
    expect(rows.some((row) => row.jobId === jobId)).toBe(true);
    expect(await queue.getJob(jobId)).toBeUndefined();
  });

  it.each(['UNKNOWN', 'STALE'] as const)(
    'retains a capability grant plus expiry change in %s',
    async (state) => {
      const identity = { chatId_botId: { chatId, botId: 'native-bot' } };
      await prisma.chatBotMembership.update({
        where: identity,
        data: {
          botAccessState: state,
          botAccessExpiresAt: null,
          permissionsSnapshot: { ...permissions, permissions: [] },
        },
      });
      await prisma.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
      await prisma.chatBotMembership.update({
        where: identity,
        data: {
          botAccessExpiresAt: new Date(Date.now() + 600_000),
          permissionsSnapshot: permissions,
        },
      });
      expect(
        await prisma.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
      ).not.toBeNull();
    },
  );

  it.each([
    null,
    [],
    {},
    { isAdmin: true },
    { isOwner: true, permissionsKnown: 'true' },
    { ...permissions, permissions: [' WRITE ', 'READ-ALL-MESSAGES'] },
    { ...permissions, permissions: ['\tWRITE\n', '\tREAD-ALL-MESSAGES\r'] },
    { ...permissions, permissions: ['can_write', 'can_read_all_messages'] },
    {
      ...permissions,
      permissions: ['can_post_edit_delete_message', 'can_send_messages', 'read_all_messages'],
    },
    { ...permissions, permissions: ['delete_messages', 'send_messages', 'read_all_messages'] },
    { ...permissions, activationCapabilityCeiling: null },
    { ...permissions, activationCapabilityCeiling: ['moderation', 'delete_message'] },
    {
      ...permissions,
      activationCapabilityCeiling: ['send_message', 'moderation', 'delete_message'],
    },
  ])(
    'keeps SQL capability eligibility aligned with the executor projection: %j',
    async (snapshot) => {
      const rows = await prisma.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
      SELECT night_mode_membership_capabilities_allow_transition(${JSON.stringify(snapshot)}::JSONB) AS allowed
    `);
      expect(rows[0]!.allowed).toBe(
        isNightModeTransitionMembershipCandidate({
          botId: 'native-bot',
          status: 'ACTIVE',
          botAccessState: 'CONFIRMED_ADMIN',
          permissionsSnapshot: snapshot,
        }),
      );
    },
  );
});
