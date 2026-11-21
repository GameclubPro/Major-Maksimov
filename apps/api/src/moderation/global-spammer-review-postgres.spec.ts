import { randomUUID } from 'node:crypto';
import { createPrismaClient, PrismaClient } from '../prisma/prisma-client';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';

(url ? describe : describe.skip)('scoped spammer review on PostgreSQL', () => {
  let db: PrismaClient;
  let review: GlobalSpammerIntelligenceService;
  const scope = randomUUID();
  const ch1 = 'review-a-' + scope;
  const ch2 = 'review-b-' + scope;
  const target = 'review-user-' + scope;
  const adminA = 'review-admin-a-' + scope;
  const adminB = 'review-admin-b-' + scope;
  const ids = [target, ...Array.from({ length: 20 }, (_, i) => target + '-' + i)];

  beforeAll(async () => {
    const dbUrl = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) ||
      !dbUrl.pathname.includes('race_test')
    ) {
      throw new Error('Spammer review requires a disposable test database');
    }
    db = createPrismaClient(url, { max: 4, statement_timeout: 10_000 });
    review = new GlobalSpammerIntelligenceService(db as never);
    await db.chat.createMany({
      data: [
        { id: ch1, title: ch1 },
        { id: ch2, title: ch2 },
      ],
    });
    await db.globalSpammerCandidate.createMany({
      data: ids.map((userId) => ({
        userId,
        lastReason: 'synthetic',
        lastChatId: ch1,
        confidenceScore: 0.7,
        lastEvidence: { excerpt: 'private candidate excerpt' },
      })),
    });
    await db.globalSpammerCandidateChat.create({
      data: { candidateUserId: target, chatId: ch2, lastExcerpt: 'private second-chat excerpt' },
    });
    const now = new Date();
    await db.spammerObservation.create({
      data: {
        userId: target,
        chatId: ch2,
        source: 'FANOUT_REPEAT',
        score: 0.7,
        reason: 'private',
        evidenceHash: scope,
        evidence: { excerpt: 'private second-chat observation' },
        expiresAt: new Date(now.getTime() + 600_000),
      },
    });
  });

  afterAll(async () => {
    review?.onModuleDestroy();
    if (!db) return;
    await db.adminGlobalSpammerExemption.deleteMany({
      where: { adminUserId: { in: [adminA, adminB] } },
    });
    await db.globalSpammerReviewFeedback.deleteMany({ where: { userId: target } });
    await db.spammerObservation.deleteMany({ where: { userId: target } });
    await db.globalSpammerCandidate.deleteMany({ where: { userId: { in: ids } } });
    await db.globalSpammerRuntimeProfile.deleteMany({ where: { userId: target } });
    await db.chat.deleteMany({ where: { id: { in: [ch1, ch2] } } });
    await db.$disconnect();
  });

  it('pages exact chat evidence and keeps duplicate or opposite reviews local', async () => {
    const page = await review.listReviewQueue({
      chatId: ch1,
      status: 'PENDING',
      limit: 20,
      reviewerUserId: adminA,
      includeObservations: true,
      includeLocalProfiles: false,
    });
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeTruthy();
    const next = await review.listReviewQueue({
      chatId: ch1,
      status: 'PENDING',
      limit: 20,
      reviewerUserId: adminA,
      cursor: page.nextCursor!,
      includeObservations: true,
      includeLocalProfiles: false,
    });
    expect(next.items).toHaveLength(1);
    expect(new Set([...page.items, ...next.items].map(({ userId }) => userId)).size).toBe(21);
    const localTarget = [...page.items, ...next.items].find(({ userId }) => userId === target);
    expect(localTarget).toMatchObject({ lastEvidence: null, chats: [], observations: [] });
    await expect(review.assertReviewSubjectInChat(ch2, ids[1]!)).rejects.toMatchObject({
      status: 404,
    });

    const vote = {
      chatId: ch1,
      userId: target,
      reviewerUserId: adminA,
      action: 'SUPPRESS' as const,
    };
    await Promise.all([review.reviewCandidate(vote), review.reviewCandidate(vote)]);
    expect(await db.globalSpammerReviewFeedback.count({ where: { userId: target } })).toBe(1);
    const bPending = await review.listReviewQueue({
      chatId: ch2,
      status: 'PENDING',
      reviewerUserId: adminB,
      includeLocalProfiles: false,
    });
    expect(bPending.items).toEqual([
      expect.objectContaining({ userId: target, status: 'PENDING' }),
    ]);
    await review.reviewCandidate({
      chatId: ch2,
      userId: target,
      reviewerUserId: adminB,
      action: 'APPROVE',
    });
    expect(await db.globalSpammerCandidate.findUnique({ where: { userId: target } })).toMatchObject(
      {
        status: 'PENDING',
      },
    );
  });
});
