import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { PROCESSOR_METADATA, WORKER_METADATA } from '@nestjs/bullmq/dist/bull.constants';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService } from '../max/max-client.service';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';
import { ADMIN_MANUAL_COMMAND_QUEUE } from './admin-manual-command.queue';
import { ADMIN_MANUAL_FANOUT_QUEUE, type AdminManualFanoutJob } from './admin-manual-fanout.queue';
import { ManualModerationService } from './manual-moderation.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = redisUrl ? describe : describe.skip;
const commandQueueName = ADMIN_MANUAL_COMMAND_QUEUE;
const manualQueueNames = [ADMIN_MANUAL_FANOUT_QUEUE, commandQueueName];
jest.setTimeout(30_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observedWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

type ManualProcessor = {
  process(job: Job<AdminManualFanoutJob>): Promise<void>;
};
type ManualProcessorClass = new (service: ManualModerationService) => ManualProcessor;
type ProcessorSpec = {
  name: string;
  concurrency: number;
  implementation: ManualProcessorClass;
};

const command = {
  sourceChatId: 'native-command-chat',
  commandBotId: 'native-major',
  targetUserId: 'native-command-target',
  targetSenderName: 'Native target',
  targetMessageId: 'native-target-message',
  commandMessageId: 'native-command-message',
  actor: { userId: 'native-admin', username: null, displayName: 'Native admin' },
  action: 'MUTE' as const,
  muteDurationHours: 24,
  deleteBotMessagesEnabled: false,
  deleteBotMessagesDelayMinutes: 1,
};

integration('Manual commands retain independent BullMQ admission', () => {
  const oldRole = process.env.APP_ROLE;
  const oldService = process.env.APP_SERVICE_NAME;
  let processorSpecs: ProcessorSpec[];
  let queues: Map<string, Queue<AdminManualFanoutJob>>;
  let workers: Worker<AdminManualFanoutJob>[];
  let testModule: TestingModule | undefined;
  let service: ManualModerationService;
  let releaseBackground: ReturnType<typeof deferred>;
  let backgroundStarted: ReturnType<typeof deferred>;
  let commandStarted: ReturnType<typeof deferred>;
  let commandCompleted: ReturnType<typeof deferred>;
  let running: number;
  let peakRunning: number;
  let activeBackground: number;
  let handledCommands: number;
  let workerErrors: Error[];
  let connection: { host: string; port: number; db: number };
  let prefix: string;

  beforeAll(async () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const { AdminModule } = await import('./admin.module');
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminModule) as unknown[];
    processorSpecs = providers.flatMap((provider): ProcessorSpec[] => {
      if (typeof provider !== 'function') return [];
      const processor = Reflect.getMetadata(PROCESSOR_METADATA, provider) as
        | { name?: string }
        | undefined;
      if (!processor?.name || !manualQueueNames.includes(processor.name)) return [];
      const options = Reflect.getMetadata(WORKER_METADATA, provider) as
        | { concurrency?: number }
        | undefined;
      if (!options?.concurrency) throw new Error('Manual processor concurrency must be explicit');
      return [
        {
          name: processor.name,
          concurrency: options.concurrency,
          implementation: provider as ManualProcessorClass,
        },
      ];
    });
  });

  beforeEach(async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Disposable local Redis required');
    connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      db: Number(url.pathname.slice(1) || 0),
    };
    prefix = `manual-command-admission-${randomUUID()}`;
    queues = new Map(
      manualQueueNames.map((name) => [name, new Queue(name, { prefix, connection })]),
    );
    workers = [];
    releaseBackground = deferred();
    backgroundStarted = deferred();
    commandStarted = deferred();
    commandCompleted = deferred();
    running = 0;
    peakRunning = 0;
    activeBackground = 0;
    handledCommands = 0;
    workerErrors = [];
    await Promise.all([...queues.values()].map((queue) => queue.waitUntilReady()));

    const config = new ConfigService({
      MAX_BOT_ID: 'native-major',
      MAX_BOT_TOKEN: 'native-manual-command-token',
      MAX_WEBHOOK_SECRET_PATH: 'native-manual-command-webhook-path',
      MAX_WEBHOOK_HEADER_SECRET: 'native-manual-command-webhook-header',
      APP_BASE_URL: 'https://example.com',
    });
    // FLAG: Exercise the public producer with its real queue injection. This test
    // never enters SQL or MAX effects; their dependencies are deliberately inert.
    testModule = await Test.createTestingModule({
      providers: [
        AdminService,
        ManualModerationService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: {} satisfies Partial<PrismaService> },
        { provide: MaxClientService, useValue: {} satisfies Partial<MaxClientService> },
        {
          provide: ChatContextCacheService,
          useValue: {} satisfies Partial<ChatContextCacheService>,
        },
        { provide: MaxBotRegistryService, useValue: new MaxBotRegistryService(config) },
        {
          provide: GlobalSpammerIntelligenceService,
          useValue: {} satisfies Partial<GlobalSpammerIntelligenceService>,
        },
        ...[...queues].map(([name, queue]) => ({ provide: getQueueToken(name), useValue: queue })),
      ],
    }).compile();
    service = testModule.get(ManualModerationService);
    jest.spyOn(service, 'processManualModerationFanoutJob').mockImplementation(async (job) => {
      running++;
      peakRunning = Math.max(peakRunning, running);
      try {
        if (job.kind === 'manual_group_moderation_command') {
          handledCommands++;
          commandStarted.resolve();
        } else {
          activeBackground++;
          const backgroundCapacity = processorSpecs.find(
            (spec) => spec.name === ADMIN_MANUAL_FANOUT_QUEUE,
          )!.concurrency;
          if (activeBackground === backgroundCapacity) backgroundStarted.resolve();
          await releaseBackground.promise;
        }
      } finally {
        running--;
        if (job.kind === 'manual_group_moderation_command') commandCompleted.resolve();
      }
    });
  });

  afterEach(async () => {
    releaseBackground?.resolve();
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
    await Promise.all([...queues.values()].map((queue) => queue.close()));
    await testModule?.close();
    expect(workerErrors).toEqual([]);
  });

  afterAll(() => {
    if (oldRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = oldRole;
    if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = oldService;
  });

  async function startWorkers() {
    workers = processorSpecs.map((spec) => {
      const processor = new spec.implementation(service);
      const worker = new Worker<AdminManualFanoutJob>(spec.name, (job) => processor.process(job), {
        prefix,
        connection,
        concurrency: spec.concurrency,
      });
      worker.on('error', (error) => workerErrors.push(error));
      return worker;
    });
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  }

  async function retainLegacyCommand() {
    expect(await service.enqueueManualGroupModerationCommand(command)).toBe(true);
    const stored = (
      await Promise.all([...queues.values()].map((queue) => queue.getJobs(['wait', 'prioritized'])))
    ).flat();
    expect(stored).toHaveLength(1);
    const original = stored[0];
    const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
    if (original.queueName === ADMIN_MANUAL_FANOUT_QUEUE) return original;
    await original.remove();
    return legacy.add(original.name, original.data, {
      ...original.opts,
      jobId: original.id,
      removeOnComplete: false,
    });
  }

  it('starts a command before blocked background work releases, within two manual slots', async () => {
    const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
    for (const index of [0, 1]) {
      const data: AdminManualFanoutJob = {
        kind: 'manual_ban_source_cleanup',
        jobId: `blocked-cleanup-${index}`,
        sourceChatId: `native-background-chat-${index}`,
        targetUserId: `native-background-target-${index}`,
        actor: command.actor,
        source: 'group_command',
      };
      await legacy.add('execute-admin-manual-fanout', data, { jobId: data.jobId });
    }
    await startWorkers();
    expect(await observedWithin(backgroundStarted.promise, 2_000)).toBe(true);
    expect(await service.enqueueManualGroupModerationCommand(command)).toBe(true);

    expect(await observedWithin(commandStarted.promise, 1_500)).toBe(true);
    expect(handledCommands).toBe(1);
    expect(peakRunning).toBeLessThanOrEqual(2);
    expect(processorSpecs.reduce((sum, spec) => sum + spec.concurrency, 0)).toBe(2);
  });

  it('reuses a retained legacy command and lets its existing consumer drain it once', async () => {
    const original = await retainLegacyCommand();
    const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
    const dedicated = queues.get(commandQueueName)!;
    const addDedicated = jest.spyOn(dedicated, 'add');

    expect(await service.enqueueManualGroupModerationCommand(command)).toBe(true);
    expect(addDedicated).not.toHaveBeenCalled();
    expect(await dedicated.getJobCounts('wait', 'prioritized', 'active')).toEqual({
      wait: 0,
      prioritized: 0,
      active: 0,
    });
    expect((await legacy.getJob(original.id!))?.data).toEqual(original.data);

    await startWorkers();
    expect(await observedWithin(commandCompleted.promise, 2_000)).toBe(true);
    expect(handledCommands).toBe(1);
  });

  it.each(['active', 'completed', 'failed', 'delayed'] as const)(
    'preserves a retained %s legacy command without adding or restarting it',
    async (state) => {
      const original = await retainLegacyCommand();
      const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
      const dedicated = queues.get(commandQueueName)!;
      const worker = new Worker<AdminManualFanoutJob>(
        ADMIN_MANUAL_FANOUT_QUEUE,
        async () => undefined,
        { prefix, connection, autorun: false },
      );
      workers.push(worker);
      const token = 'retained-command-token';
      const owned = (await worker.getNextJob(token))!;
      expect(owned.id).toBe(original.id);
      if (state === 'completed') await owned.moveToCompleted(undefined, token, false);
      if (state === 'failed') {
        owned.discard();
        await owned.moveToFailed(new Error('Retained test failure'), token, false);
      }
      if (state === 'delayed') await owned.moveToDelayed(Date.now() + 60_000, token);
      expect(await owned.getState()).toBe(state);
      const before = (await legacy.getJob(original.id!))!;
      const addDedicated = jest.spyOn(dedicated, 'add');
      const addLegacy = jest.spyOn(legacy, 'add');

      expect(await service.enqueueManualGroupModerationCommand(command)).toBe(true);
      expect(addDedicated).not.toHaveBeenCalled();
      expect(addLegacy).not.toHaveBeenCalled();
      const after = (await legacy.getJob(original.id!))!;
      expect(after.data).toEqual(before.data);
      expect(after.attemptsMade).toBe(before.attemptsMade);
      expect(await after.getState()).toBe(state);
      expect(handledCommands).toBe(0);
      if (state === 'active') await owned.moveToCompleted(undefined, token, false);
    },
  );

  it.each(['legacy lookup', 'dedicated enqueue'] as const)(
    'does not enqueue elsewhere or run inline effects after a failed %s',
    async (boundary) => {
      const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
      const dedicated = queues.get(commandQueueName)!;
      const addLegacy = jest.spyOn(legacy, 'add');
      const addDedicated = jest.spyOn(dedicated, 'add');
      if (boundary === 'legacy lookup')
        jest.spyOn(legacy, 'getJob').mockRejectedValueOnce(new Error('Synthetic lookup outage'));
      else addDedicated.mockRejectedValueOnce(new Error('Synthetic enqueue outage'));

      expect(await service.enqueueManualGroupModerationCommand(command)).toBe(false);
      expect(addLegacy).not.toHaveBeenCalled();
      expect(addDedicated).toHaveBeenCalledTimes(boundary === 'legacy lookup' ? 0 : 1);
      expect(service.processManualModerationFanoutJob).not.toHaveBeenCalled();
      expect(await dedicated.getJobCounts('wait', 'prioritized', 'active')).toEqual({
        wait: 0,
        prioritized: 0,
        active: 0,
      });
    },
  );

  it.each(['adminManualFanoutQueue', 'adminManualCommandQueue'] as const)(
    'refuses command admission when %s was not injected',
    async (missingQueue) => {
      const legacy = queues.get(ADMIN_MANUAL_FANOUT_QUEUE)!;
      const dedicated = queues.get(commandQueueName)!;
      const addLegacy = jest.spyOn(legacy, 'add');
      const addDedicated = jest.spyOn(dedicated, 'add');
      Reflect.set(testModule!.get(AdminService), missingQueue, undefined);

      expect(await service.enqueueManualGroupModerationCommand(command)).toBe(false);
      expect(addLegacy).not.toHaveBeenCalled();
      expect(addDedicated).not.toHaveBeenCalled();
      expect(service.processManualModerationFanoutJob).not.toHaveBeenCalled();
    },
  );

  it('rejects a background payload on the command consumer before invoking its effect boundary', async () => {
    const dedicated = queues.get(commandQueueName)!;
    const data: AdminManualFanoutJob = {
      kind: 'manual_ban_source_cleanup',
      jobId: 'wrong-queue-cleanup',
      sourceChatId: 'native-background-chat',
      targetUserId: 'native-background-target',
      actor: command.actor,
      source: 'group_command',
    };
    const stored = await dedicated.add('execute-admin-manual-fanout', data, {
      jobId: data.jobId,
      attempts: 5,
    });
    await startWorkers();
    const failure = deferred();
    for (const worker of workers)
      worker.on('failed', (job) => {
        if (job?.id === stored.id) failure.resolve();
      });
    // The worker may have failed before its listener was installed.
    if ((await stored.getState()) === 'failed') failure.resolve();
    expect(await observedWithin(failure.promise, 2_000)).toBe(true);
    expect(await stored.getState()).toBe('failed');
    expect(service.processManualModerationFanoutJob).not.toHaveBeenCalled();
  });
});
