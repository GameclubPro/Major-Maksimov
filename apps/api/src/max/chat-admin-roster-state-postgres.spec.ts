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
    await db.chat.create({ data: { id: chatId, title: 'Roster fixture' } });
  });
  afterEach(async () => {
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const state = () => db.chatAdminRosterState.findUnique({ where: { chatId } });
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
