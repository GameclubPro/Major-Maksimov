import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  enqueueGiveawayResultsSync,
  processGiveawayResultsSync,
} from './managed-giveaway-results-sync';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

native('managed giveaway result revisions on PostgreSQL', () => {
  let writer: PrismaClient;
  let worker: PrismaClient;
  const chatId = `giveaway-sync-${randomUUID()}`;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl
    )
      throw new Error('Giveaway result tests require a disposable local race_test database');
    writer = createPrismaClient(databaseUrl);
    worker = createPrismaClient(databaseUrl);
    await writer.chat.create({ data: { id: chatId, title: 'Giveaway results sync fixture' } });
  });

  afterAll(async () => {
    try {
      if (writer) await writer.chat.deleteMany({ where: { id: chatId } });
    } finally {
      await Promise.all([writer?.$disconnect(), worker?.$disconnect()]);
    }
  });

  async function completeEmptyGiveaway(options?: { allowCreate: boolean }) {
    return writer.$transaction(async (tx) => {
      const { id } = await tx.managedGiveaway.create({
        data: {
          sourceChatId: chatId,
          actorUserId: 'organizer',
          entityType: 'CHANNEL',
          title: 'Empty giveaway',
          status: 'COMPLETED',
          endsAt: new Date(),
          completedAt: new Date(),
        },
        select: { id: true },
      });
      await enqueueGiveawayResultsSync(tx, id, options);
      return id;
    });
  }

  it('recovers a committed result without winner notifications from another connection', async () => {
    const giveawayId = await completeEmptyGiveaway();
    expect(await worker.managedGiveawayWinner.count({ where: { giveawayId } })).toBe(0);
    const publish = jest.fn(async (assertCurrent: () => Promise<void>) => {
      await assertCurrent();
      return true;
    });
    expect(await processGiveawayResultsSync(worker, giveawayId, publish)).toBe(true);
    expect(await processGiveawayResultsSync(writer, giveawayId, publish)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes without creating work in the reader phase and drains saved revisions after rollback', async () => {
    const reader = { allowCreate: false };
    const giveawayId = await completeEmptyGiveaway(reader);
    const where = { giveawayId };
    const publishWithoutIntent = jest.fn(async () => true);
    const compatibility = { publishWithoutIntent };
    const publishRevision = jest.fn(async (assertCurrent: () => Promise<void>) => {
      await assertCurrent();
      return true;
    });

    expect(await worker.managedGiveawayResultsSync.findUnique({ where })).toBeNull();
    await expect(
      processGiveawayResultsSync(worker, giveawayId, publishRevision, compatibility),
    ).resolves.toBe(true);
    expect(publishWithoutIntent).toHaveBeenCalledTimes(1);
    expect(publishRevision).not.toHaveBeenCalled();
    expect(await worker.managedGiveawayResultsSync.findUnique({ where })).toBeNull();

    await writer.$transaction((tx) =>
      enqueueGiveawayResultsSync(tx, giveawayId, { allowCreate: true }),
    );
    await expect(processGiveawayResultsSync(worker, giveawayId, publishRevision)).resolves.toBe(
      true,
    );
    expect(await writer.managedGiveawayResultsSync.findUniqueOrThrow({ where })).toMatchObject({
      revision: 1,
      nextAttemptAt: null,
    });

    await writer.$transaction((tx) => enqueueGiveawayResultsSync(tx, giveawayId, reader));
    const rescheduled = await worker.managedGiveawayResultsSync.findUniqueOrThrow({ where });
    expect(rescheduled.revision).toBe(2);
    expect(rescheduled.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(
      processGiveawayResultsSync(worker, giveawayId, publishRevision, compatibility),
    ).resolves.toBe(true);
    await expect(
      processGiveawayResultsSync(worker, giveawayId, publishRevision, compatibility),
    ).resolves.toBe(true);
    expect(publishRevision).toHaveBeenCalledTimes(2);
    expect(publishWithoutIntent).toHaveBeenCalledTimes(1);
    expect(await worker.managedGiveawayResultsSync.findUniqueOrThrow({ where })).toMatchObject({
      revision: 2,
      nextAttemptAt: null,
      leaseToken: null,
    });
  });

  it('preserves a newer revision when an earlier worker reaches final authority', async () => {
    const giveawayId = await completeEmptyGiveaway();
    const duplicate = jest.fn(async () => true);
    const obsoleteEffect = jest.fn();
    expect(
      await processGiveawayResultsSync(worker, giveawayId, async (assertCurrent) => {
        await writer.$transaction((tx) => enqueueGiveawayResultsSync(tx, giveawayId));
        expect(await processGiveawayResultsSync(writer, giveawayId, duplicate)).toBe(false);
        expect(duplicate).not.toHaveBeenCalled();
        await assertCurrent();
        obsoleteEffect();
        return true;
      }),
    ).toBe(false);
    expect(obsoleteEffect).not.toHaveBeenCalled();
    const retained = await writer.managedGiveawayResultsSync.findUniqueOrThrow({
      where: { giveawayId },
    });
    expect(retained.revision).toBe(2);
    expect(retained.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(retained.leaseToken).toBeNull();
    expect(await processGiveawayResultsSync(writer, giveawayId, duplicate)).toBe(true);
    expect(duplicate).toHaveBeenCalledTimes(1);
  });
});
