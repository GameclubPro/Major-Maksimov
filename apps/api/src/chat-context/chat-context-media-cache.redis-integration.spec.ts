import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ChatContextCacheService, invalidateSharedChatContext } from './chat-context-cache.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const localRedis = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(redisUrl).hostname);
  } catch {
    return false;
  }
})();
const describeRedis = localRedis ? describe : describe.skip;

describeRedis('chat context media payload isolation', () => {
  it('keeps full bot images while access changes and cross-process context writes stay small', async () => {
    const chatId = `media-context-${randomUUID()}`;
    const userId = `media-admin-${randomUUID()}`;
    const media = {
      greetingBotMessageText: {
        base64: 'x'.repeat(7_500_000),
        mimeType: 'image/jpeg',
        fileName: 'greeting.jpg',
      },
    };
    const row = {
      id: chatId,
      title: 'Media community',
      settings: { chatId, linkRulesPolicy: null, botSpeechMedia: media, stopWordsMedia: {} },
      admins: [],
      domains: [],
      rules: null,
    };
    const firstDb = { chat: { findUnique: jest.fn().mockResolvedValue(row) } };
    const secondDb = { chat: { findUnique: jest.fn().mockResolvedValue(row) } };
    const config = { getOrThrow: () => redisUrl };
    const routes = { forgetChatBotBinding: jest.fn() };
    const first = new ChatContextCacheService(firstDb as never, config as never, routes as never);
    const second = new ChatContextCacheService(secondDb as never, config as never, routes as never);
    const inspector = new Redis(redisUrl);
    const key = ChatContextCacheService.cacheKey(chatId);
    const retainedBlobKeys = new Set<string>();
    try {
      await first.onModuleInit();
      await second.onModuleInit();
      await inspector.set(
        ChatContextCacheService.legacyCacheKey(chatId),
        'legacy context',
        'EX',
        60,
      );
      expect((await first.getChatContext(chatId)).settings.botSpeechMedia).toEqual(media);
      expect(await inspector.strlen(key)).toBeLessThan(64 * 1024);
      expect(await inspector.exists(ChatContextCacheService.legacyCacheKey(chatId))).toBe(0);
      const refs = JSON.parse((await inspector.get(key))!).__maximMedia.fields;
      for (const ref of Object.values(refs)) {
        retainedBlobKeys.add(`chat:context:media:v1:${(ref as { sha256: string }).sha256}`);
      }
      expect((await second.getChatContext(chatId)).settings.botSpeechMedia).toEqual(media);
      expect(secondDb.chat.findUnique).not.toHaveBeenCalled();
      await first.applyAdminAccessEpochMutation({
        chatId,
        userId,
        state: 'user_denied',
        eventAt: new Date(),
      });
      expect(await inspector.strlen(key)).toBeLessThan(64 * 1024);
      await second.replaceChatAdminUsers(chatId, [userId]);
      expect(await inspector.strlen(key)).toBeLessThan(64 * 1024);
      await inspector.set(
        ChatContextCacheService.legacyCacheKey(chatId),
        'legacy context',
        'EX',
        60,
      );
      await invalidateSharedChatContext(inspector, chatId);
      expect(await inspector.exists(key, ChatContextCacheService.legacyCacheKey(chatId))).toBe(0);
    } finally {
      const raw = await inspector.get(key);
      const refs = raw ? JSON.parse(raw).__maximMedia?.fields : undefined;
      const blobKeys = Object.values(refs ?? {}).map(
        (ref) => `chat:context:media:v1:${(ref as { sha256: string }).sha256}`,
      );
      await inspector.del(
        key,
        `chat:context:v3:${chatId}`,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.adminAccessKey(chatId, userId),
        ChatContextCacheService.adminAccessEpochKey(chatId, userId),
        ...blobKeys,
        ...retainedBlobKeys,
      );
      await first.onModuleDestroy();
      await second.onModuleDestroy();
      await inspector.quit();
    }
  });
});

