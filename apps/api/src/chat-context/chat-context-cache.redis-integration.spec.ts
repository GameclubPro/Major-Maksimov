import { withChatContextSourceFixture } from './__tests__/chat-context-source.fixture';
import type { ChatSummary } from '@maxim/contracts';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ChatContextCacheService } from './chat-context-cache.service';
import { publishManagedEntityHeaderChanges } from '../admin/admin-managed-entity-header-refresh';

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

describeLocalRedis('ChatContextCacheService Redis integration', () => {
  it('publishes a changed title but reuses the same committed title without Redis writes', async () => {
    const chatId = `title-reuse-${randomUUID()}`;
    const config = { getOrThrow: () => redisIntegrationUrl };
    const prisma = { chat: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const reader = new ChatContextCacheService(
      withChatContextSourceFixture(prisma),
      config as never,
      {} as never,
    );
    const writer = new ChatContextCacheService(
      withChatContextSourceFixture(prisma),
      config as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const observer = new Redis(redisIntegrationUrl);
    const key = ChatContextCacheService.cacheKey(chatId);
    const cachedRevisionKey = ChatContextCacheService.cachedContextRevisionKey(chatId);
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const channel = 'chat:context:invalidate:v1';
    const messages: string[] = [];
    let finishChanged = () => {};
    let changedTimeout: NodeJS.Timeout | undefined;
    observer.on('message', (_, payload) => {
      if ((JSON.parse(payload) as { chatId?: string }).chatId !== chatId) return;
      messages.push(payload);
      finishChanged();
    });
    const readerRedis = (
      reader as unknown as {
        redis: {
          eval: (...args: unknown[]) => Promise<unknown>;
          mget: (...keys: string[]) => Promise<Array<string | null>>;
        };
      }
    ).redis;
    try {
      await inspector.set(
        key,
        JSON.stringify({
          chatId,
          title: 'Before rename',
          settings: { linkRulesPolicy: null },
          domainAllowlist: [],
          adminUserIds: ['admin-1'],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        'EX',
        60,
      );
      await inspector.set(cachedRevisionKey, '0', 'EX', 60);
      await reader.getChatContext(chatId);
      await observer.subscribe(channel);
      const changed = new Promise<void>((resolve, reject) => {
        changedTimeout = setTimeout(() => reject(new Error('Title invalidation missing')), 2_000);
        finishChanged = () => {
          clearTimeout(changedTimeout);
          resolve();
        };
      });

      expect((await writer.getChatContext(chatId, 'After rename')).title).toBe('After rename');
      await changed;
      expect(messages.map((payload) => JSON.parse(payload))).toEqual([
        { chatId, reason: 'title_changed' },
      ]);
      expect(await inspector.get(revisionKey)).toBe('1');
      await inspector.pexpire(key, 20_000);
      const ttlBefore = await inspector.pttl(key);
      const evaluate = jest.spyOn(readerRedis, 'eval');
      const read = readerRedis.mget.bind(readerRedis);
      let finishRead!: () => void;
      const patchRead = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      readerRedis.mget = async (...keys) => {
        const result = await read(...keys);
        finishRead();
        return result;
      };

      expect((await reader.getChatContext(chatId, 'After rename')).title).toBe('After rename');
      await patchRead;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(evaluate).not.toHaveBeenCalled();
      expect(await inspector.get(revisionKey)).toBe('1');
      expect(await inspector.pttl(key)).toBeLessThanOrEqual(ttlBefore);
      expect(messages).toHaveLength(1);
      expect(reader.getLocalCacheSnapshot()).toMatchObject({ entries: 1, invalidations: 0 });
    } finally {
      clearTimeout(changedTimeout);
      await inspector.del(key, cachedRevisionKey, revisionKey);
      await observer.quit();
      await inspector.quit();
      await reader.onModuleDestroy();
      await writer.onModuleDestroy();
    }
  });

  it.each([1, 999])(
    'reloads a pre-policy Redis body and preserves raw SQL policy version %s',
    async (version) => {
      const chatId = `link-policy-cache-${randomUUID()}`;
      const policy = { version, mode: 'DENY_ALL', rules: [] };
      const row = {
        id: chatId,
        title: 'Links',
        settings: { linkRulesPolicy: policy, antiSpamEnabled: true },
        domains: [],
        admins: [],
        rules: null,
      };
      const db = { chat: { findUnique: jest.fn().mockResolvedValue(row) } };
      const config = { getOrThrow: () => redisIntegrationUrl };
      const reader = new ChatContextCacheService(
        withChatContextSourceFixture(db),
        config as never,
        {} as never,
      );
      const second = new ChatContextCacheService(
        withChatContextSourceFixture({}),
        config as never,
        {} as never,
      );
      const inspector = new Redis(redisIntegrationUrl);
      const key = ChatContextCacheService.cacheKey(chatId);
      const revisionKey = ChatContextCacheService.cachedContextRevisionKey(chatId);
      try {
        await inspector.set(
          key,
          JSON.stringify({
            chatId,
            title: 'Links',
            settings: { antiSpamEnabled: true },
            domainAllowlist: [],
            adminUserIds: [],
            rulesPublishedUrl: null,
            rulesPublishedMessageId: null,
          }),
          'EX',
          60,
        );
        await inspector.set(revisionKey, '0', 'EX', 60);
        const loaded = await reader.getChatContext(chatId);
        expect(loaded.settings.linkRulesPolicy).toEqual(policy);
        expect(loaded.settings.antiSpamEnabled).toBe(true);
        expect(db.chat.findUnique).toHaveBeenCalledTimes(1);
        expect((await second.getChatContext(chatId)).settings.linkRulesPolicy).toEqual(policy);
      } finally {
        await inspector.del(
          key,
          revisionKey,
          ChatContextCacheService.chatContextRevisionKey(chatId),
          ChatContextCacheService.legacyCacheKey(chatId),
        );
        await inspector.quit();
        await reader.onModuleDestroy();
        await second.onModuleDestroy();
      }
    },
  );

  it('refreshes a busy reader at its original deadline after losing a published invalidation', async () => {
    const chatId = `absolute-context-${randomUUID()}`;
    const localTtlMs = 120;
    const config = {
      getOrThrow: () => redisIntegrationUrl,
      get: (key: string) => (key === 'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS' ? localTtlMs : undefined),
    };
    // This reader never subscribes, so its populated local entry misses the real publication.
    const reader = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const writer = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const contextKey = ChatContextCacheService.cacheKey(chatId);
    const cachedRevisionKey = ChatContextCacheService.cachedContextRevisionKey(chatId);
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const publish = async (revision: number) => {
      await inspector.set(
        contextKey,
        JSON.stringify({
          chatId,
          title: 'Busy chat',
          settings: { linkRulesPolicy: null, stopWordsRevision: revision },
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        'EX',
        60,
      );
      await inspector.set(cachedRevisionKey, String(revision), 'EX', 60);
    };
    try {
      await publish(0);
      expect((await reader.getChatContext(chatId)).settings.stopWordsRevision).toBe(0);
      await writer.invalidate(chatId);
      await expect(inspector.get(revisionKey)).resolves.toBe('1');
      await publish(1);

      const deadline = Date.now() + 4 * localTtlMs;
      let revision = 0;
      while (Date.now() < deadline && revision === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        revision = (await reader.getChatContext(chatId)).settings.stopWordsRevision;
      }
      expect(revision).toBe(1);
    } finally {
      await inspector.del(
        contextKey,
        cachedRevisionKey,
        revisionKey,
        ChatContextCacheService.legacyCacheKey(chatId),
      );
      await inspector.quit();
      await reader.onModuleDestroy();
      await writer.onModuleDestroy();
    }
  });

  it('keeps the Redis source deadline during title changes and eventually reads fresh settings', async () => {
    const chatId = `title-context-${randomUUID()}`;
    const localTtlMs = 120;
    const redisTtlMs = 600;
    const source = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'New title',
          settings: { linkRulesPolicy: null, stopWordsRevision: 1 },
          domains: [],
          admins: [],
          rules: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const reader = new ChatContextCacheService(
      withChatContextSourceFixture(source),
      {
        getOrThrow: () => redisIntegrationUrl,
        get: (key: string) => (key === 'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS' ? localTtlMs : undefined),
      } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const contextKey = ChatContextCacheService.cacheKey(chatId);
    const cachedRevisionKey = ChatContextCacheService.cachedContextRevisionKey(chatId);
    try {
      await inspector.set(
        contextKey,
        JSON.stringify({
          chatId,
          title: 'Old title',
          settings: { linkRulesPolicy: null, stopWordsRevision: 0 },
          domainAllowlist: [],
          adminUserIds: [],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        'PX',
        redisTtlMs,
      );
      await inspector.set(cachedRevisionKey, '0', 'PX', redisTtlMs);
      const originalDeadline = Date.now() + redisTtlMs;
      expect((await reader.getChatContext(chatId, 'New title')).title).toBe('New title');

      const patchDeadline = Date.now() + 300;
      let patchedTitle: string | undefined;
      while (Date.now() < patchDeadline && patchedTitle !== 'New title') {
        const raw = await inspector.get(contextKey);
        patchedTitle = raw ? (JSON.parse(raw) as { title?: string }).title : undefined;
        if (patchedTitle !== 'New title') {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(patchedTitle).toBe('New title');
      const remainingTtl = await inspector.pttl(contextKey);
      expect(remainingTtl).toBeGreaterThan(0);
      expect(remainingTtl).toBeLessThanOrEqual(redisTtlMs);
      expect(await inspector.pttl(cachedRevisionKey)).toBeLessThanOrEqual(redisTtlMs);

      // Continuous hits must exhaust both existing deadlines without renewing either layer.
      const deadline = originalDeadline + localTtlMs + 500;
      let revision = 0;
      while (Date.now() < deadline && revision === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        revision = (await reader.getChatContext(chatId, 'New title')).settings.stopWordsRevision;
      }
      expect(revision).toBe(1);
      expect(source.chat.findUnique).toHaveBeenCalledTimes(1);
    } finally {
      await inspector.del(
        contextKey,
        cachedRevisionKey,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.legacyCacheKey(chatId),
      );
      await inspector.quit();
      await reader.onModuleDestroy();
    }
  });

  it('admits one metadata refresh across viewers and reopens it after the finite cooldown', async () => {
    const chatId = `header-refresh-${randomUUID()}`;
    const config = { getOrThrow: () => redisIntegrationUrl };
    const first = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const second = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const key = `${ChatContextCacheService.managedEntityHeaderKey(chatId, 'chat')}:refresh:v1`;
    try {
      const results = await Promise.all([
        first.claimManagedEntityHeaderRefresh(chatId, 'chat'),
        second.claimManagedEntityHeaderRefresh(chatId, 'chat'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await inspector.ttl(key)).toBeGreaterThan(115);
      expect(await inspector.ttl(key)).toBeLessThanOrEqual(120);
      await inspector.pexpire(key, 0);
      await expect(second.claimManagedEntityHeaderRefresh(chatId, 'chat')).resolves.toBe(true);
    } finally {
      await inspector.del(key);
      await inspector.quit();
      await first.onModuleDestroy();
      await second.onModuleDestroy();
    }
  });

  it('publishes real Redis header diffs without resurrecting a removed entity on a stale write', async () => {
    const userId = `header-user-${randomUUID()}`;
    const chatId = `header-chat-${randomUUID()}`;
    const service = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const key = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, 'chat');
    const diffKey = ChatContextCacheService.managedEntitiesPublishedDiffKey(
      userId,
      'chat',
      'before',
    );
    const item: ChatSummary = {
      id: chatId,
      title: `Chat ${chatId}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      entityType: 'chat',
      link: null,
      avatarUrl: null,
      channelOverview: null,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    };
    const old = {
      version: 'before',
      builtAt: item.createdAt,
      lastSyncedAt: null,
      itemCount: 1,
      itemsHash: 'before',
      items: [item],
    };
    try {
      await service.setManagedEntitiesPublishedSnapshot(userId, 'chat', old, 60, {
        expectedVersion: null,
      });
      const update = {
        cache: service,
        userId,
        entityType: 'chat' as const,
        snapshot: old,
        visibleItems: [
          { ...item, title: 'Название чата', avatarUrl: 'https://i.oneme.ru/avatar.webp' },
        ],
        writeDiff: true,
      };
      const next = await publishManagedEntityHeaderChanges(update);
      expect(next?.version).not.toBe('before');
      const stored = await service.getManagedEntitiesPublishedSnapshot(userId, 'chat');
      expect(stored?.items[0]).toMatchObject({
        title: 'Название чата',
        avatarUrl: 'https://i.oneme.ru/avatar.webp',
      });
      const diff = await service.getManagedEntitiesPublishedDiff(userId, 'chat', 'before');
      expect(diff).toMatchObject({
        baseVersion: 'before',
        nextVersion: next?.version,
        updated: [expect.objectContaining({ id: chatId, title: 'Название чата' })],
      });
      await service.setManagedEntitiesPublishedSnapshot(
        userId,
        'chat',
        { ...next!, version: 'removed', items: [], itemCount: 0 },
        60,
        { expectedVersion: next!.version },
      );
      await expect(publishManagedEntityHeaderChanges(update)).resolves.toBeNull();
      expect((await service.getManagedEntitiesPublishedSnapshot(userId, 'chat'))?.items).toEqual(
        [],
      );
    } finally {
      await inspector.del(key, diffKey);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('shares bot backoff across clients without throttling other bots or shortening Retry-After', async () => {
    const botId = `backoff-${randomUUID()}`;
    const config = { getOrThrow: () => redisIntegrationUrl };
    const first = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const second = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      config as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    try {
      await first.activateManagedRefreshSourceBackoff(20, botId);
      await second.activateManagedRefreshSourceBackoff(1, botId);
      await expect(second.isManagedRefreshSourceBackoffActive(botId)).resolves.toBe(true);
      await expect(second.isManagedRefreshSourceBackoffActive(`${botId}-other`)).resolves.toBe(
        false,
      );
      await expect(first.getManagedRefreshSourceBackoffRemainingMs(botId)).resolves.toBeGreaterThan(
        19_000,
      );
    } finally {
      await inspector.del(ChatContextCacheService.managedRefreshSourceBackoffKey(botId));
      await inspector.quit();
      await first.onModuleDestroy();
      await second.onModuleDestroy();
    }
  });

  it('orders equal-time denial above grant and expires the per-user epoch', async () => {
    const suffix = randomUUID();
    const userId = `redis-epoch-user-${suffix}`;
    const chatId = `redis-epoch-chat-${suffix}`;
    const service = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const eventAt = new Date('2026-08-20T10:00:00.123Z');
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    const accessKey = ChatContextCacheService.adminAccessKey(chatId, userId);

    try {
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt,
        }),
      ).resolves.toBe(true);
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'granted',
          eventAt,
        }),
      ).resolves.toBe(false);
      await expect(inspector.get(accessKey)).resolves.toBe('user_denied');
      const epochTtlSec = await inspector.ttl(epochKey);
      expect(epochTtlSec).toBeGreaterThan(29 * 24 * 60 * 60);
      expect(epochTtlSec).toBeLessThanOrEqual(30 * 24 * 60 * 60);
      await expect(
        inspector.ttl(ChatContextCacheService.chatContextRevisionKey(chatId)),
      ).resolves.toBe(-1);
    } finally {
      await inspector.del(
        epochKey,
        accessKey,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.cacheKey(chatId),
      );
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('retries a denial when a stale context appears between MGET and EVAL', async () => {
    const suffix = randomUUID();
    const userId = `redis-context-race-user-${suffix}`;
    const chatId = `redis-context-race-chat-${suffix}`;
    const service = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const contextKey = ChatContextCacheService.cacheKey(chatId);
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    const accessKey = ChatContextCacheService.adminAccessKey(chatId, userId);
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const redis = service as unknown as {
      redis: { eval: (...args: unknown[]) => Promise<unknown> };
    };
    const evaluate = redis.redis.eval.bind(redis.redis);
    let injected = false;
    redis.redis.eval = async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        await inspector.set(
          ChatContextCacheService.cachedContextRevisionKey(chatId),
          '0',
          'EX',
          60,
        );
        await inspector.set(
          contextKey,
          JSON.stringify({
            chatId,
            title: 'Race chat',
            settings: {},
            domainAllowlist: [],
            adminUserIds: [userId],
            rulesPublishedUrl: null,
            rulesPublishedMessageId: null,
          }),
        );
      }
      return evaluate(...args);
    };

    try {
      await expect(
        service.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.123Z'),
        }),
      ).resolves.toBe(true);

      const stored = JSON.parse((await inspector.get(contextKey)) ?? 'null') as {
        adminUserIds?: unknown;
      };
      expect(stored.adminUserIds).toEqual([]);
      await expect(inspector.get(accessKey)).resolves.toBe('user_denied');
    } finally {
      await inspector.del(contextKey, epochKey, accessKey, revisionKey);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('preserves empty arrays while moving a recovered entity between snapshots', async () => {
    const userId = `redis-integration-${randomUUID()}`;
    const service = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const inspector = new Redis(redisIntegrationUrl);
    const chatKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, 'chat');
    const channelKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      userId,
      'channel',
    );
    const original: ChatSummary = {
      id: '-100-forwarded',
      title: 'Recovered entity',
      createdAt: '2026-08-01T00:00:00.000Z',
      entityType: 'chat',
      link: null,
      avatarUrl: null,
      channelOverview: null,
      primaryBotId: 'launch-bot',
      assignedBots: [],
      sharedMode: 'owned',
    };

    try {
      await service.setManagedEntitiesPublishedSnapshot(
        userId,
        'chat',
        {
          version: 'before-recovery',
          builtAt: '2026-08-01T00:00:00.000Z',
          lastSyncedAt: null,
          itemCount: 1,
          itemsHash: 'before-recovery',
          items: [original],
        },
        60,
        { expectedVersion: null },
      );
      await service.upsertManagedEntityPublishedSnapshot(
        userId,
        { ...original, entityType: 'channel' },
        60,
      );

      await expect(service.getManagedEntitiesPublishedSnapshot(userId, 'channel')).resolves.toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ assignedBots: [] })],
        }),
      );
      await expect(inspector.exists(chatKey)).resolves.toBe(0);
      const stored = JSON.parse((await inspector.get(channelKey)) ?? 'null') as {
        items?: Array<{ assignedBots?: unknown }>;
      };
      expect(Array.isArray(stored.items?.[0]?.assignedBots)).toBe(true);
    } finally {
      await inspector.del(chatKey, channelKey);
      await inspector.quit();
      await service.onModuleDestroy();
    }
  });

  it('merges concurrent standalone recent bootstrap upserts without losing either chat', async () => {
    const suffix = randomUUID();
    const userId = `redis-bootstrap-user-${suffix}`;
    const chatIds = [`redis-bootstrap-a-${suffix}`, `redis-bootstrap-b-${suffix}`];
    const service = new ChatContextCacheService(
      withChatContextSourceFixture({}),
      { getOrThrow: () => redisIntegrationUrl } as never,
      {} as never,
    );
    const buildSummary = (chatId: string): ChatSummary => ({
      id: chatId,
      title: chatId,
      createdAt: '2026-08-20T10:00:00.000Z',
      entityType: 'chat',
      link: null,
      avatarUrl: null,
      channelOverview: null,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    });

    try {
      await Promise.all(
        chatIds.map((chatId) =>
          service.upsertManagedEntitiesRecentBootstrap(buildSummary(chatId), 60, userId),
        ),
      );
      const recent = await service.getManagedEntitiesRecentBootstrap('chat', userId);
      expect(
        recent
          .map((item) => item.id)
          .filter((chatId) => chatIds.includes(chatId))
          .sort(),
      ).toEqual([...chatIds].sort());
    } finally {
      await Promise.all(
        chatIds.map((chatId) => service.clearManagedEntitiesRecentBootstrapForChat(chatId, 'chat')),
      );
      await service.onModuleDestroy();
    }
  });
});
