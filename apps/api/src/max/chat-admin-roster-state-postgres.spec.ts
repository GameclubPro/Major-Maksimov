import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient, type Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from './max-client.service';
import { AutomaticDeleteAuthorAccessService } from './automatic-delete-author-access.service';
import {
  ADMIN_ROSTER_ACTIVE_REFRESH_MS,
  ADMIN_ROSTER_REFRESH_RETRY_MS,
  claimActiveAdminRosterRefresh,
  clearChatAdminRoster,
  completeAdminRoster,
  hasNewerCompleteAdminRoster,
  invalidateAdminRosterCompleteness,
} from './chat-admin-roster-state';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

native('automatic-delete administrator roster on native PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  const ownedChats = new Set<string>();
  const now = new Date('2026-11-08T00:00:00Z');

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL race_test database required');
    db = createPrismaClient(databaseUrl, { max: 4 });
  });
  beforeEach(async () => {
    chatId = `-admin-roster-${randomUUID()}`;
    ownedChats.add(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Roster fixture' } });
  });
  afterEach(async () => {
    await db.chat.deleteMany({ where: { id: { in: [...ownedChats] } } });
    ownedChats.clear();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const state = (id = chatId) => db.chatAdminRosterState.findUnique({ where: { chatId: id } });
  const siblingChat = async () => {
    const id = `-admin-roster-${randomUUID()}`;
    ownedChats.add(id);
    await db.chat.create({ data: { id, title: 'Roster fixture' } });
    return id;
  };
  const seedCompleteState = (id = chatId) =>
    db.chatAdminRosterState.create({
      data: {
        chatId: id,
        completeProbeStartedAt: now,
        completedAt: new Date(now.getTime() + 1_000),
        refreshRequestedAt: new Date(now.getTime() + 2_000),
      },
    });
  const locked = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      return run(tx);
    });

  it('distinguishes an empty complete roster from missing or targeted-only evidence', async () => {
    expect(await state()).toBeNull();
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'actor' } });
    expect(await state()).toMatchObject({ completedAt: null, completeProbeStartedAt: null });
    await db.chatAdminAllowlist.deleteMany({ where: { chatId } });
    const unknown = await state();
    expect(unknown?.completedAt).toBeNull();
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    const complete = await state();
    expect(complete?.completeProbeStartedAt).toEqual(now);
    expect(complete?.completedAt).toBeInstanceOf(Date);
    expect(complete?.revision).not.toBe(unknown?.revision);
    expect(await db.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
  });

  it('rotates proof for actual allowlist mutations from old/raw writers and preserves no-op proof', async () => {
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'actor' } });
    const created = await state();
    await db.chatAdminAllowlist.upsert({
      where: { chatId_userId: { chatId, userId: 'actor' } },
      create: { chatId, userId: 'actor' },
      update: {},
    });
    expect((await state())?.revision).toBe(created?.revision);
    await db.$queryRaw`UPDATE chat_admin_allowlist SET user_id = 'renamed' WHERE chat_id = ${chatId} RETURNING user_id`;
    const renamed = await state();
    expect(renamed?.revision).not.toBe(created?.revision);
    await db.chatAdminAllowlist.deleteMany({ where: { chatId } });
    expect((await state())?.revision).not.toBe(renamed?.revision);
    expect((await state())?.completedAt).toBeNull();
  });

  it('handles bulk inserts across chats without changing completeness or refresh reservations', async () => {
    const otherChatId = await siblingChat();
    const untouchedChatId = await siblingChat();
    const before = await seedCompleteState();
    const untouched = await seedCompleteState(untouchedChatId);

    await db.chatAdminAllowlist.createMany({
      data: [
        { chatId, userId: 'alpha' },
        { chatId, userId: 'beta' },
        { chatId: otherChatId, userId: 'alpha' },
        { chatId: otherChatId, userId: 'beta' },
      ],
    });

    const inserted = await state();
    expect(inserted).toEqual({ ...before, revision: expect.any(String) });
    expect(inserted?.revision).not.toBe(before.revision);
    expect(await state(otherChatId)).toMatchObject({
      chatId: otherChatId,
      revision: expect.any(String),
      completeProbeStartedAt: null,
      completedAt: null,
      refreshRequestedAt: null,
    });
    expect(await state(untouchedChatId)).toEqual(untouched);
    expect(
      await db.chatAdminAllowlist.count({ where: { chatId: { in: [chatId, otherChatId] } } }),
    ).toBe(4);
  });

  it('invalidates both chats for a bulk raw membership move and preserves unrelated proof', async () => {
    const destinationChatId = await siblingChat();
    const untouchedChatId = await siblingChat();
    await seedCompleteState();
    await seedCompleteState(destinationChatId);
    const untouched = await seedCompleteState(untouchedChatId);
    await db.chatAdminAllowlist.createMany({
      data: [
        { chatId, userId: 'alpha' },
        { chatId, userId: 'beta' },
        { chatId: destinationChatId, userId: 'existing' },
      ],
    });
    const sourceBefore = (await state())!;
    const destinationBefore = (await state(destinationChatId))!;

    expect(
      await db.$executeRaw`
        UPDATE chat_admin_allowlist
        SET chat_id = ${destinationChatId}, user_id = user_id || '-moved'
        WHERE chat_id = ${chatId}
      `,
    ).toBe(2);

    const sourceAfter = await state();
    const destinationAfter = await state(destinationChatId);
    expect(sourceAfter).toEqual({ ...sourceBefore, revision: expect.any(String) });
    expect(sourceAfter?.revision).not.toBe(sourceBefore.revision);
    expect(destinationAfter).toEqual({
      ...destinationBefore,
      revision: expect.any(String),
    });
    expect(destinationAfter?.revision).not.toBe(destinationBefore.revision);
    expect(await state(untouchedChatId)).toEqual(untouched);
    expect(await db.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
    expect(
      await db.chatAdminAllowlist.findMany({
        where: { chatId: destinationChatId },
        select: { userId: true },
        orderBy: { userId: 'asc' },
      }),
    ).toEqual([{ userId: 'alpha-moved' }, { userId: 'beta-moved' }, { userId: 'existing' }]);
  });

  it('preserves exact proof for duplicate inserts, metadata-only updates and empty statements', async () => {
    const emptyChatId = await siblingChat();
    await seedCompleteState();
    await db.chatAdminAllowlist.createMany({
      data: [
        { chatId, userId: 'alpha' },
        { chatId, userId: 'beta' },
      ],
    });
    const before = await state();
    expect(
      await db.chatAdminAllowlist.createMany({
        data: [
          { chatId, userId: 'alpha' },
          { chatId, userId: 'beta' },
        ],
        skipDuplicates: true,
      }),
    ).toEqual({ count: 0 });
    expect(
      await db.$executeRaw`
        UPDATE chat_admin_allowlist SET created_at = created_at + interval '1 second'
        WHERE chat_id = ${chatId}
      `,
    ).toBe(2);
    expect(
      await db.$executeRaw`
        UPDATE chat_admin_allowlist SET chat_id = chat_id, user_id = user_id
        WHERE chat_id = ${chatId}
      `,
    ).toBe(2);
    expect(
      await db.$executeRaw`
        INSERT INTO chat_admin_allowlist (chat_id, user_id) VALUES (${chatId}, 'alpha')
        ON CONFLICT (chat_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      `,
    ).toBe(1);
    expect(
      await db.$executeRaw`
        INSERT INTO chat_admin_allowlist (chat_id, user_id)
        SELECT ${emptyChatId}, 'absent' WHERE FALSE
      `,
    ).toBe(0);
    expect(
      await db.$executeRaw`
        UPDATE chat_admin_allowlist SET user_id = 'absent' WHERE chat_id = ${emptyChatId}
      `,
    ).toBe(0);
    expect(
      await db.$executeRaw`DELETE FROM chat_admin_allowlist WHERE chat_id = ${emptyChatId}`,
    ).toBe(0);

    expect(await state()).toEqual(before);
    expect(await state(emptyChatId)).toBeNull();
    expect(await db.chatAdminAllowlist.count({ where: { chatId } })).toBe(2);
  });

  it('preserves metadata after bulk deletes and never recreates state during parent cascades', async () => {
    const otherChatId = await siblingChat();
    const untouchedChatId = await siblingChat();
    await seedCompleteState();
    await seedCompleteState(otherChatId);
    const untouched = await seedCompleteState(untouchedChatId);
    await db.chatAdminAllowlist.createMany({
      data: [chatId, otherChatId].flatMap((id) =>
        ['alpha', 'beta', 'keep'].map((userId) => ({ chatId: id, userId })),
      ),
    });
    const before = (await state())!;
    const otherBefore = (await state(otherChatId))!;

    expect(
      await db.$executeRaw`
        DELETE FROM chat_admin_allowlist
        WHERE chat_id IN (${chatId}, ${otherChatId}) AND user_id <> 'keep'
      `,
    ).toBe(4);

    const deleted = await state();
    const otherDeleted = await state(otherChatId);
    expect(deleted).toEqual({ ...before, revision: expect.any(String) });
    expect(deleted?.revision).not.toBe(before.revision);
    expect(otherDeleted).toEqual({ ...otherBefore, revision: expect.any(String) });
    expect(otherDeleted?.revision).not.toBe(otherBefore.revision);
    expect(await state(untouchedChatId)).toEqual(untouched);
    expect(
      await db.chatAdminAllowlist.count({ where: { chatId: { in: [chatId, otherChatId] } } }),
    ).toBe(2);

    await db.chat.deleteMany({ where: { id: { in: [chatId, otherChatId] } } });
    expect(await state()).toBeNull();
    expect(await state(otherChatId)).toBeNull();
    expect(
      await db.chatAdminAllowlist.count({ where: { chatId: { in: [chatId, otherChatId] } } }),
    ).toBe(0);
    expect(await state(untouchedChatId)).toEqual(untouched);
  });

  it('never moves the complete observation backwards and renews unchanged accepted rosters', async () => {
    const newer = new Date(now.getTime() + 1_000);
    await locked((tx) => completeAdminRoster(tx, chatId, newer));
    const accepted = await state();
    expect(await hasNewerCompleteAdminRoster(db, chatId, now)).toBe(true);
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    expect(await state()).toEqual(accepted);
    await locked((tx) => completeAdminRoster(tx, chatId, new Date(newer.getTime() + 1_000)));
    expect((await state())?.revision).not.toBe(accepted?.revision);
  });

  it('initializes one distributed refresh, retries after bounded failure, and respects successful freshness', async () => {
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => claimActiveAdminRosterRefresh(db, chatId, now)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimActiveAdminRosterRefresh(db, chatId, new Date(now.getTime() + 1))).toBe(
      false,
    );
    expect(
      await claimActiveAdminRosterRefresh(
        db,
        chatId,
        new Date(now.getTime() + ADMIN_ROSTER_REFRESH_RETRY_MS),
      ),
    ).toBe(true);
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    const completedAt = (await state())!.completedAt!;
    expect(await claimActiveAdminRosterRefresh(db, chatId, completedAt)).toBe(false);
    expect(
      await claimActiveAdminRosterRefresh(
        db,
        chatId,
        new Date(completedAt.getTime() + ADMIN_ROSTER_ACTIVE_REFRESH_MS),
      ),
    ).toBe(true);
  });

  it('makes an all-bot denial incomplete without erasing surviving targeted protection', async () => {
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'newer-actor' } });
    const complete = await state();
    await locked((tx) => invalidateAdminRosterCompleteness(tx, chatId));
    expect(await state()).toMatchObject({
      completedAt: null,
      completeProbeStartedAt: null,
      refreshRequestedAt: null,
    });
    expect((await state())?.revision).not.toBe(complete?.revision);
    expect(await db.chatAdminAllowlist.findMany({ where: { chatId } })).toHaveLength(1);
    expect(await claimActiveAdminRosterRefresh(db, chatId, now)).toBe(true);
  });

  it('keeps completeness unknown when the reservation chat does not exist', async () => {
    expect(await claimActiveAdminRosterRefresh(db, `${chatId}-missing`, now)).toBe(false);
    expect(await state()).toBeNull();
  });

  it('clears a whole roster and its completeness in one transaction before reconnection', async () => {
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    await db.chatAdminAllowlist.createMany({
      data: [
        { chatId, userId: 'admin-one' },
        { chatId, userId: 'admin-two' },
      ],
    });
    await clearChatAdminRoster(db as PrismaService, chatId);
    expect(await db.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
    expect(await state()).toMatchObject({
      completedAt: null,
      completeProbeStartedAt: null,
      refreshRequestedAt: null,
    });
    expect(await claimActiveAdminRosterRefresh(db, chatId, now)).toBe(true);
  });

  it('skips role-only MAX reads and sees a newly committed administrator inside the same dispatch scope', async () => {
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    const getChatMemberAccess = jest.fn<
      ReturnType<MaxClientService['getChatMemberAccess']>,
      Parameters<MaxClientService['getChatMemberAccess']>
    >();
    const max: Pick<MaxClientService, 'getChatMemberAccess'> = { getChatMemberAccess };
    const access = new AutomaticDeleteAuthorAccessService(
      db as PrismaService,
      max as MaxClientService,
    );
    await access.withDispatchScope(async () => {
      const prepared = await access.resolve(
        chatId,
        'id123',
        { botId: 'moderator' },
        { requireMembership: false },
      );
      expect(prepared).toMatchObject({ initialized: true, isAdmin: false, member: undefined });
      expect(getChatMemberAccess).not.toHaveBeenCalled();
      await db.chatAdminAllowlist.create({ data: { chatId, userId: '123' } });
      const current = await access.readCurrentProtection(chatId, 'id123');
      expect(current).toMatchObject({ initialized: true, isAdmin: true });
      expect(current.revision).not.toBe(prepared.revision);
    });
    expect(await access.readCurrentProtection(chatId, '123')).toMatchObject({ isAdmin: true });
    expect(getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not replace an unavailable SQL protection proof with MAX fallback', async () => {
    await locked((tx) => completeAdminRoster(tx, chatId, now));
    const getChatMemberAccess = jest.fn<
      ReturnType<MaxClientService['getChatMemberAccess']>,
      Parameters<MaxClientService['getChatMemberAccess']>
    >();
    const max: Pick<MaxClientService, 'getChatMemberAccess'> = { getChatMemberAccess };
    const access = new AutomaticDeleteAuthorAccessService(
      db as PrismaService,
      max as MaxClientService,
    );
    const read = jest
      .spyOn(db, '$queryRaw')
      .mockRejectedValueOnce(new Error('SQL proof unavailable'));
    try {
      await expect(
        access.withDispatchScope(() =>
          access.resolve(chatId, '123', { botId: 'moderator' }, { requireMembership: false }),
        ),
      ).rejects.toThrow('SQL proof unavailable');
      expect(getChatMemberAccess).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
