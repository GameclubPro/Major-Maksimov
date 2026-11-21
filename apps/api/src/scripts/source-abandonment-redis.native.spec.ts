import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  inventorySourceAbandonmentNamespaces,
  readMeasuredSourceCatalogScript,
  SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT,
  SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT,
} from './source-abandonment-redis-catalog';
import {
  inventorySourceAbandonmentRedis,
  type SourceAbandonmentRedisReader,
  type SourceAbandonmentRedisResolver,
  type SourceAbandonmentRedisSource,
} from './source-abandonment-live-redis';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';
import { SOURCE_ABANDONMENT_CHANNEL_PROFILE } from '../webhook/webhook-source-abandonment.contract';

const url = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = url ? describe : describe.skip;
jest.setTimeout(60_000);
const resolve: SourceAbandonmentRedisResolver = async (_kind, keys) => ({
  rows: keys.map((key) => ({ key, row: null, digest: 'f'.repeat(64) })),
  plans: [],
  cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
  issue: null,
});

// FLAG: Only this fixture's initially empty localhost Redis DB may be mutated.
// Production readers receive EVAL_RO and read-only cost transactions, no Queue/Worker.
native('modern full namespace census on Redis 7', () => {
  let redis: Redis;
  let fixtureUrl: string;
  let ownsDatabase = false;
  const queues: Queue[] = [];
  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Disposable localhost Redis required');
    target.pathname = '/12';
    fixtureUrl = target.toString();
    redis = new Redis(fixtureUrl, { maxRetriesPerRequest: 0, commandTimeout: 10_000 });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Native catalog DB is already occupied');
    ownsDatabase = true;
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    if (ownsDatabase) await redis.flushdb();
  });
  afterAll(() => redis?.disconnect());

  const reader = () => ({
    multi: () => redis.multi(),
    eval_ro: jest.fn((script: string, keys: number, ...args: string[]) =>
      redis.eval_ro(script, keys, ...args),
    ),
  });
  const deadline = () => Date.now() + 30_000;
  const selection = {
    protocol: 'source-abandonment-v1' as const,
    abandonBefore: '2026-10-07T00:00:00.000Z',
    ownerWebhookEventIds: ['selected-owner'],
    majorBotIds: ['major-1'],
  };
  const source = { chatId: 'chat-a', messageId: 'message-a', userId: 'user-a' };
  const fixtureStats = (calls: string) =>
    `# Commandstats\r\ncmdstat_eval_ro:calls=${calls},usec=100,usec_per_call=10.00,rejected_calls=0,failed_calls=0\r\n`;

  it.each([
    { name: 'absent counter', raw: '# Commandstats\r\n', expected: '# Commandstats\r\n' },
    {
      name: 'counter above Lua safe integer precision',
      raw: fixtureStats('9007199254740993'),
      expected: fixtureStats('9007199254740993'),
    },
    {
      name: 'duplicate counter',
      raw: fixtureStats('10') + fixtureStats('10').replace('# Commandstats\r\n', ''),
      expected: null,
    },
    {
      name: 'malformed fields',
      raw: fixtureStats('10').replace(',failed_calls=0', ''),
      expected: null,
    },
    {
      name: 'internal INFO byte limit',
      raw: `# Commandstats\r\ncmdstat_ping:calls=1,usec=1,usec_per_call=${'1'.repeat(65536)}.00,rejected_calls=0,failed_calls=0\r\n`,
      expected: null,
    },
    {
      name: 'internal INFO line limit',
      raw: '# Commandstats\r\n' + '\r\n'.repeat(511),
      expected: null,
    },
  ])('validates the actual Lua projection: $name', async ({ name, raw, expected }) => {
    // FLAG: Only the INFO input is substituted; execute the exported parser on
    // disposable Redis so Lua escaping, text precision and refusals are real.
    const script = SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT.replace(
      "redis.call('INFO', 'commandstats')",
      JSON.stringify(raw),
    );
    expect(script).not.toBe(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT);
    if (expected === null) {
      await expect(redis.eval_ro(script, 0)).rejects.toThrow('CATALOG_SERVER_COST_UNPROVED');
      return;
    }
    const projected = await redis.eval_ro(script, 0);
    expect(projected).toBe(expected);
    if (name === 'counter above Lua safe integer precision') {
      const unsafeReader = {
        ...reader(),
        multi() {
          const measurement = {
            eval_ro() {
              return measurement;
            },
            async exec() {
              return [
                [null, fixtureStats('10')],
                [null, 1],
                [null, projected],
              ];
            },
          };
          return measurement;
        },
      };
      await expect(readMeasuredSourceCatalogScript(unsafeReader, 'return 1', 0)).rejects.toThrow(
        'CATALOG_SERVER_COST_UNPROVED',
      );
    }
  });

  it('projects real commandstats and measures the complete outer script without Redis calls', async () => {
    const projection = await redis.eval_ro(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT, 0);
    expect(typeof projection).toBe('string');
    expect(Buffer.byteLength(projection as string)).toBeLessThanOrEqual(512);
    expect(projection).toMatch(
      /^# Commandstats\r\n(?:cmdstat_eval_ro:calls=\d+,usec=\d+,usec_per_call=\d+(?:\.\d+)?,rejected_calls=\d+,failed_calls=\d+\r\n)?$/u,
    );
    // FLAG: Pure Lua work is invisible to nested Redis-command timings. The
    // projected two-call delta must include this complete outer EVAL_RO.
    let targetDurationUs = 0;
    const independentlyMeasuredReader = {
      ...reader(),
      multi() {
        const commands: Array<[string, number, ...string[]]> = [];
        const measurement = {
          eval_ro(script: string, keys: number, ...args: string[]) {
            commands.push([script, keys, ...args]);
            return measurement;
          },
          async exec() {
            expect(commands).toHaveLength(3);
            const rows = await redis
              .multi()
              .eval_ro(...commands[0])
              .info('commandstats')
              .eval_ro(...commands[1])
              .info('commandstats')
              .eval_ro(...commands[2])
              .exec();
            expect(rows).toHaveLength(5);
            expect(rows?.every(([error]) => error === null)).toBe(true);
            const targetStats = [rows![1][1], rows![3][1]].map((raw) => {
              expect(typeof raw).toBe('string');
              const match = /^cmdstat_eval_ro:calls=(\d+),usec=(\d+),/mu.exec(raw as string);
              expect(match).not.toBeNull();
              return { calls: Number(match![1]), usec: Number(match![2]) };
            });
            expect(targetStats[1].calls - targetStats[0].calls).toBe(1);
            targetDurationUs = targetStats[1].usec - targetStats[0].usec;
            expect(targetDurationUs).toBeGreaterThan(0);
            return [rows![0], rows![2], rows![4]];
          },
        };
        return measurement;
      },
    };
    const measured = await readMeasuredSourceCatalogScript(
      independentlyMeasuredReader,
      'local sum = 0; for i = 1, 20000 do sum = sum + i end; return sum',
      0,
    );
    expect(measured.reply).toBe(200_010_000);
    expect(measured.serverDurationUs).toBeGreaterThanOrEqual(targetDurationUs);
    expect(measured.serverDurationUs).toBeLessThanOrEqual(50_000);
    expect(measured.measurementBytes).toBeGreaterThan(0);
    expect(measured.measurementBytes).toBeLessThanOrEqual(2 * 512);
    expect(await redis.dbsize()).toBe(0);
  });

  it('finishes a single-step scan at its zero cursor and counts one underlying page', async () => {
    expect(await inventorySourceAbandonmentNamespaces(reader(), deadline())).toMatchObject({
      complete: true,
      issue: null,
      cost: { pages: 1, scanCountHints: 4096, matchedKeys: 0 },
    });
    expect(await redis.dbsize()).toBe(0);
  });

  it('scans a sparse keyspace completely twice while retaining terminal history', async () => {
    for (let offset = 0; offset < 120_000; offset += 2000) {
      const pipeline = redis.pipeline();
      for (let i = offset; i < offset + 2000; i++)
        pipeline.set(
          i < 15_000 ? `bull:photo-duplicates:retained-${i}` : `cache:unrelated:${i}`,
          'kept',
        );
      await pipeline.exec();
    }
    // The terminal hash contains a large payload; the namespace reader must never fetch it.
    await redis.hset('bull:photo-duplicates:retained-hash', 'data', 'x'.repeat(128 * 1024));
    const before = await redis.dbsize();
    let completedPages = 0;
    const readScanCalls = async () => {
      const stats = await redis.info('commandstats');
      const calls = /^cmdstat_scan:calls=(\d+),/mu.exec(stats)?.[1];
      return calls === undefined ? 0n : BigInt(calls);
    };
    const census = async () => {
      const targets: Array<[string, number, ...string[]]> = [];
      const observedReader = {
        ...reader(),
        multi() {
          const commands: Array<[string, number, ...string[]]> = [];
          const transaction = redis.multi();
          const measurement = {
            eval_ro(script: string, keys: number, ...args: string[]) {
              commands.push([script, keys, ...args]);
              transaction.eval_ro(script, keys, ...args);
              return measurement;
            },
            async exec() {
              // FLAG: Observe the unchanged atomic meter/target/meter transaction.
              // INFO outside each complete pass independently counts real SCAN calls.
              expect(commands).toHaveLength(3);
              expect(commands[0]).toEqual([SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT, 0]);
              expect(commands[2]).toEqual([SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT, 0]);
              expect(commands[1]).toEqual([
                SOURCE_ABANDONMENT_NAMESPACE_CATALOG_SCRIPT,
                0,
                expect.stringMatching(/^\d+$/u),
                '1',
              ]);
              targets.push(commands[1]);
              const rows = await transaction.exec();
              completedPages++;
              return rows;
            },
          };
          return measurement;
        },
      };
      const scansBefore = await readScanCalls();
      const proof = await inventorySourceAbandonmentNamespaces(observedReader, deadline());
      const scansAfter = await readScanCalls();
      expect(proof.complete).toBe(true);
      expect(proof.issue).toBeNull();
      expect(targets).toHaveLength(proof.cost.pages);
      expect(scansAfter - scansBefore).toBe(BigInt(proof.cost.pages));
      return proof;
    };
    const contender = new Redis(fixtureUrl, { maxRetriesPerRequest: 0, commandTimeout: 1000 });
    let scanning = true;
    const servicedPages = new Set<number>();
    const independentReads = (async () => {
      while (scanning) {
        expect(await contender.ping()).toBe('PONG');
        servicedPages.add(completedPages);
        await new Promise<void>((done) => setImmediate(done));
      }
    })();
    let first: Awaited<ReturnType<typeof census>>;
    let second: Awaited<ReturnType<typeof census>>;
    try {
      first = await census();
      second = await census();
    } finally {
      scanning = false;
      await independentReads.finally(() => contender.disconnect());
    }
    // FLAG: An independent Redis connection must make progress between catalog
    // pages, while each measured SCAN retains its server-cost and deadline guards.
    expect(
      [...servicedPages].filter((page) => page > 0 && page < completedPages).length,
    ).toBeGreaterThan(1);
    expect(first).toMatchObject({
      complete: true,
      issue: null,
      namespaceKeyCounts: { 'photo-duplicates': 15_001 },
    });
    expect(second.namespaceKeyCounts).toEqual(first.namespaceKeyCounts);
    expect(second.complete).toBe(true);
    expect(first.cost.pages).toBeGreaterThan(1);
    expect(first.cost.serverDurationUs).toBeGreaterThan(0);
    expect(first.cost.maxCallDurationUs).toBeGreaterThan(0);
    expect(first.cost.bytes).toBeLessThan(16 * 1024);
    expect(await redis.dbsize()).toBe(before);
    expect(await redis.get('bull:photo-duplicates:retained-0')).toBe('kept');
    expect(await redis.hstrlen('bull:photo-duplicates:retained-hash', 'data')).toBe(128 * 1024);
  });

  it.each(['wait', 'orphan-job', 'stalled-check'])(
    'rejects unknown namespace without meta: %s',
    async (suffix) => {
      const key = `bull:retired-unknown:${suffix}`;
      if (suffix === 'wait') await redis.rpush(key, 'private-job-id');
      else if (suffix === 'orphan-job') await redis.hset(key, 'data', 'private-payload');
      else await redis.set(key, '1');
      const result = await inventorySourceAbandonmentNamespaces(reader(), deadline());
      expect(result).toMatchObject({ complete: false, issue: 'UNKNOWN_QUEUE_NAMESPACE' });
      expect(JSON.stringify(result)).not.toMatch(/private-job-id|private-payload|orphan-job/);
      expect(await redis.exists(key)).toBe(1);
    },
  );

  it('keeps generation, exact owner, action attribution and independent second-read proofs', async () => {
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set('maxim:webhook-rollout:pause-owner:v1', 'rollout:catalog-native-fence');
    await pipeline.exec();
    const ownerQueue = new Queue('moderation-default-0', { connection: { url: fixtureUrl } });
    const actionQueue = new Queue('max-actions-background', { connection: { url: fixtureUrl } });
    queues.push(ownerQueue, actionQueue);
    await ownerQueue.add(
      'webhook',
      { webhookEventId: 'selected-owner' },
      { jobId: 'selected-owner' },
    );
    await actionQueue.add(
      'action',
      { ...source, actionType: 'DELETE_MESSAGE', idempotencyKey: 'action-a' },
      { jobId: 'child-a', delay: 60_000 },
    );
    const observe = () =>
      inventorySourceAbandonmentRedis(
        reader(),
        selection,
        [source],
        {
          ...LEGACY_RECOVERY_LIVE_BUDGET,
          deadlineAtMs: deadline(),
        },
        resolve,
        'catalog-native-fence',
      );
    const first = await observe();
    const second = await observe();
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(first.catalog?.complete).toBe(true);
    expect(first.children).toMatchObject([{ jobKey: 'action-a', ...source }]);
    expect(second.stableDigest).toBe(first.stableDigest);
    const score = await redis.zscore('bull:max-actions-background:delayed', 'child-a');
    await redis.zadd('bull:max-actions-background:delayed', Number(score) + 4096, 'child-a');
    const changed = await observe();
    expect(changed.issues).toEqual([]);
    expect(changed.catalog?.namespaceKeyCounts).toEqual(first.catalog?.namespaceKeyCounts);
    expect(changed.stableDigest).not.toBe(first.stableDigest);
    await redis.incr('bull:max-actions-background:id');
    expect((await observe()).stableDigest).not.toBe(changed.stableDigest);
    const beforeOwner = await observe();
    await redis.hset('bull:moderation-default-0:selected-owner', 'progress', '1');
    expect((await observe()).stableDigest).not.toBe(beforeOwner.stableDigest);
    for (const name of ['max-actions-background', 'moderation-default-0', 'photo-duplicates']) {
      const beforeOrphan = await observe();
      await redis.hset(`bull:${name}:orphan-fixture`, 'data', '{}');
      expect((await observe()).stableDigest).not.toBe(beforeOrphan.stableDigest);
    }
    for (const name of ['publisher-start', 'publisher-binding-refresh']) {
      await redis.hset(`bull:${name}:meta`, 'version', 'fixture');
      const beforeHeader = await observe();
      await redis.incr(`bull:${name}:id`);
      expect((await observe()).stableDigest).not.toBe(beforeHeader.stableDigest);
    }
  });

  it('authorless channel actions retain exact message proof and reject an attributed user', async () => {
    const channel: SourceAbandonmentRedisSource = {
      chatId: '-200',
      messageId: 'channel-message',
      userId: null,
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    };
    const queue = new Queue('max-actions-background', { connection: { url: fixtureUrl } });
    queues.push(queue);
    const data = {
      chatId: channel.chatId,
      messageId: channel.messageId,
      userId: null as string | null,
      actionType: 'DELETE_MESSAGE',
      idempotencyKey: 'channel-action',
    };
    const job = await queue.add('action', data, { jobId: 'channel-job', delay: 60_000 });
    const observe = () =>
      inventorySourceAbandonmentRedis(
        reader(),
        selection,
        [channel],
        { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: deadline() },
        resolve,
      );
    const first = await observe();
    expect(first.issues).toEqual([]);
    expect(first.children).toEqual([
      {
        jobKey: 'channel-action',
        queueName: queue.name,
        jobPayloadDigest: sourceAbandonmentDigest(data),
        chatId: channel.chatId,
        messageId: channel.messageId,
      },
    ]);
    expect(await job.getState()).toBe('delayed');
    await job.updateData({ ...data, userId: '123' });
    const conflict = await observe();
    expect(conflict.issues[0]?.code).toBe('ACTION_SUBJECT_CONFLICT');
    expect(conflict.children).toEqual([]);
    expect(await job.getState()).toBe('delayed');
  });

  it('authorless channel never proves unrelated FANOUT from a missing user', async () => {
    const channel: SourceAbandonmentRedisSource = {
      chatId: '-200',
      messageId: 'channel-message',
      userId: null,
      sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    };
    const queue = new Queue('global-spammer-denorm', { connection: { url: fixtureUrl } });
    queues.push(queue);
    const data = {
      observationId: 'fanout-observation',
      chatId: '-300',
      userId: '300',
      source: 'FANOUT_HIGH',
      fastPath: false,
    };
    const job = await queue.add('observation', data, { jobId: 'fanout-job', delay: 60_000 });
    const resolveObservation: SourceAbandonmentRedisResolver = async (_kind, keys) => ({
      rows: keys.map((key) => ({
        key,
        row: { ...data, id: data.observationId, messageId: null },
        digest: 'a'.repeat(64),
      })),
      cost: { pages: 1, rows: 1, probes: 1, bytes: 128 },
      plans: [],
      issue: null,
    });
    const result = await inventorySourceAbandonmentRedis(
      reader(),
      selection,
      [channel],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: deadline() },
      resolveObservation,
    );
    expect(result.issues[0]?.code).toBe('OBSERVATION_SOURCE_UNPROVED');
    expect(result.children).toEqual([]);
    expect(await job.getState()).toBe('delayed');
  });

  it('retains real delayed cleanup bytes while requiring its separately resolved parent proof', async () => {
    const context = { moderationNoticeEnvelope: { version: 1 } };
    const marker = {
      version: 2,
      sourceSendJobId: 'completed-parent',
      sourceChatId: '-200',
      sourceMessageId: null,
      sourceUserId: null,
      sourceCreatedAt: '2026-10-01T00:00:00.000Z',
      sourceSendCompletedAt: '2026-10-01T00:00:01.000Z',
      requestedDelayMs: 60_000,
      originBotId: 'major-1',
    };
    const parent = {
      jobId: marker.sourceSendJobId,
      actionType: 'SEND_MESSAGE',
      chatId: marker.sourceChatId,
      messageId: null,
      userId: null,
      sourceTag: 'moderation_notice',
      status: 'SUCCEEDED',
      terminal: true,
      ambiguous: false,
      remoteMessageId: 'confirmed-notice',
      dispatchBotId: marker.originBotId,
      completedAt: new Date(marker.sourceSendCompletedAt),
      metadata: {
        createdAt: marker.sourceCreatedAt,
        autoDeleteDelayMs: marker.requestedDelayMs,
        sendAutoDelete: null,
        hasOptions: true,
        optionKeys: ['textFormat'],
        ledgerContext: context,
      },
    };
    const queue = new Queue('max-actions-background', { connection: { url: fixtureUrl } });
    queues.push(queue);
    await queue.add(
      'action',
      {
        actionType: 'DELETE_MESSAGE',
        idempotencyKey: 'cleanup-delete',
        chatId: marker.sourceChatId,
        messageId: parent.remoteMessageId,
        botId: marker.originBotId,
        sourceTag: 'moderation_notice',
        ledgerContext: context,
        sendAutoDelete: marker,
      },
      { jobId: 'retained-cleanup', delay: 60_000 },
    );
    const key = 'bull:max-actions-background:retained-cleanup';
    const before = await redis.hgetall(key);
    let retainedParent: typeof parent | null = parent;
    const resolver = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => ({
      rows: keys.map((key) => ({
        key,
        row: key === parent.jobId ? retainedParent : null,
        digest: sourceAbandonmentDigest(key === parent.jobId ? retainedParent : null),
      })),
      plans: [],
      cost: { pages: 2, rows: 1, probes: 2, bytes: 256 },
      issue: null,
    }));
    const observe = () =>
      inventorySourceAbandonmentRedis(
        reader(),
        selection,
        [{ ...source, chatId: '-100' }],
        { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: deadline() },
        resolver,
      );
    const first = await observe();
    const second = await observe();
    expect(first.issues).toEqual([]);
    expect(first.children).toEqual([]);
    expect(second.stableDigest).toBe(first.stableDigest);
    expect(resolver.mock.calls.map(([, jobId]) => jobId)).toEqual([
      ['cleanup-delete'],
      ['completed-parent'],
      ['cleanup-delete'],
      ['completed-parent'],
    ]);
    retainedParent = null;
    expect((await observe()).issues).toContainEqual({
      code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
      descriptor: 'redis:max-actions-background',
    });
    expect(await redis.hgetall(key)).toEqual(before);
    expect(await redis.zcard('bull:max-actions-background:delayed')).toBe(1);
  });
});

