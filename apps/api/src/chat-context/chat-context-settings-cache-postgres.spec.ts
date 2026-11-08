import { isDate } from 'node:util/types';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ChatContextCacheService,
  invalidateSharedChatContext,
  type ChatContext,
} from './chat-context-cache.service';
import { chatContextMediaKey } from './chat-context-media-cache';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const loopbackHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];

for (const configuredUrl of [databaseUrl, redisUrl]) {
  if (configuredUrl && !loopbackHosts.includes(new URL(configuredUrl).hostname)) {
    throw new Error('Chat settings cache tests require disposable loopback stores');
  }
}
if (databaseUrl && !new URL(databaseUrl).pathname.includes('race_test')) {
  throw new Error('Chat settings cache tests require a disposable race_test database');
}
const native = databaseUrl && redisUrl ? describe : describe.skip;
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native cache barrier timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createDatabase() {
  return new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
    log: [{ emit: 'event', level: 'query' }],
  });
}

native('verified ChatSettings templates with PostgreSQL and Redis', () => {
  let db: ReturnType<typeof createDatabase>;
  let redis: Redis;
  let chatId: string;
  let userId: string;
  let caches: ChatContextCacheService[];
  let ownedRedisKeys: Set<string>;
  let heavySettingsSelects = 0;
  const routing = {
    rememberChatBotBinding: jest.fn(),
    forgetChatBotBinding: jest.fn(),
    forgetAllChatBotBindings: jest.fn(),
  } satisfies Pick<
    MaxBotLinkService,
    'rememberChatBotBinding' | 'forgetChatBotBinding' | 'forgetAllChatBotBindings'
  >;

  beforeAll(async () => {
    db = createDatabase();
    db.$on('query', ({ query }) => {
      if (
        query.trimStart().startsWith('SELECT') &&
        query.includes('"chat_settings"') &&
        query.includes('"bot_speech_media"')
      ) {
        heavySettingsSelects += 1;
      }
    });
    await db.$connect();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  beforeEach(async () => {
    chatId = `verified-settings-context-${randomUUID()}`;
    userId = `verified-settings-admin-${randomUUID()}`;
    caches = [];
    ownedRedisKeys = new Set([
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.cachedContextRevisionKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
      ChatContextCacheService.adminAccessKey(chatId, userId),
      ChatContextCacheService.adminAccessEpochKey(chatId, userId),
    ]);
    routing.rememberChatBotBinding.mockClear();
    routing.forgetChatBotBinding.mockClear();
    routing.forgetAllChatBotBindings.mockClear();
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Original title',
        botId: 'original-bot',
        primaryBotId: 'original-bot',
        settings: {
          create: {
            antiSpamEnabled: false,
            reportsAliases: ['report'],
            botSpeechMedia: { fixture: chatId, nested: { text: 'original' } },
          },
        },
        admins: { create: { userId } },
        domains: { create: { domain: 'before.example' } },
        rules: {
          create: {
            publishedUrl: 'https://example.invalid/before',
            publishedMessageId: 'before-message',
          },
        },
      },
    });
    heavySettingsSelects = 0;
  });

  afterEach(async () => {
    for (const cache of caches) await cache.onModuleDestroy();
    // FLAG: Exact fixture keys and rows only; never clear a store shared by native suites.
    await redis.del(...ownedRedisKeys);
    await db.chat.delete({ where: { id: chatId } });
  });

  afterAll(async () => {
    await redis?.quit();
    await db?.$disconnect();
  });

  function makeCache(
    database: PrismaService = db as unknown as PrismaService,
    localTtlMs = 40,
    limits: Record<string, number> = {},
  ): ChatContextCacheService {
    const cache = new ChatContextCacheService(
      database,
      new ConfigService({
        REDIS_URL: redisUrl,
        CHAT_CONTEXT_LOCAL_CACHE_TTL_MS: localTtlMs,
        ...limits,
      }),
      routing as unknown as MaxBotLinkService,
    );
    caches.push(cache);
    return cache;
  }

  async function invalidateAndObserve(cache: ChatContextCacheService, id = chatId): Promise<void> {
    const subscriber = (cache as unknown as { subscriber: Redis }).subscriber;
    const observed = deferred();
    const onMessage = (channel: string, payload: string): void => {
      if (channel !== 'chat:context:invalidate:v1') return;
      try {
        const event = JSON.parse(payload) as { chatId?: unknown; reason?: unknown };
        if (event.chatId === id && event.reason === 'explicit') observed.resolve();
      } catch {
        // Ignore publications that do not describe this fixture's explicit invalidation.
      }
    };
    subscriber.on('message', onMessage);
    try {
      await cache.invalidate(id);
      // FLAG: The command reply and Pub/Sub echo use independent sockets. Finish the actual
      // local invalidation before measuring one warm refresh, without hiding generation races.
      await within(observed.promise);
    } finally {
      subscriber.off('message', onMessage);
    }
  }

  it('uses a bounded configured fleet budget and refreshes SQL proofs without reloading unchanged settings', async () => {
    const ids = Array.from({ length: 24 }, (_, index) => `${chatId}-fleet-${index}`);
    const cache = makeCache(undefined, 40, {
      CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_BYTES: 2 * 1024 * 1024,
      CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_MEDIA_BYTES: 256 * 1024,
      CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_ENTRIES: 32,
    });
    await cache.onModuleInit();
    try {
      for (const id of ids) {
        for (const key of [
          ChatContextCacheService.cacheKey(id),
          ChatContextCacheService.cachedContextRevisionKey(id),
          ChatContextCacheService.chatContextRevisionKey(id),
        ])
          ownedRedisKeys.add(key);
        await db.chat.create({
          data: {
            id,
            title: 'Fleet fixture',
            settings: { create: { reportsAliases: ['x'.repeat(16_000)] } },
            admins: { create: { userId } },
          },
        });
        await cache.getChatContext(id);
      }
      expect(heavySettingsSelects).toBe(ids.length);
      expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
        entries: ids.length,
        maxBytes: 2 * 1024 * 1024,
        maxEntries: 32,
        segments: { maxCompactBytes: 1792 * 1024, maxMediaBytes: 256 * 1024 },
      });
      for (const id of ids) {
        await invalidateAndObserve(cache, id);
        expect((await cache.getChatContext(id)).adminUserIds).toEqual([userId]);
      }
      expect(heavySettingsSelects).toBe(ids.length);
      expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
        reuses: ids.length,
        capacityEvictions: 0,
      });
      await db.chatSettings.update({
        where: { chatId: ids[0]! },
        data: { reportsAliases: ['changed'] },
      });
      await db.chatAdminAllowlist.deleteMany({ where: { chatId: ids[0]! } });
      await invalidateAndObserve(cache, ids[0]!);
      expect(await cache.getChatContext(ids[0]!)).toMatchObject({
        settings: { reportsAliases: ['changed'] },
        adminUserIds: [],
      });
      expect(heavySettingsSelects).toBe(ids.length + 1);
    } finally {
      await db.chat.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('reuses unchanged settings after refreshing title, bot binding, administrators, domains and rules', async () => {
    const cache = makeCache();
    await cache.onModuleInit();
    const first = await cache.getChatContext(chatId);
    expect(first.adminUserIds).toEqual([userId]);
    expect(heavySettingsSelects).toBe(1);

    await db.$transaction([
      db.chat.update({
        where: { id: chatId },
        data: { title: 'Fresh title', botId: 'fresh-bot', primaryBotId: 'fresh-bot' },
      }),
      db.chatAdminAllowlist.deleteMany({ where: { chatId } }),
      db.chatAdminAllowlist.create({ data: { chatId, userId: `${userId}-new` } }),
      db.domainAllowlist.deleteMany({ where: { chatId } }),
      db.domainAllowlist.create({ data: { chatId, domain: 'after.example' } }),
      db.chatRules.update({
        where: { chatId },
        data: {
          publishedUrl: 'https://example.invalid/after',
          publishedMessageId: 'after-message',
        },
      }),
    ]);
    await invalidateAndObserve(cache);
    const refreshed = await cache.getChatContext(chatId);

    expect(refreshed).toMatchObject({
      title: 'Fresh title',
      settings: first.settings,
      adminUserIds: [`${userId}-new`],
      domainAllowlist: ['after.example'],
      rulesPublishedUrl: 'https://example.invalid/after',
      rulesPublishedMessageId: 'after-message',
    });
    expect(routing.rememberChatBotBinding).toHaveBeenLastCalledWith(chatId, 'fresh-bot');
    expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
      fullLoads: 1,
      shellReads: 1,
      reuses: 1,
    });
    expect(heavySettingsSelects).toBe(1);
  });

  it('observes a raw settings update with unchanged updatedAt at the original deadline despite continuous title changes', async () => {
    const localTtlMs = 40;
    const cache = makeCache(undefined, localTtlMs);
    await cache.onModuleInit();
    const initial = await cache.getChatContext(chatId);
    const originalUpdatedAt = initial.settings.updatedAt;
    const key = ChatContextCacheService.cacheKey(chatId);
    const revisionKey = ChatContextCacheService.cachedContextRevisionKey(chatId);
    const originalDeadline = Date.now() + 600;
    await redis.pexpireat(key, originalDeadline);
    await redis.pexpireat(revisionKey, originalDeadline);
    await db.$executeRaw`
      UPDATE chat_settings SET anti_spam_enabled = TRUE, updated_at = updated_at
      WHERE chat_id = ${chatId}
    `;
    const stored = await db.chatSettings.findUniqueOrThrow({
      where: { chatId },
      select: { updatedAt: true },
    });
    expect(stored.updatedAt).toEqual(originalUpdatedAt);

    let latest: ChatContext = initial;
    let titleChanges = 0;
    const checkDeadline = originalDeadline + localTtlMs + 1000;
    while (!latest.settings.antiSpamEnabled && Date.now() < checkDeadline) {
      await delay(20);
      latest = await cache.getChatContext(chatId, `Continuously changing title ${titleChanges++}`);
      if (!latest.settings.antiSpamEnabled && Date.now() < originalDeadline - 50) {
        const remaining = await redis.pttl(key);
        expect(remaining).toBeGreaterThan(0);
        expect(Date.now() + remaining).toBeLessThanOrEqual(originalDeadline + 50);
        expect(heavySettingsSelects).toBe(1);
      }
    }
    expect(titleChanges).toBeGreaterThan(1);
    expect(latest.settings.antiSpamEnabled).toBe(true);
    expect(Date.now()).toBeGreaterThanOrEqual(originalDeadline);
    expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
      fullLoads: 2,
      shellReads: 1,
      reuses: 0,
    });
    expect(heavySettingsSelects).toBe(2);
  });

  it('removes an expired domain on a warm source refresh without changing settings or the domain row', async () => {
    const expiresAt = new Date(Date.now() + 1000);
    await db.domainAllowlist.update({
      where: { chatId_domain: { chatId, domain: 'before.example' } },
      data: { removeAfterAt: expiresAt },
    });
    const cache = makeCache();
    await cache.onModuleInit();
    expect((await cache.getChatContext(chatId)).domainAllowlist).toEqual(['before.example']);
    await delay(Math.max(0, expiresAt.getTime() - Date.now() + 20));
    await invalidateAndObserve(cache);

    expect((await cache.getChatContext(chatId)).domainAllowlist).toEqual([]);
    expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
      fullLoads: 1,
      shellReads: 1,
      reuses: 1,
    });
    expect(heavySettingsSelects).toBe(1);
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(1);
  });

  it('rejects a stale warm SQL shell after another process commits an access denial without Pub/Sub delivery', async () => {
    const captured = deferred();
    const resume = deferred();
    let pauseNext = false;
    let intercepted = false;
    const paused = db.$extends({
      query: {
        async $queryRaw({ args, query }) {
          const rows = await query(args);
          if (pauseNext && !intercepted) {
            intercepted = true;
            captured.resolve();
            await resume.promise;
          }
          return rows;
        },
      },
    });
    // FLAG: This reader deliberately never subscribes; the distributed revision CAS must
    // reject its actual old SQL snapshot even when local Pub/Sub invalidation is lost.
    const reader = makeCache(paused as unknown as PrismaService);
    const writer = makeCache();
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([userId]);
    pauseNext = true;
    await reader.invalidate(chatId);
    const reading = reader.getChatContext(chatId);
    try {
      await within(captured.promise);
      await db.chatAdminAllowlist.delete({ where: { chatId_userId: { chatId, userId } } });
      expect(
        await writer.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt: new Date(),
        }),
      ).toBe(true);
      expect(await redis.get(ChatContextCacheService.cacheKey(chatId))).toBeNull();
      resume.resolve();

      const result = await within(reading);
      expect(result.adminUserIds).toEqual([]);
      expect(reader.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
        fullLoads: 1,
        shellReads: 2,
        reuses: 2,
      });
      expect(heavySettingsSelects).toBe(1);
      const stored = JSON.parse((await redis.get(ChatContextCacheService.cacheKey(chatId)))!);
      expect(stored.adminUserIds).toEqual([]);
      expect(await redis.get(ChatContextCacheService.cachedContextRevisionKey(chatId))).toBe(
        await redis.get(ChatContextCacheService.chatContextRevisionKey(chatId)),
      );
    } finally {
      resume.resolve();
      await within(reading).catch(() => undefined);
    }
  });

  it('retires a delayed PostgreSQL shell and its bot binding across a real subscription gap', async () => {
    const captured = deferred();
    const resume = deferred();
    let pauseNext = false;
    const paused = db.$extends({
      query: {
        async $queryRaw({ args, query }) {
          const rows = await query(args);
          if (pauseNext) {
            pauseNext = false;
            captured.resolve();
            await resume.promise;
          }
          return rows;
        },
      },
    });
    const reader = makeCache(paused as unknown as PrismaService, 30_000);
    await reader.onModuleInit();
    expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([userId]);
    await invalidateAndObserve(reader);
    routing.rememberChatBotBinding.mockClear();
    pauseNext = true;
    const reading = reader.getChatContext(chatId);
    const subscriber = (reader as unknown as { subscriber: Redis }).subscriber;
    try {
      await within(captured.promise);
      const closed = new Promise<void>((resolve) => subscriber.once('close', () => resolve()));
      subscriber.disconnect(false);
      await within(closed);
      await db.$transaction([
        db.chat.update({
          where: { id: chatId },
          data: { botId: 'fresh-bot', primaryBotId: 'fresh-bot' },
        }),
        db.chatAdminAllowlist.deleteMany({ where: { chatId } }),
      ]);
      await invalidateSharedChatContext(redis, chatId);
      const resets = routing.forgetAllChatBotBindings.mock.calls.length;
      await within(subscriber.connect());
      await within(
        (async () => {
          const deadline = Date.now() + 5_000;
          while (routing.forgetAllChatBotBindings.mock.calls.length <= resets) {
            if (Date.now() >= deadline)
              throw new Error('Native resubscribe acknowledgement missing');
            await delay(5);
          }
        })(),
      );
      resume.resolve();

      expect((await within(reading)).adminUserIds).toEqual([]);
      expect((await reader.getChatContext(chatId)).adminUserIds).toEqual([]);
      expect(routing.rememberChatBotBinding).not.toHaveBeenCalledWith(chatId, 'original-bot');
      expect(routing.rememberChatBotBinding).toHaveBeenLastCalledWith(chatId, 'fresh-bot');
      expect(reader.getLocalCacheSnapshot()).toMatchObject({
        entries: 1,
        settingsTemplates: { entries: 1, fullLoads: 1 },
      });
      expect(heavySettingsSelects).toBe(1);
    } finally {
      resume.resolve();
      if (subscriber.status === 'end') await within(subscriber.connect());
      await within(reading).catch(() => undefined);
    }
  });

  it('isolates both a full-source result and later warm results from the retained template', async () => {
    const cache = makeCache();
    await cache.onModuleInit();
    const first = await cache.getChatContext(chatId);
    const expected = structuredClone(first.settings);
    first.settings.reportsAliases.push('full-source mutation');
    first.settings.botSpeechMedia = { corrupted: true };
    first.settings.createdAt.setTime(0);
    await invalidateAndObserve(cache);

    const warm = await cache.getChatContext(chatId);
    expect(warm.settings).toEqual(expected);
    warm.settings.reportsAliases.push('warm-result mutation');
    (warm.settings.botSpeechMedia as { nested: { text: string } }).nested.text = 'corrupted';
    warm.settings.updatedAt.setTime(0);
    await invalidateAndObserve(cache);

    const next = await cache.getChatContext(chatId);
    expect(next.settings).toEqual(expected);
    expect(isDate(next.settings.createdAt)).toBe(true);
    expect(isDate(next.settings.updatedAt)).toBe(true);
    expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
      fullLoads: 1,
      shellReads: 2,
      reuses: 2,
    });
    expect(heavySettingsSelects).toBe(1);
  });

  it.each([
    { size: 100_000, retained: true },
    { size: 1_100_000, retained: false },
  ])(
    'preserves complete media and SQL freshness with retention=$retained',
    async ({ size, retained }) => {
      const media = { fixture: chatId, base64: 'm'.repeat(size), tags: ['original'] };
      await db.chatSettings.update({ where: { chatId }, data: { botSpeechMedia: media } });
      const cache = makeCache();
      await cache.onModuleInit();
      const trackMedia = async () => {
        const raw = await redis.get(ChatContextCacheService.cacheKey(chatId));
        const envelope = JSON.parse(raw!) as {
          __maximMedia: { fields: { botSpeechMedia: { sha256: string } } };
        };
        ownedRedisKeys.add(chatContextMediaKey(envelope.__maximMedia.fields.botSpeechMedia.sha256));
      };
      const first = await cache.getChatContext(chatId);
      await trackMedia();
      expect(first.settings.botSpeechMedia).toEqual(media);
      (first.settings.botSpeechMedia as { tags: string[] }).tags.push('caller mutation');
      await invalidateAndObserve(cache);
      expect((await cache.getChatContext(chatId)).settings.botSpeechMedia).toEqual(media);
      expect(cache.getLocalCacheSnapshot().settingsTemplates).toMatchObject({
        fullLoads: retained ? 1 : 2,
        reuses: retained ? 1 : 0,
        oversizedSkips: retained ? 0 : 2,
        segments: { mediaEntries: retained ? 1 : 0 },
      });
      expect(heavySettingsSelects).toBe(retained ? 1 : 2);

      const replacement = { fixture: chatId, base64: 'n'.repeat(size), tags: ['updated'] };
      await db.$executeRaw`
      UPDATE chat_settings SET bot_speech_media = ${JSON.stringify(replacement)}::jsonb,
        updated_at = updated_at WHERE chat_id = ${chatId}
    `;
      await invalidateAndObserve(cache);
      const updated = await cache.getChatContext(chatId);
      await trackMedia();
      expect(updated.settings.botSpeechMedia).toEqual(replacement);
      expect(updated.settings.updatedAt).toEqual(first.settings.updatedAt);
      expect(heavySettingsSelects).toBe(retained ? 2 : 3);
    },
  );

  it.each(['missing', 'corrupt'] as const)(
    'returns complete large settings from PostgreSQL when a shared media blob is %s',
    async (mode) => {
      const media = {
        greetingBotMessageText: {
          base64: 'm'.repeat(1_000_000),
          mimeType: 'image/png',
          fileName: `${chatId}.png`,
        },
      };
      await db.chatSettings.update({ where: { chatId }, data: { botSpeechMedia: media } });
      const first = makeCache();
      await first.onModuleInit();
      const loaded = await first.getChatContext(chatId);
      const raw = (await redis.get(ChatContextCacheService.cacheKey(chatId)))!;
      const envelope = JSON.parse(raw) as {
        __maximMedia: { fields: { botSpeechMedia: { sha256: string } } };
      };
      const blobKey = chatContextMediaKey(envelope.__maximMedia.fields.botSpeechMedia.sha256);
      ownedRedisKeys.add(blobKey);
      expect(raw.length).toBeLessThan(64 * 1024);
      expect(loaded.settings.botSpeechMedia).toEqual(media);
      if (mode === 'missing') await redis.del(blobKey);
      else await redis.set(blobKey, 'invalid fixture bytes', 'EX', 60);

      const second = makeCache();
      await second.onModuleInit();
      const rebuilt = await second.getChatContext(chatId);
      expect(rebuilt.settings).toEqual(loaded.settings);
      expect(rebuilt).not.toHaveProperty('__maximMedia');
      expect(JSON.parse((await redis.get(blobKey))!)).toEqual(media);
      expect(second.getLocalCacheSnapshot()).toMatchObject({
        activity: { redisDecodeFailures: 1, sourceLoads: 1 },
        settingsTemplates: { fullLoads: 1, reuses: 0 },
      });
      expect(heavySettingsSelects).toBe(2);
    },
  );
});
