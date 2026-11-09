import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { withChatContextSourceFixture } from './__tests__/chat-context-source.fixture';
import { ChatContextCacheService, invalidateSharedChatContext } from './chat-context-cache.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const loopbackHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
if (redisUrl && !loopbackHosts.includes(new URL(redisUrl).hostname)) {
  throw new Error('Chat context subscriber tests require disposable loopback Redis');
}
const native = redisUrl ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native subscriber barrier timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native subscriber state timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

type RedisSnapshotReader = {
  readRedisStringsWithin: (
    keys: readonly string[],
    timeoutMs: number,
  ) => Promise<Array<string | null> | null>;
};

native('chat context invalidation subscription on native Redis', () => {
  let inspector: Redis;
  let reader: ChatContextCacheService;
  let subscriber: Redis;
  let chatId: string;
  let sourceRevision: number;
  const routing = {
    rememberChatBotBinding: jest.fn(),
    forgetChatBotBinding: jest.fn(),
    forgetAllChatBotBindings: jest.fn(),
  } satisfies Pick<
    MaxBotLinkService,
    'rememberChatBotBinding' | 'forgetChatBotBinding' | 'forgetAllChatBotBindings'
  >;

  beforeEach(async () => {
    chatId = `context-subscriber-${randomUUID()}`;
    sourceRevision = 0;
    jest.clearAllMocks();
    inspector = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await inspector.ping();
    reader = new ChatContextCacheService(
      withChatContextSourceFixture({
        chat: {
          findUnique: jest.fn(async () => ({
            id: chatId,
            title: 'Subscriber fixture',
            settings: { linkRulesPolicy: null, stopWordsRevision: sourceRevision },
            admins: sourceRevision === 0 ? [{ userId: 'removed-admin' }] : [],
            domains: [],
            rules: null,
          })),
        },
      }),
      new ConfigService({ REDIS_URL: redisUrl }),
      routing as unknown as MaxBotLinkService,
    );
    subscriber = (reader as unknown as { subscriber: Redis }).subscriber;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (subscriber.status === 'end') await within(subscriber.connect());
    await reader.onModuleDestroy();
    await inspector.del(
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.cachedContextRevisionKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
    );
    await inspector.quit();
  });

  async function seed(revision: number): Promise<void> {
    sourceRevision = revision;
    await inspector
      .multi()
      .set(
        ChatContextCacheService.cacheKey(chatId),
        JSON.stringify({
          chatId,
          title: 'Subscriber fixture',
          settings: { linkRulesPolicy: null, stopWordsRevision: revision },
          domainAllowlist: [],
          adminUserIds: revision === 0 ? ['removed-admin'] : [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        'EX',
        60,
      )
      .set(ChatContextCacheService.cachedContextRevisionKey(chatId), String(revision), 'EX', 60)
      .set(ChatContextCacheService.chatContextRevisionKey(chatId), String(revision))
      .exec();
  }

  async function disconnectSubscriber(): Promise<void> {
    const closed = new Promise<void>((resolve) => subscriber.once('close', () => resolve()));
    subscriber.disconnect(false);
    await within(closed);
  }

  function holdNextSubscription() {
    const captured = deferred();
    const resume = deferred();
    const target = subscriber as unknown as { subscribe: (channel: string) => Promise<unknown> };
    const subscribe = target.subscribe.bind(subscriber);
    const spy = jest.spyOn(target, 'subscribe').mockImplementation(async (channel) => {
      const result = await subscribe(channel);
      captured.resolve();
      await resume.promise;
      return result;
    });
    return { captured, resume, spy };
  }

  it('bypasses L1 before startup and until the real subscription acknowledgement is accepted', async () => {
    await seed(0);
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual(['removed-admin']);
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual(['removed-admin']);
    expect(reader.getLocalCacheSnapshot()).toMatchObject({ entries: 0, writes: 0, hits: 0 });

    const held = holdNextSubscription();
    const starting = reader.onModuleInit();
    try {
      await within(held.captured.promise);
      await reader.getChatContext(chatId);
      expect(reader.getLocalCacheSnapshot()).toMatchObject({ entries: 0, writes: 0, hits: 0 });
      await seed(1);
      held.resume.resolve();
      await within(starting);

      expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
      const reads = reader.getLocalCacheSnapshot().activity.redisReads;
      expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
      expect(reader.getLocalCacheSnapshot()).toMatchObject({
        entries: 1,
        writes: 1,
        hits: 1,
        activity: { redisReads: reads },
      });
    } finally {
      held.resume.resolve();
      await within(starting).catch(() => undefined);
    }
  });

  it('clears L1 and bindings on a real gap and keeps L1 bypassed until resubscribe acknowledgement', async () => {
    await reader.onModuleInit();
    await seed(0);
    await reader.getChatContext(chatId);
    const warm = reader.getLocalCacheSnapshot();
    expect(warm.entries).toBe(1);
    routing.forgetAllChatBotBindings.mockClear();

    await disconnectSubscriber();
    expect(reader.getLocalCacheSnapshot().entries).toBe(0);
    expect(routing.forgetAllChatBotBindings).toHaveBeenCalled();
    await invalidateSharedChatContext(inspector, chatId);
    await seed(1);
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
    expect(reader.getLocalCacheSnapshot()).toMatchObject({
      entries: 0,
      writes: warm.writes,
      hits: warm.hits,
    });

    const held = holdNextSubscription();
    const reconnecting = subscriber.connect();
    try {
      await within(held.captured.promise);
      await within(reconnecting);
      expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
      expect(reader.getLocalCacheSnapshot().entries).toBe(0);
      const resets = routing.forgetAllChatBotBindings.mock.calls.length;
      const ttl = await inspector.pttl(ChatContextCacheService.cacheKey(chatId));
      held.resume.resolve();
      await waitUntil(() => routing.forgetAllChatBotBindings.mock.calls.length > resets);

      expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
      expect(reader.getLocalCacheSnapshot().entries).toBe(1);
      const reads = reader.getLocalCacheSnapshot().activity.redisReads;
      await reader.getChatContext(chatId);
      expect(reader.getLocalCacheSnapshot().activity.redisReads).toBe(reads);
      expect(await inspector.pttl(ChatContextCacheService.cacheKey(chatId))).toBeLessThanOrEqual(
        ttl,
      );
    } finally {
      held.resume.resolve();
      await within(reconnecting).catch(() => undefined);
    }
  });

  it.each(['before gap', 'during gap'] as const)(
    'discards a real Redis snapshot captured %s when it settles after resubscribe',
    async (when) => {
      await reader.onModuleInit();
      await seed(0);
      if (when === 'during gap') await disconnectSubscriber();
      const captured = deferred();
      const resume = deferred();
      const target = reader as unknown as RedisSnapshotReader;
      const read = target.readRedisStringsWithin.bind(reader);
      const delayed = jest
        .spyOn(target, 'readRedisStringsWithin')
        .mockImplementationOnce(async (keys, timeoutMs) => {
          // FLAG: Delay after the actual Redis read and its timeout have settled. The captured
          // response is real; this barrier cannot accidentally turn the race into a timeout.
          const result = await read(keys, timeoutMs);
          captured.resolve();
          await resume.promise;
          return result;
        });
      const reading = reader.getChatContext(chatId);
      try {
        await within(captured.promise);
        if (when === 'before gap') await disconnectSubscriber();
        await invalidateSharedChatContext(inspector, chatId);
        await seed(1);
        const resets = routing.forgetAllChatBotBindings.mock.calls.length;
        await within(subscriber.connect());
        await waitUntil(() => routing.forgetAllChatBotBindings.mock.calls.length > resets);
        resume.resolve();

        expect((await within(reading)).adminUserIds).toEqual([]);
        expect(reader.getLocalCacheSnapshot().entries).toBe(1);
        expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
        expect(delayed.mock.calls.length).toBeGreaterThan(1);
      } finally {
        resume.resolve();
        await within(reading).catch(() => undefined);
      }
    },
  );
});