describeRedis('chat context media recovery and access fences', () => {
  it.each(['missing', 'corrupt', 'timeout'])(
    'reloads full SQL settings for %s media without losing the image',
    async (mode) => {
      const chatId = `media-recovery-${randomUUID()}`;
      const media = {
        greetingBotMessageText: { base64: 'r'.repeat(100_000), mimeType: 'image/png' },
      };
      const row = {
        id: chatId,
        title: 'Recovery',
        settings: { chatId, linkRulesPolicy: null, botSpeechMedia: media },
        domains: [],
        admins: [],
        rules: null,
      };
      const first = new ChatContextCacheService(
        { chat: { findUnique: jest.fn().mockResolvedValue(row) } } as never,
        { getOrThrow: () => redisUrl } as never,
        {} as never,
      );
      const secondDb = { chat: { findUnique: jest.fn().mockResolvedValue(row) } };
      const second = new ChatContextCacheService(
        secondDb as never,
        { getOrThrow: () => redisUrl } as never,
        {} as never,
      );
      const inspector = new Redis(redisUrl);
      const key = ChatContextCacheService.cacheKey(chatId);
      let blobKey = '';
      try {
        await first.getChatContext(chatId);
        const value = JSON.parse((await inspector.get(key))!);
        blobKey = `chat:context:media:v1:${value.__maximMedia.fields.botSpeechMedia.sha256}`;
        if (mode === 'missing') await inspector.del(blobKey);
        else if (mode === 'corrupt') await inspector.set(blobKey, 'invalid cache bytes', 'EX', 60);
        else {
          const readerRedis = (second as unknown as { redis: Redis }).redis;
          const originalGet = readerRedis.get.bind(readerRedis);
          jest
            .spyOn(readerRedis, 'get')
            .mockImplementation((requestedKey) =>
              requestedKey === blobKey ? new Promise(() => undefined) : originalGet(requestedKey),
            );
        }
        expect((await second.getChatContext(chatId)).settings.botSpeechMedia).toEqual(media);
        expect(secondDb.chat.findUnique).toHaveBeenCalledTimes(1);
        expect(JSON.parse((await inspector.get(blobKey))!)).toEqual(media);
      } finally {
        await inspector.del(
          key,
          ChatContextCacheService.legacyCacheKey(chatId),
          ChatContextCacheService.chatContextRevisionKey(chatId),
          ...(blobKey ? [blobKey] : []),
        );
        await first.onModuleDestroy();
        await second.onModuleDestroy();
        await inspector.quit();
      }
    },
  );

  it('does not restore an administrator revoked while a reader hydrates an image', async () => {
    const chatId = `media-revocation-${randomUUID()}`;
    const userId = `admin-${randomUUID()}`;
    const media = {
      greetingBotMessageText: { base64: 'f'.repeat(100_000), mimeType: 'image/png' },
    };
    const row = {
      id: chatId,
      title: 'Fenced',
      settings: { chatId, linkRulesPolicy: null, botSpeechMedia: media },
      domains: [],
      admins: [{ userId }],
      rules: null,
    };
    const db = { chat: { findUnique: jest.fn().mockImplementation(async () => row) } };
    const config = { getOrThrow: () => redisUrl };
    const routes = { forgetChatBotBinding: jest.fn() };
    const first = new ChatContextCacheService(db as never, config as never, routes as never);
    const second = new ChatContextCacheService(db as never, config as never, routes as never);
    const inspector = new Redis(redisUrl);
    const secondInternals = second as unknown as { redis: Redis; subscriber: Redis };
    let resume!: () => void;
    let observed!: () => void;
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const key = ChatContextCacheService.cacheKey(chatId);
    let blobKey = '';
    let reading: ReturnType<ChatContextCacheService['getChatContext']> | undefined;
    try {
      await first.onModuleInit();
      await second.onModuleInit();
      await first.getChatContext(chatId);
      const raw = (await inspector.get(key))!;
      blobKey = `chat:context:media:v1:${JSON.parse(raw).__maximMedia.fields.botSpeechMedia.sha256}`;
      const originalGet = secondInternals.redis.get.bind(secondInternals.redis);
      let intercepted = false;
      jest.spyOn(secondInternals.redis, 'get').mockImplementation(async (requestedKey) => {
        const result = await originalGet(requestedKey);
        if (requestedKey === blobKey && !intercepted) {
          intercepted = true;
          observed();
          await pause;
        }
        return result;
      });
      reading = second.getChatContext(chatId);
      await started;
      const published = new Promise<void>((resolve) =>
        secondInternals.subscriber.once('message', () => resolve()),
      );
      row.admins = [];
      await inspector.set(ChatContextCacheService.legacyCacheKey(chatId), raw, 'EX', 60);
      await first.applyAdminAccessEpochMutation({
        chatId,
        userId,
        state: 'user_denied',
        eventAt: new Date(),
      });
      await published;
      expect(await inspector.exists(ChatContextCacheService.legacyCacheKey(chatId))).toBe(0);
      resume();
      const result = await reading;
      expect(result.adminUserIds).toEqual([]);
      expect(result.settings.botSpeechMedia).toEqual(media);
    } finally {
      resume();
      await reading?.catch(() => undefined);
      await inspector.del(
        key,
        ChatContextCacheService.legacyCacheKey(chatId),
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.adminAccessKey(chatId, userId),
        ChatContextCacheService.adminAccessEpochKey(chatId, userId),
        ...(blobKey ? [blobKey] : []),
      );
      await first.onModuleDestroy();
      await second.onModuleDestroy();
      await inspector.quit();
    }
  });
});

