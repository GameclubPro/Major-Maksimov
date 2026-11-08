import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { completeAdminRoster } from '../max/chat-admin-roster-state';
import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { AdminService } from './admin.service';
import { AdminSettingsService } from './admin-settings.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

native('settings entry protects confirmed humans on PostgreSQL', () => {
  const botId = '777000_bot';
  const user = { userId: '123', username: null, displayName: null };
  const config = new ConfigService({
    APP_BASE_URL: 'https://major-maksimov.ru',
    MAX_BOT_ID: botId,
    MAX_BOT_CONTACT_ID: '777000',
    MAX_BOT_TOKEN: 'native-test-token',
    MAX_WEBHOOK_SECRET_PATH: 'native-test-path',
    MAX_WEBHOOK_HEADER_SECRET: 'native-test-header',
  });
  const registry = new MaxBotRegistryService(config);
  const human: MaxChatMemberAccess = {
    userId: user.userId,
    isBot: false,
    isAdmin: true,
    isOwner: false,
    permissions: [],
    explicitPrivilegeEvidence: true,
  };
  const bot: MaxChatMemberAccess = { ...human, userId: '777000', isBot: true };
  const members = () =>
    new Map([
      [user.userId, human],
      ['777000', bot],
    ]);
  let prisma: PrismaClient;
  let chatId: string;

  function services() {
    const cache = {
      getAdminAccess: jest
        .fn<
          ReturnType<ChatContextCacheService['getAdminAccess']>,
          Parameters<ChatContextCacheService['getAdminAccess']>
        >()
        .mockResolvedValue('user_denied'),
      applyAdminAccessEpochMutation: jest
        .fn<
          ReturnType<ChatContextCacheService['applyAdminAccessEpochMutation']>,
          Parameters<ChatContextCacheService['applyAdminAccessEpochMutation']>
        >()
        .mockResolvedValue(true),
      invalidate: jest
        .fn<
          ReturnType<ChatContextCacheService['invalidate']>,
          Parameters<ChatContextCacheService['invalidate']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<
      ChatContextCacheService,
      'getAdminAccess' | 'applyAdminAccessEpochMutation' | 'invalidate'
    >;
    const maxClient = {
      getChatMembersAccess: jest
        .fn<
          ReturnType<MaxClientService['getChatMembersAccess']>,
          Parameters<MaxClientService['getChatMembersAccess']>
        >()
        .mockImplementation(async (_chatId, _userIds, options) =>
          options?.bypassCache === true
            ? members()
            : new Map([
                [
                  user.userId,
                  {
                    ...human,
                    isAdmin: false,
                    explicitPrivilegeEvidence: false,
                    explicitNonPrivilegeEvidence: true,
                  },
                ],
                ['777000', bot],
              ]),
        ),
      getCurrentChatMemberAccess: jest
        .fn<
          ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
          Parameters<MaxClientService['getCurrentChatMemberAccess']>
        >()
        .mockResolvedValue(bot),
    } satisfies Pick<MaxClientService, 'getChatMembersAccess' | 'getCurrentChatMemberAccess'>;
    const roster = {
      scheduleChatAdminRosterSync: jest
        .fn<
          ReturnType<MaxChatAdminRosterSyncService['scheduleChatAdminRosterSync']>,
          Parameters<MaxChatAdminRosterSyncService['scheduleChatAdminRosterSync']>
        >()
        .mockResolvedValue(true),
    } satisfies Pick<MaxChatAdminRosterSyncService, 'scheduleChatAdminRosterSync'>;
    const admin = new AdminService(
      prisma as PrismaService,
      maxClient as unknown as MaxClientService,
      cache as unknown as ChatContextCacheService,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
      undefined,
      undefined,
      undefined,
      undefined,
      roster as unknown as MaxChatAdminRosterSyncService,
    );
    const settings = new AdminSettingsService(
      admin,
      prisma as PrismaService,
      cache as unknown as ChatContextCacheService,
      maxClient as unknown as MaxClientService,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return { admin, settings, cache, maxClient, roster };
  }

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL required');
    prisma = createPrismaClient(databaseUrl, { max: 3 });
  });
  beforeEach(async () => {
    chatId = `-settings-entry-${randomUUID()}`;
    await prisma.chat.create({
      data: { id: chatId, title: 'Settings entry', entityType: 'CHAT', primaryBotId: botId },
    });
    await prisma.chatBotMembership.create({
      data: { chatId, botId, role: 'PRIMARY', status: 'ACTIVE' },
    });
  });
  afterEach(async () => {
    await prisma.chatMembershipActivityEvent.deleteMany({ where: { chatId } });
    await prisma.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('returns settings for a promoted actor only after durable protection, before any full roster completes', async () => {
    const { settings, cache, maxClient, roster } = services();
    const oldMembership = await prisma.chatBotMembership.findUniqueOrThrow({
      where: { chatId_botId: { chatId, botId } },
    });
    await prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: user.userId,
        botId: 'independent-publisher',
        state: 'USER_DENIED',
        checkedAt: new Date(Date.now() + 60_000),
        source: 'publisher-specific',
      },
    });
    cache.applyAdminAccessEpochMutation.mockImplementation(async () => {
      expect(
        await prisma.chatAdminAllowlist.findUnique({
          where: { chatId_userId: { chatId, userId: user.userId } },
        }),
      ).not.toBeNull();
      expect(
        await prisma.managedEntityAccessEdge.findUnique({
          where: { chatId_userId_botId: { chatId, userId: user.userId, botId } },
        }),
      ).toMatchObject({ state: 'GRANTED' });
      return true;
    });
    const fullRoster = deferred<boolean>();
    roster.scheduleChatAdminRosterSync.mockReturnValue(fullRoster.promise);

    try {
      await expect(settings.getSettings(chatId, user)).resolves.toMatchObject({});
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
        chatId,
        [user.userId, '777000'],
        expect.objectContaining({ botId, bypassCache: true }),
      );
      expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
      expect(roster.scheduleChatAdminRosterSync).toHaveBeenCalledTimes(1);
      expect(
        await prisma.chatAdminAllowlist.findUnique({
          where: { chatId_userId: { chatId, userId: user.userId } },
        }),
      ).not.toBeNull();
      expect(
        await prisma.chatBotMembership.findUnique({ where: { chatId_botId: { chatId, botId } } }),
      ).toEqual(oldMembership);
      expect(
        await prisma.managedEntityAccessEdge.findUnique({
          where: {
            chatId_userId_botId: { chatId, userId: user.userId, botId: 'independent-publisher' },
          },
        }),
      ).toMatchObject({ state: 'USER_DENIED', source: 'publisher-specific' });
    } finally {
      fullRoster.resolve(true);
    }
  });

  it.each(['chat', 'channel'] as const)(
    'protects a promoted human before the legacy %s settings GET returns',
    async (entityType) => {
      const { admin, cache, maxClient } = services();
      await prisma.chat.update({
        where: { id: chatId },
        data: { entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL' },
      });
      cache.applyAdminAccessEpochMutation.mockImplementation(async () => {
        expect(
          await prisma.chatAdminAllowlist.count({ where: { chatId, userId: user.userId } }),
        ).toBe(1);
        return true;
      });

      const settings =
        entityType === 'chat'
          ? await admin.getSettings(chatId, user)
          : await admin.getChannelSettings(chatId, user);

      expect(settings).toEqual(expect.any(Object));
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
        chatId,
        [user.userId, '777000'],
        expect.objectContaining({ botId, bypassCache: true }),
      );
      expect(
        await prisma.chatAdminAllowlist.count({ where: { chatId, userId: user.userId } }),
      ).toBe(1);
    },
  );

  it.each([
    ['legacy', 'chat'],
    ['legacy', 'channel'],
    ['current', 'chat'],
    ['current', 'channel'],
  ] as const)(
    'commits human protection before the %s %s settings screen starts reading its content',
    async (entry, entityType) => {
      const { admin, settings, maxClient } = services();
      await prisma.chat.update({
        where: { id: chatId },
        data: { entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL' },
      });
      const contentBoundary = new Error('Settings screen content boundary reached');
      const reader = admin as unknown as { ensureEntityType: AdminService['ensureEntityType'] };
      const contentRead = jest.spyOn(reader, 'ensureEntityType').mockImplementation(async () => {
        expect(
          await prisma.chatAdminAllowlist.count({ where: { chatId, userId: user.userId } }),
        ).toBe(1);
        expect(
          await prisma.managedEntityAccessEdge.findUnique({
            where: { chatId_userId_botId: { chatId, userId: user.userId, botId } },
          }),
        ).toMatchObject({ state: 'GRANTED' });
        throw contentBoundary;
      });

      try {
        const source = entry === 'legacy' ? admin : settings;
        const screen =
          entityType === 'chat'
            ? source.getChatSettingsScreen(chatId, user)
            : source.getChannelSettingsScreen(chatId, user);
        await expect(screen).rejects.toBe(contentBoundary);
        expect(contentRead).toHaveBeenCalledTimes(1);
        expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
          chatId,
          [user.userId, '777000'],
          expect.objectContaining({
            botId,
            bypassCache: true,
            ...(entry === 'legacy' ? { timeoutMs: 1_500 } : {}),
          }),
        );
      } finally {
        contentRead.mockRestore();
      }
    },
  );

  it('keeps an independent read-only access check separate from settings protection', async () => {
    const { admin, maxClient } = services();
    maxClient.getChatMembersAccess.mockResolvedValue(members());

    await admin.assertManagedEntityReadAccess(chatId, user.userId, 'chat');

    expect(await prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      chatId,
      [user.userId, '777000'],
      expect.not.objectContaining({ bypassCache: true }),
    );
  });

  it('rejects a grant superseded by a membership event while MAX was answering', async () => {
    const { admin, cache, maxClient } = services();
    const started = deferred<void>();
    const remote = deferred<Map<string, MaxChatMemberAccess>>();
    maxClient.getChatMembersAccess.mockImplementation(async () => {
      started.resolve();
      return remote.promise;
    });
    const check = admin.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    await started.promise;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
      await tx.chatMembershipActivityEvent.create({
        data: {
          chatId,
          userId: `id${user.userId}`,
          botId,
          eventType: 'user_removed',
          eventAt: new Date(Date.now() + 1_000),
          dedupeKey: randomUUID(),
        },
      });
    });
    remote.resolve(members());

    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
    expect(await prisma.managedEntityAccessEdge.count({ where: { chatId, botId } })).toBe(0);
    expect(cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('rejects an older grant when a newer aliased Major actor denial already committed', async () => {
    const { admin, cache, maxClient } = services();
    maxClient.getChatMembersAccess.mockImplementation(async () => {
      await prisma.managedEntityAccessEdge.create({
        data: {
          chatId,
          userId: `id${user.userId}`,
          botId,
          state: 'USER_DENIED',
          checkedAt: new Date(Date.now() + 1_000),
          source: 'newer-personal-denial',
        },
      });
      return members();
    });

    await expect(
      admin.assertManagedEntityAdminAccess(chatId, user.userId, 'chat'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
    expect(await prisma.managedEntityAccessEdge.findMany({ where: { chatId } })).toEqual([
      expect.objectContaining({ userId: `id${user.userId}`, state: 'USER_DENIED' }),
    ]);
    expect(cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it.each(['settings', 'ordinary'] as const)(
    'rejects a delayed first %s grant after a newer complete roster excludes the never-known actor',
    async (purpose) => {
      const { admin, cache, maxClient } = services();
      const started = deferred<void>();
      const remote = deferred<Map<string, MaxChatMemberAccess>>();
      maxClient.getChatMembersAccess.mockImplementation(async () => {
        started.resolve();
        return remote.promise;
      });
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
        await completeAdminRoster(tx, chatId, new Date(Date.now() - 60_000));
      });
      const check =
        purpose === 'settings'
          ? admin.assertManagedEntityAdminAccess(chatId, user.userId, 'chat')
          : admin.assertChatAdmin(chatId, user.userId, 'chat');
      await started.promise;
      const newerProbe = new Date(Date.now() + 1_000);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
        await tx.chatAdminAllowlist.deleteMany({ where: { chatId } });
        await completeAdminRoster(tx, chatId, newerProbe);
      });
      remote.resolve(members());

      await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
      expect(await prisma.managedEntityAccessEdge.count({ where: { chatId } })).toBe(0);
      expect(await prisma.chatAdminRosterState.findUnique({ where: { chatId } })).toMatchObject({
        completeProbeStartedAt: newerProbe,
      });
      expect(cache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'accepts discovery protection only from an observation after the complete roster (fresh=%s)',
    async (fresh) => {
      const { admin } = services();
      const completeProbeAt = new Date(Date.now() + 1_000);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
        await completeAdminRoster(tx, chatId, completeProbeAt);
      });
      const persistence = admin as unknown as {
        upsertUserChatAccess: AdminService['upsertUserChatAccess'];
      };
      const result = await persistence.upsertUserChatAccess(chatId, user.userId, null, 'chat', {
        accessProbeStartedAt: new Date(completeProbeAt.getTime() + (fresh ? 1_000 : -1_000)),
      });
      if (fresh) expect(result).toMatchObject({ id: chatId });
      else expect(result).toBeNull();
      expect(await prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(fresh ? 1 : 0);
    },
  );
});