// FLAG: Queue mutations below belong only to an initially empty disposable local DB.
// Inventory still executes the production EVAL_RO scripts and measured catalog reads.
native('source abandonment inventory ordering on a live Redis queue', () => {
  let redis: Redis;
  let queue: Queue;
  let ownsDatabase = false;
  const queueName = 'max-actions-background';
  const source = { chatId: 'chat-a', messageId: 'message-a', userId: 'user-a' };
  const selection = {
    protocol: 'source-abandonment-v1' as const,
    abandonBefore: '2026-10-07T00:00:00.000Z',
    ownerWebhookEventIds: ['selected-owner'],
    majorBotIds: ['major-1'],
  };

  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Disposable localhost Redis required');
    target.pathname = '/11';
    redis = new Redis(target.toString(), { maxRetriesPerRequest: 0, commandTimeout: 10_000 });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Native ordering DB is already occupied');
    ownsDatabase = true;
    queue = new Queue(queueName, { connection: { url: target.toString() } });
    await queue.waitUntilReady();
  });
  afterEach(async () => {
    if (ownsDatabase) await redis.flushdb();
  });
  afterAll(async () => {
    await queue?.close();
    redis?.disconnect();
  });

  const addAction = (id: string) =>
    queue.add(
      'action',
      { ...source, actionType: 'DELETE_MESSAGE', idempotencyKey: id },
      { jobId: id, delay: 60_000 },
    );
  const fixtureReader = (
    hooks: { duringCatalog?: () => Promise<unknown>; afterHeader?: () => Promise<unknown> } = {},
  ): SourceAbandonmentRedisReader => {
    let catalogHook = hooks.duringCatalog;
    let headerHook = hooks.afterHeader;
    return {
      async eval_ro(script, keys, ...args) {
        const result = await redis.eval_ro(script, keys, ...args);
        if (script.startsWith('-- source-abandonment:headers') && headerHook) {
          const run = headerHook;
          headerHook = undefined;
          await run();
        }
        return result;
      },
      multi() {
        const transaction = redis.multi();
        const measured = {
          eval_ro(script: string, keys: number, ...args: string[]) {
            transaction.eval_ro(script, keys, ...args);
            return measured;
          },
          async exec() {
            if (catalogHook) {
              const run = catalogHook;
              catalogHook = undefined;
              await run();
            }
            return transaction.exec();
          },
        };
        return measured;
      },
    };
  };
  const observe = (reader: SourceAbandonmentRedisReader, nonce?: string) =>
    inventorySourceAbandonmentRedis(
      reader,
      selection,
      [source],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
      resolve,
      nonce,
    );
  const fence = async () => {
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set('maxim:webhook-rollout:pause-owner:v1', 'rollout:ordering-fence');
    await pipeline.exec();
  };

  it('attributes the remaining action when the live queue shrinks during the full catalog', async () => {
    const removed = await addAction('completed-during-catalog');
    await addAction('remaining-child');
    const result = await observe(fixtureReader({ duringCatalog: () => removed.remove() }));

    expect(result.issues).toEqual([]);
    expect(result.catalog?.complete).toBe(true);
    expect(result.queueCounts.find((row) => row.queueName === queueName)?.states[3]).toBe(1);
    expect(result.children).toMatchObject([{ jobKey: 'remaining-child', queueName, ...source }]);
    expect(await queue.getJob('remaining-child')).not.toBeUndefined();
  });

  it('still refuses an action that disappears after the current headers were captured', async () => {
    const removed = await addAction('missing-after-header');
    const result = await observe(fixtureReader({ afterHeader: () => removed.remove() }));

    expect(result.issues).toEqual([
      { code: 'ACTION_PAGE_UNPROVED', descriptor: `redis:${queueName}` },
    ]);
    expect(result.catalog?.complete).toBe(true);
    expect(result.children).toEqual([]);
  });

  it('checks the stopped-operation fence before spending the catalog budget', async () => {
    const result = await observe(fixtureReader(), 'absent-fence');

    expect(result.issues).toEqual([
      { code: 'REDIS_REPLY_UNPROVED', descriptor: 'redis:inventory' },
    ]);
    expect(result.catalog).toBeNull();
    expect(result.children).toEqual([]);
  });

  it('keeps offline headers around the catalog and refuses a changed generation', async () => {
    await fence();
    await addAction('frozen-child');
    const result = await observe(
      fixtureReader({ duringCatalog: () => redis.incr(`bull:${queueName}:id`) }),
      'ordering-fence',
    );

    expect(result.issues).toEqual([
      { code: 'QUEUE_HEADERS_CHANGED', descriptor: expect.any(String) },
    ]);
    expect(result.catalog?.complete).toBe(true);
    expect(result.children).toMatchObject([{ jobKey: 'frozen-child', ...source }]);
  });
});
