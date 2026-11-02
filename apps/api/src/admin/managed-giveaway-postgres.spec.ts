import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  createPrismaClient,
  type PrismaClient,
  type ManagedGiveawayWinnerStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { AdminService } from './admin.service';
import { ManagedGiveawayService } from './managed-giveaway.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
type Outcome = { value: unknown } | { error: unknown };

native('managed giveaway winner deadlines on PostgreSQL', () => {
  let db: PrismaClient;
  let pool: Pool;
  const applicationName = `giveaway-claim-${randomUUID()}`;
  const chatIds: string[] = [];
  const maxTransactionStates: boolean[] = [];
  let maxBoundaryCalls = 0;
  const user: AuthUser = { userId: 'giveaway-user', username: null, displayName: 'Participant' };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl
    )
      throw new Error('Giveaway races require a disposable local race_test database');
    pool = new Pool({ connectionString: databaseUrl, max: 3, statement_timeout: 10_000 });
    const actual = await pool.query<{ version: string; timezone: string }>(
      "SELECT version() AS version, current_setting('TimeZone') AS timezone",
    );
    expect(actual.rows[0]?.version).toMatch(/^PostgreSQL 16\./u);
    expect(actual.rows[0]?.timezone).toBe('UTC');
    db = createPrismaClient(databaseUrl, {
      max: 2,
      application_name: applicationName,
      statement_timeout: 10_000,
    });
    await db.$connect();
  });

  afterEach(async () => {
    const observedStates = maxTransactionStates.splice(0);
    const expectedObservations = maxBoundaryCalls;
    maxBoundaryCalls = 0;
    try {
      expect(observedStates).toHaveLength(expectedObservations);
      expect(observedStates).not.toContain(true);
    } finally {
      if (db) await db.chat.deleteMany({ where: { id: { in: chatIds.splice(0) } } });
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
    await pool?.end();
  });

  async function assertOutsideTransaction() {
    maxBoundaryCalls += 1;
    const state = await pool.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND xact_start IS NOT NULL) AS active`,
      [applicationName],
    );
    const active = state.rows[0]?.active;
    if (active !== undefined) maxTransactionStates.push(active);
    expect(active).toBe(false);
  }

  async function fixture(status: ManagedGiveawayWinnerStatus = 'SELECTED') {
    const chatId = `giveaway-native-${randomUUID()}`;
    chatIds.push(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Giveaway native fixture' } });
    const giveaway = await db.managedGiveaway.create({
      data: {
        sourceChatId: chatId,
        entityType: 'CHANNEL',
        actorUserId: 'giveaway-admin',
        title: 'Native deadline fixture',
        status: 'COMPLETED',
        endsAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        publishedAt: new Date(Date.now() - 120_000),
        resultsMessageId: `results-${randomUUID()}`,
        resultsBotId: 'giveaway-bot',
        prizes: { create: { position: 1, title: 'Prize', displayTitle: 'Prize' } },
        entries: {
          create: { userId: user.userId, displayName: 'Participant', eligibilityState: 'VERIFIED' },
        },
      },
      include: { prizes: true, entries: true },
    });
    const winner = await db.managedGiveawayWinner.create({
      data: {
        giveawayId: giveaway.id,
        prizeId: giveaway.prizes[0]!.id,
        entryId: giveaway.entries[0]!.id,
        status,
        claimDeadlineAt: new Date(Date.now() + 60_000),
        ...(status === 'CLAIMED' ? { claimedAt: new Date() } : {}),
      },
    });
    const max: jest.Mocked<
      Pick<
        MaxClientService,
        'hasChatMember' | 'editMessageInlineKeyboard' | 'sendMessageImmediateWithResolvedLink'
      >
    > = {
      hasChatMember: jest.fn().mockImplementation(async () => {
        await assertOutsideTransaction();
        return true;
      }),
      editMessageInlineKeyboard: jest.fn().mockImplementation(assertOutsideTransaction),
      sendMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async () => {
        await assertOutsideTransaction();
        return { messageId: 'unexpected-new-send', url: null };
      }),
    };
    const admin: jest.Mocked<Pick<AdminService, 'getChannelSettings'>> = {
      getChannelSettings: jest.fn(),
    };
    const cache: jest.Mocked<Pick<ChatContextCacheService, 'invalidate'>> = {
      invalidate: jest.fn(),
    };
    const service = new ManagedGiveawayService(
      db as unknown as PrismaService,
      max as unknown as MaxClientService,
      cache as unknown as ChatContextCacheService,
      admin as unknown as AdminService,
      new ConfigService({ MAX_BOT_TOKEN: 'synthetic-giveaway-token', MAX_BOT_ID: 'giveaway-bot' }),
    );
    const deliver = () =>
      service.markManagedGiveawayWinnerDelivered(
        chatId,
        giveaway.id,
        { ...user, userId: 'giveaway-admin' },
        { winnerId: winner.id },
        'channel',
      );
    return { chatId, giveaway, winner, max, admin, service, deliver };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function setDeadline(f: Fixture, seconds: number) {
    const row = await pool.query<{ deadline: Date }>(
      `UPDATE managed_giveaway_winners
        SET claim_deadline_at = (clock_timestamp() AT TIME ZONE 'UTC') + $2 * interval '1 second'
        WHERE id = $1 RETURNING claim_deadline_at AS deadline`,
      [f.winner.id, seconds],
    );
    return row.rows[0]!.deadline;
  }

  async function waitForBlockedWriter(blockerPid: number) {
    const until = Date.now() + 3_000;
    do {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1
          AND $2 = ANY(pg_blocking_pids(pid))) AS blocked`,
        [applicationName, blockerPid],
      );
      if (result.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < until);
    throw new Error('Giveaway writer did not reach the exact winner row lock');
  }

  async function waitForDeadline(deadline: Date) {
    const until = Date.now() + 3_000;
    do {
      const result = await pool.query<{ expired: boolean }>(
        "SELECT (clock_timestamp() AT TIME ZONE 'UTC') >= $1::timestamp AS expired",
        [deadline],
      );
      if (result.rows[0]?.expired) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < until);
    throw new Error('Native PostgreSQL clock did not reach the claim deadline');
  }

  async function blockedWrite(
    f: Fixture,
    write: () => Promise<unknown>,
    afterBlocked: (blocker: PoolClient) => Promise<void>,
  ): Promise<Outcome> {
    const blocker = await pool.connect();
    let writing: Promise<Outcome> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM managed_giveaway_winners WHERE id = $1 FOR UPDATE', [
        f.winner.id,
      ]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      writing = write().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitForBlockedWriter(pid);
      await afterBlocked(blocker);
    } finally {
      await blocker.query('COMMIT').catch(async () => {
        await blocker.query('ROLLBACK');
      });
      blocker.release();
      if (writing) await writing;
    }
    return writing!;
  }

  async function assertNoWinnerEffects(f: Fixture) {
    expect(
      await db.managedGiveawayWinner.findUniqueOrThrow({ where: { id: f.winner.id } }),
    ).toMatchObject({
      status: 'SELECTED',
      claimedAt: null,
      deliveredAt: null,
    });
    expect(await db.auditLog.count({ where: { chatId: f.chatId } })).toBe(0);
    expect(f.max.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(f.max.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  }

  it.each(['claim', 'delivery'] as const)(
    'rejects %s when the deadline elapses during the winner row lock wait',
    async (action) => {
      const f = await fixture();
      const deadline = await setDeadline(f, 2);
      const result = await blockedWrite(
        f,
        action === 'claim' ? () => f.service.claimGiveaway(f.giveaway.id, user) : f.deliver,
        async () => {
          const now = (
            await pool.query<{ now: Date }>("SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now")
          ).rows[0]!.now;
          expect(now.getTime()).toBeLessThan(deadline.getTime());
          await waitForDeadline(deadline);
        },
      );
      await assertNoWinnerEffects(f);
      expect('error' in result ? result.error : result.value).toBeInstanceOf(ConflictException);
      expect(f.max.hasChatMember).toHaveBeenCalledTimes(action === 'claim' ? 1 : 0);
    },
    15_000,
  );

  it.each(['claim', 'delivery'] as const)(
    'rejects %s when expiration commits before the waiting writer obtains the lock',
    async (action) => {
      const f = await fixture();
      const result = await blockedWrite(
        f,
        action === 'claim' ? () => f.service.claimGiveaway(f.giveaway.id, user) : f.deliver,
        async (blocker) => {
          await blocker.query(
            "UPDATE managed_giveaway_winners SET status = 'EXPIRED', expired_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = $1",
            [f.winner.id],
          );
        },
      );
      expect('error' in result ? result.error : result.value).toBeInstanceOf(ConflictException);
      expect(
        await db.managedGiveawayWinner.findUniqueOrThrow({ where: { id: f.winner.id } }),
      ).toMatchObject({
        status: 'EXPIRED',
        claimedAt: null,
        deliveredAt: null,
      });
      expect(await db.auditLog.count({ where: { chatId: f.chatId } })).toBe(0);
      expect(f.max.editMessageInlineKeyboard).not.toHaveBeenCalled();
      expect(f.max.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it('claims before the deadline and preserves the already-CLAIMED response after expiry', async () => {
    const f = await fixture();
    await expect(f.service.claimGiveaway(f.giveaway.id, user)).resolves.toMatchObject({
      ok: true,
      winner: { status: 'CLAIMED' },
    });
    await setDeadline(f, -1);
    await expect(f.service.claimGiveaway(f.giveaway.id, user)).resolves.toMatchObject({
      ok: true,
      winner: { status: 'CLAIMED' },
    });
    expect(f.max.hasChatMember).toHaveBeenCalledTimes(1);
    expect(f.max.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(await db.auditLog.count({ where: { chatId: f.chatId } })).toBe(1);
  });

  it.each(['claim', 'delivery'] as const)(
    'keeps a legacy null deadline valid for %s',
    async (action) => {
      const f = await fixture();
      await db.managedGiveawayWinner.update({
        where: { id: f.winner.id },
        data: { claimDeadlineAt: null },
      });
      if (action === 'claim') {
        await expect(f.service.claimGiveaway(f.giveaway.id, user)).resolves.toMatchObject({
          winner: { status: 'CLAIMED', claimDeadlineAt: null },
        });
      } else {
        await expect(f.deliver()).resolves.toMatchObject({
          winners: [{ status: 'DELIVERED', claimDeadlineAt: null }],
        });
      }
    },
  );

  it('allows a CLAIMED winner to be marked delivered after the claim deadline', async () => {
    const f = await fixture('CLAIMED');
    await setDeadline(f, -1);
    await expect(f.deliver()).resolves.toMatchObject({ winners: [{ status: 'DELIVERED' }] });
    expect(f.max.hasChatMember).not.toHaveBeenCalled();
    expect(await db.auditLog.count({ where: { chatId: f.chatId } })).toBe(1);
  });
});
