import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { writeManagedEntityFavorites } from './managed-entity-favorites-writer';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('managed network composition with PostgreSQL', () => {
  let db: PrismaClient;
  let service: ManagedEntityNetworksService;
  const suffix = randomUUID();
  const actor = `networks-actor-${suffix}`;
  const bot = `networks-bot-${suffix}`;
  const publisherBot = `networks-publisher-${suffix}`;
  const ids = ['a', 'b', 'c', 'channel', 'denied', 'publisher'].map(
    (name) => `networks-${suffix}-${name}`,
  );
  const user = { userId: actor, username: null, displayName: null };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15000 }),
    });
    service = new ManagedEntityNetworksService(
      db as never,
      { getAllBots: () => [{ id: bot }] } as never,
    );
    for (const id of ids) {
      const entityType = id === ids[3] ? 'CHANNEL' : 'CHAT';
      await db.chat.create({ data: { id, title: `Сетка ${id}`, entityType } });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId: id,
          userId: actor,
          botId: id === ids[5] ? publisherBot : bot,
          entityType,
          state: id === ids[4] ? 'USER_DENIED' : 'GRANTED',
          userRole: 'ADMIN',
          expiresAt: new Date(0),
        },
      });
    }
  });
  beforeEach(async () => {
    await db.managedEntityFavorite.deleteMany({ where: { userId: actor } });
  });
  afterAll(async () => {
    await db?.chat.deleteMany({ where: { id: { in: ids } } });
    await db?.managedEntityFavoritePreference.deleteMany({ where: { userId: actor } });
    await db?.$disconnect();
  });

  it('reads all typed networks independently of loaded home pages and keeps legacy assignment canonical', async () => {
    await db.managedEntityFavorite.createMany({
      data: [
        { userId: actor, chatId: ids[0], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[0], favoriteType: 'IMPORTANT' },
        { userId: actor, chatId: ids[1], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[3], entityType: 'CHANNEL', favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[4], favoriteType: 'WATCH' },
        { userId: actor, chatId: ids[5], favoriteType: 'WATCH' },
      ],
    });
    const catalogue = await service.catalogue(user, 'chat');
    expect(catalogue.items).toHaveLength(6);
    expect(catalogue.items.find((item) => item.favoriteType === 'important')?.entityCount).toBe(1);
    expect(catalogue.items.find((item) => item.favoriteType === 'watch')?.entityCount).toBe(1);
    expect((await service.resolveSelection(user, 'chat', 'watch')).entityIds).toEqual([ids[1]]);
    expect((await service.resolveSelection(user, 'channel', 'watch')).entityIds).toEqual([ids[3]]);
    expect(
      await db.managedEntityFavoritePreference.findUnique({ where: { userId: actor } }),
    ).toBeNull();
    const first = await service.entries(user, 'chat', { favoritesOnly: 'true', limit: 1 });
    const second = await service.entries(user, 'chat', {
      favoritesOnly: 'true',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([ids[0], ids[1]]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(['chat', 'channel'] as const)(
    'keeps %s pages available with missing titles and uses existing catalog names',
    async (entityType) => {
      const prefix = `networks-${suffix}-metadata-${entityType}`;
      const chatIds = [0, 1, 2, 3].map((index) => `${prefix}-${index}`);
      const storedTitles = [
        '',
        `${entityType === 'chat' ? 'Chat' : 'Channel'} ${chatIds[1]}`,
        'Текущее название',
        chatIds[3],
      ];
      const storedType = entityType === 'chat' ? 'CHAT' : 'CHANNEL';
      try {
        await db.chat.createMany({
          data: chatIds.map((id, index) => ({
            id,
            title: storedTitles[index],
            entityType: storedType,
          })),
        });
        await db.managedEntityAccessEdge.createMany({
          data: chatIds.map((chatId) => ({
            chatId,
            userId: actor,
            botId: bot,
            entityType: storedType,
            state: 'GRANTED',
            userRole: 'ADMIN',
            expiresAt: new Date(0),
          })),
        });
        await db.managedBotChatCatalog.createMany({
          data: [
            {
              botId: bot,
              chatId: chatIds[1],
              entityType: storedType,
              title: 'Сохранённое название',
              status: 'PRESENTATION',
            },
            {
              botId: bot,
              chatId: chatIds[2],
              entityType: storedType,
              title: 'Старое название',
              status: 'ACTIVE',
            },
            {
              botId: bot,
              chatId: chatIds[3],
              entityType: storedType,
              title: '   ',
              status: 'ACTIVE',
            },
          ],
        });

        const first = await service.entries(user, entityType, { search: prefix, limit: 2 });
        const second = await service.entries(user, entityType, {
          search: prefix,
          limit: 2,
          cursor: first.nextCursor,
        });
        const fallback = entityType === 'chat' ? 'Чат без названия' : 'Канал без названия';
        expect([...first.items, ...second.items].map(({ id, title }) => ({ id, title }))).toEqual(
          [fallback, 'Сохранённое название', 'Текущее название', fallback].map((title, index) => ({
            id: chatIds[index],
            title,
          })),
        );
        for (const literal of ['%', '_']) {
          expect((await service.entries(user, entityType, { search: literal })).items).toEqual([]);
        }
        expect(
          (await service.entries(user, entityType, { search: 'сОхРаНёНноЕ' })).items.map(
            (row) => row.id,
          ),
        ).toEqual([chatIds[1]]);
        expect(
          (await service.entries(user, entityType, { search: 'Старое название' })).items,
        ).toEqual([]);
        expect(second.nextCursor).toBeNull();
        expect(
          await db.chat.findMany({
            where: { id: { in: chatIds } },
            select: { title: true },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(storedTitles.map((title) => ({ title })));
      } finally {
        await db.managedBotChatCatalog.deleteMany({ where: { chatId: { in: chatIds } } });
        await db.chat.deleteMany({ where: { id: { in: chatIds } } });
      }
    },
  );

  it('serializes empty-assignment races and rejects a competing category without partial writes', async () => {
    const outcomes = await Promise.allSettled([
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
      }),
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'watch' }],
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ConflictException);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      1,
    );
  });

  it('prevents a delayed single writer from restoring an assignment removed on another device', async () => {
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
    });
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: 'important', favoriteType: null }],
    });
    await expect(
      writeManagedEntityFavorites(db as never, actor, 'chat', [
        { entityId: ids[0], expectedFavoriteType: 'important', favoriteType: 'watch' },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      0,
    );
  });

  it('preserves unrelated device changes, retries an already achieved result and atomically rejects conflicts', async () => {
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[1], expectedFavoriteType: null, favoriteType: 'watch' }],
    });
    const change = { entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' };
    await service.updateComposition(user, 'chat', { changes: [change] });
    await service.updateComposition(user, 'chat', { changes: [change] });
    await expect(
      service.updateComposition(user, 'chat', {
        changes: [
          { entityId: ids[0], expectedFavoriteType: 'watch', favoriteType: 'service' },
          { entityId: ids[2], expectedFavoriteType: null, favoriteType: 'service' },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await service.resolveSelection(user, 'chat', 'watch')).entityIds).toEqual([ids[1]]);
    expect((await service.resolveSelection(user, 'chat', 'service')).entityIds).toEqual([]);
    expect(
      await db.managedEntityFavoritePreference.findUnique({ where: { userId: actor } }),
    ).toBeNull();
  });

  it('shares serialization with legacy single writes and refuses wrong-type/denied/Publisher targets', async () => {
    await Promise.allSettled([
      writeManagedEntityFavorites(db as never, actor, 'chat', [
        { entityId: ids[0], favoriteType: 'watch', expectedFavoriteType: null },
      ]),
      service.updateComposition(user, 'chat', {
        changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
      }),
    ]);
    expect(await db.managedEntityFavorite.count({ where: { userId: actor, chatId: ids[0] } })).toBe(
      1,
    );
    for (const id of [ids[3], ids[4], ids[5]]) {
      await expect(
        service.updateComposition(user, 'chat', {
          changes: [{ entityId: id, expectedFavoriteType: null, favoriteType: 'important' }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('keeps a category cursor after an unrelated change and invalidates it when a member loses access', async () => {
    await service.updateComposition(user, 'chat', {
      changes: ids
        .slice(0, 2)
        .map((entityId) => ({ entityId, favoriteType: 'important', expectedFavoriteType: null })),
    });
    const scope = { favoriteType: 'important', limit: 1 };
    const page = await service.entries(user, 'chat', scope);
    expect(page.nextCursor).toBeTruthy();
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[2], expectedFavoriteType: null, favoriteType: 'watch' }],
    });
    const next = await service.entries(user, 'chat', { ...scope, cursor: page.nextCursor });
    expect(next.compositionVersion).toBe(page.compositionVersion);
    expect(next.items.map((row) => row.id)).toEqual([ids[1]]);
    const edge = { chatId_userId_botId: { chatId: ids[1], userId: actor, botId: bot } };
    await db.managedEntityAccessEdge.update({ where: edge, data: { state: 'USER_DENIED' } });
    try {
      await expect(
        service.entries(user, 'chat', { ...scope, cursor: page.nextCursor }),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await db.managedEntityAccessEdge.update({ where: edge, data: { state: 'GRANTED' } });
    }
  });

  it('binds pagination to actor/filter/composition and invalidates only the affected network selection', async () => {
    const beforeWatch = await service.resolveSelection(user, 'chat', 'watch');
    const page = await service.entries(user, 'chat', { limit: 1 });
    await expect(
      service.entries(user, 'chat', { limit: 1, search: 'other', cursor: page.nextCursor }),
    ).rejects.toThrow('Недействительный курсор');
    await service.updateComposition(user, 'chat', {
      changes: [{ entityId: ids[0], expectedFavoriteType: null, favoriteType: 'important' }],
    });
    await expect(
      service.entries(user, 'chat', { limit: 1, cursor: page.nextCursor }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await service.resolveSelection(user, 'chat', 'watch')).compositionVersion).toBe(
      beforeWatch.compositionVersion,
    );
  });
});