describeRedis('chat context media publication race', () => {
  it('refuses a reference that expires before revision commit and rebuilds it without losing settings', async () => {
    const chatId = `media-commit-${randomUUID()}`;
    const media = {
      greetingBotMessageText: { base64: 'c'.repeat(100_000), mimeType: 'image/png' },
    };
    const row = {
      id: chatId,
      title: 'Publication race',
      settings: { chatId, linkRulesPolicy: null, botSpeechMedia: media },
      domains: [],
      admins: [],
      rules: null,
    };
    const db = { chat: { findUnique: jest.fn().mockResolvedValue(row) } };
    const service = new ChatContextCacheService(
      db as never,
      { getOrThrow: () => redisUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisUrl);
    const runtimeRedis = (service as unknown as { redis: Redis }).redis;
    const originalEval = runtimeRedis.eval.bind(runtimeRedis);
    const key = ChatContextCacheService.cacheKey(chatId);
    let blobKey = '';
    let removed = false;
    let refused = false;
    try {
      jest.spyOn(runtimeRedis, 'eval').mockImplementation(async (...args) => {
        let forceMissing = false;
        if (String(args[0]).includes('revision ~= ARGV[1]') && !removed) {
          removed = true;
          forceMissing = true;
          blobKey = String(args[6]);
          expect(blobKey).toMatch(/^chat:context:media:v1:[a-f0-9]{64}$/u);
          await inspector.del(blobKey);
        }
        const result = await originalEval(...args);
        if (forceMissing) {
          expect(result).toBe(0);
          expect(await inspector.exists(key)).toBe(0);
          refused = true;
        }
        return result;
      });
      expect((await service.getChatContext(chatId)).settings.botSpeechMedia).toEqual(media);
      expect(refused).toBe(true);
      expect(db.chat.findUnique).toHaveBeenCalledTimes(2);
      expect(await inspector.exists(blobKey)).toBe(1);
    } finally {
      await inspector.del(
        key,
        ChatContextCacheService.legacyCacheKey(chatId),
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ...(blobKey ? [blobKey] : []),
      );
      await service.onModuleDestroy();
      await inspector.quit();
    }
  });
});

describeRedis('chat context rollback compatibility', () => {
  it.each(['read', 'access', 'patch', 'missing_revision'])(
    'rejects a retained v4 context after an old writer advances the revision before %s',
    async (operation) => {
      const chatId = `media-rollback-${randomUUID()}`;
      const userId = `revoked-${randomUUID()}`;
      const row = {
        id: chatId,
        title: 'Before rollback',
        settings: {
          chatId,
          linkRulesPolicy: null,
          botSpeechMedia: {
            greetingBotMessageText: {
              base64: 'v'.repeat(100_000),
              mimeType: 'image/png',
            },
          },
        },
        domains: [],
        admins: [{ userId }],
        rules: null,
      };
      const db = {
        chat: {
          findUnique: jest.fn().mockImplementation(async () => row),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const first = new ChatContextCacheService(
        db as never,
        { getOrThrow: () => redisUrl } as never,
        {} as never,
      );
      const next = new ChatContextCacheService(
        db as never,
        { getOrThrow: () => redisUrl } as never,
        {} as never,
      );
      const inspector = new Redis(redisUrl);
      let blobKey = '';
      try {
        await first.getChatContext(chatId);
        const key = ChatContextCacheService.cacheKey(chatId);
        blobKey = `chat:context:media:v1:${
          JSON.parse((await inspector.get(key))!).__maximMedia.fields.botSpeechMedia.sha256
        }`;
        row.admins = [];
        row.title = 'After rollback';
        row.settings.botSpeechMedia.greetingBotMessageText.base64 = 'current image';
        // FLAG: Reproduce an old image's real shared invalidation protocol. It knows only v3;
        // the old v4 body intentionally remains until a compatible reader verifies its revision.
        await inspector.eval(
          `
          redis.call('INCR', KEYS[1])
          redis.call('DEL', KEYS[2])
          return 1
        `,
          2,
          ChatContextCacheService.chatContextRevisionKey(chatId),
          ChatContextCacheService.legacyCacheKey(chatId),
        );
        if (operation === 'missing_revision')
          await inspector.del(ChatContextCacheService.cachedContextRevisionKey(chatId));
        if (operation === 'access')
          await next.applyAdminAccessEpochMutation({
            chatId,
            userId: 'another-admin',
            state: 'granted',
            eventAt: new Date(),
          });
        if (operation === 'patch') await next.replaceChatAdminUsers(chatId, ['another-admin']);
        const current = await next.getChatContext(chatId);
        expect(current.adminUserIds).toEqual([]);
        expect(current.title).toBe('After rollback');
        expect(current.settings.botSpeechMedia).toEqual(row.settings.botSpeechMedia);
        expect(db.chat.findUnique).toHaveBeenCalledTimes(2);
      } finally {
        await inspector.del(
          ChatContextCacheService.cacheKey(chatId),
          ChatContextCacheService.cachedContextRevisionKey(chatId),
          ChatContextCacheService.legacyCacheKey(chatId),
          ChatContextCacheService.chatContextRevisionKey(chatId),
          ChatContextCacheService.adminAccessKey(chatId, 'another-admin'),
          ChatContextCacheService.adminAccessEpochKey(chatId, 'another-admin'),
          ...(blobKey ? [blobKey] : []),
        );
        await first.onModuleDestroy();
        await next.onModuleDestroy();
        await inspector.quit();
      }
    },
  );
});
