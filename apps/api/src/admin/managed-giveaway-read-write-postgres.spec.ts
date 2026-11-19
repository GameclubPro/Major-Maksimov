import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  type GiveawayDrawEntryUpdate,
  writeGiveawayDrawEntries,
} from './managed-giveaway-draw-write';
import {
  GIVEAWAY_NOTIFICATION_INCLUDE,
  readGiveawayHistoryPage,
  readGiveawayParticipant,
  readPublicGiveaway,
} from './managed-giveaway-read-model';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim();
const native = databaseUrl ? describe : describe.skip;

native('giveaway projections and draw writes on PostgreSQL', () => {
  let db: PrismaClient;
  const chatId = `giveaway-projections-${randomUUID()}`;
  const createdAt = new Date('2026-01-01T12:00:00.000Z');

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl
    ) {
      throw new Error('Giveaway tests require a disposable local race_test database');
    }
    db = createPrismaClient(databaseUrl, { max: 2, statement_timeout: 10_000 });
    await db.chat.create({ data: { id: chatId, title: 'Giveaway test' } });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.chat.deleteMany({ where: { id: chatId } });
    } finally {
      await db.$disconnect();
    }
  });

  const createGiveaway = (key: string, archived = false) =>
    db.managedGiveaway.create({
      data: {
        id: `${chatId}-${key}`,
        sourceChatId: chatId,
        title: key,
        actorUserId: 'organizer',
        endsAt: createdAt,
        createdAt,
        publishedAt: createdAt,
        status: 'COMPLETED',
        imageEnabled: true,
        imageBase64: 'stored-image',
        archivedAt: archived ? createdAt : null,
      },
    });

  it('keeps public counts, personal entries and history consistent without returning the audience or image', async () => {
    const draw = await createGiveaway('b');
    const previous = await createGiveaway('a');
    const archived = await createGiveaway('z', true);
    const prize = await db.managedGiveawayPrize.create({
      data: { giveawayId: draw.id, title: 'Prize', position: 1 },
    });
    const data = [
      { userId: 'winner', eligibilityState: 'VERIFIED' },
      { userId: 'old', eligibilityState: 'VERIFIED' },
      { userId: 'unchecked', eligibilityState: 'PENDING' },
      { userId: 'refused', eligibilityState: 'REJECTED' },
    ] as const;
    for (const row of data) {
      await db.managedGiveawayEntry.create({
        data: { ...row, id: draw.id + row.userId, giveawayId: draw.id },
      });
    }
    await db.managedGiveawayWinner.create({
      data: {
        giveawayId: draw.id,
        prizeId: prize.id,
        entryId: draw.id + 'old',
        status: 'REROLLED',
      },
    });
    const winner = await db.managedGiveawayWinner.create({
      data: {
        giveawayId: draw.id,
        prizeId: prize.id,
        entryId: draw.id + 'winner',
        status: 'DELIVERED',
      },
    });
    const publicRow = await readPublicGiveaway(db, draw.id);
    expect(publicRow?._count.entries).toBe(3);
    expect(publicRow?.winners.map((w) => w.id)).toEqual([winner.id]);
    expect(publicRow).not.toHaveProperty('entries');
    expect(publicRow).not.toHaveProperty('imageBase64');
    const personal = await readGiveawayParticipant(db, draw.id, 'refused');
    expect(personal?.entries.map((row) => row.userId)).toEqual(['refused']);
    expect(personal?.winners).toEqual([]);
    expect(
      (await readGiveawayParticipant(db, draw.id, 'winner'))?.winners.map((w) => w.id),
    ).toEqual([winner.id]);
    expect((await readGiveawayParticipant(db, draw.id, 'unregistered'))?.entries).toEqual([]);
    expect(personal).not.toHaveProperty('imageBase64');
    const notification = await db.managedGiveawayWinnerNotification.create({
      data: { winnerId: winner.id },
      include: GIVEAWAY_NOTIFICATION_INCLUDE,
    });
    expect(notification.winner.giveaway.id).toBe(draw.id);
    expect(notification.winner.giveaway).not.toHaveProperty('imageBase64');
    const first = await readGiveawayHistoryPage(db, chatId, 'CHAT', { take: 1 });
    expect(first).toMatchObject([
      {
        id: draw.id,
        entriesCount: 4,
        verifiedEntriesCount: 2,
        pendingEntriesCount: 1,
        winnersCount: 1,
      },
    ]);
    const second = await readGiveawayHistoryPage(db, chatId, 'CHAT', {
      take: 1,
      before: { createdAt, id: draw.id },
    });
    expect(second.map((row) => row.id)).toEqual([previous.id]);
    expect((await readPublicGiveaway(db, archived.id))?.id).toBe(archived.id);
  });

  it('updates 1001 draw ranks and rolls back the first batch if another giveaway owns the last entry', async () => {
    const giveaway = await createGiveaway('batch');
    const neighbor = await createGiveaway('neighbor');
    const foreign = await db.managedGiveawayEntry.create({
      data: { giveawayId: neighbor.id, userId: 'other' },
    });
    const rows: GiveawayDrawEntryUpdate[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `${giveaway.id}-${i}`,
      eligibilityState: i % 2 === 0 ? 'VERIFIED' : 'REJECTED',
      eligibilityReason: i % 2 === 0 ? null : 'Missing channel',
      missingChannelIds: i % 2 === 0 ? [] : ['required'],
      drawRank: i % 2 === 0 ? `rank-${i}` : null,
    }));
    await db.managedGiveawayEntry.createMany({
      data: rows.map((row, i) => ({ id: row.id, giveawayId: giveaway.id, userId: `u${i}` })),
    });
    const checkedAt = new Date();
    const invalid = rows.map((row, i) => (i === 1000 ? { ...row, id: foreign.id } : row));
    await expect(
      db.$transaction((tx) => writeGiveawayDrawEntries(tx, giveaway.id, invalid, checkedAt)),
    ).rejects.toThrow('Giveaway entry set changed during draw');
    expect(
      await db.managedGiveawayEntry.count({
        where: { giveawayId: giveaway.id, eligibilityState: 'PENDING', checkedAt: null },
      }),
    ).toBe(1001);
    expect(
      (await db.managedGiveawayEntry.findUniqueOrThrow({ where: { id: foreign.id } })).checkedAt,
    ).toBeNull();
    await db.$transaction((tx) => writeGiveawayDrawEntries(tx, giveaway.id, rows, checkedAt));
    expect(
      await db.managedGiveawayEntry.count({
        where: { giveawayId: giveaway.id, eligibilityState: 'VERIFIED', checkedAt },
      }),
    ).toBe(501);
    expect(
      await db.managedGiveawayEntry.findUniqueOrThrow({ where: { id: rows[999]!.id } }),
    ).toMatchObject({
      eligibilityState: 'REJECTED',
      eligibilityReason: 'Missing channel',
      missingChannelIds: ['required'],
      drawRank: null,
      checkedAt,
    });
    expect(
      await db.managedGiveawayEntry.findUniqueOrThrow({ where: { id: rows[1000]!.id } }),
    ).toMatchObject({
      eligibilityState: 'VERIFIED',
      eligibilityReason: null,
      missingChannelIds: [],
      drawRank: 'rank-1000',
      checkedAt,
    });
  });
});
