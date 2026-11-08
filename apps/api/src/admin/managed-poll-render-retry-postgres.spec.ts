import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  type ManagedPoll,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import type { AdminService } from './admin.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { ManagedPollService } from './managed-poll.service';
import {
  managedPollRenderSelection,
  MANAGED_POLL_RENDER_FORMAT_VERSION,
} from './managed-poll-render-selection';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const minute = 60_000;
type Internal = {
  renderPollPublication: ManagedPollService['renderPollPublication'];
  loadPollAggregate: ManagedPollService['loadPollAggregate'];
  deferPollRender: ManagedPollService['deferPollRender'];
  markPollRendered: ManagedPollService['markPollRendered'];
  pollRenderRetryKey: ManagedPollService['pollRenderRetryKey'];
};

native('durable managed poll render retries on PostgreSQL and Redis', () => {
  let db: PrismaClient;
  let redis: RedisCounterService;
  let chatId: string;
  const keys = new Set<string>();
  const max: jest.Mocked<
    Pick<MaxClientService, 'editMessageInlineKeyboard' | 'getExactMessagePresence'>
  > = {
    editMessageInlineKeyboard: jest.fn(),
    getExactMessagePresence: jest.fn(),
  };
  const admin: jest.Mocked<Pick<AdminService, 'assertManagedEntityAdminAccess'>> = {
    assertManagedEntityAdminAccess: jest.fn(),
  };

  beforeAll(async () => {
    for (const value of [databaseUrl, redisUrl]) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname))
        throw new Error('Poll retry tests require disposable local stores');
    }
    if (
      !new URL(databaseUrl).pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl
    )
      throw new Error('Poll retries require the isolated race_test database');
    db = createPrismaClient(databaseUrl, { max: 3, statement_timeout: 10_000 });
    await db.$connect();
    const [store] = await db.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone
    `;
    expect(store?.version).toMatch(/^PostgreSQL 16\./u);
    expect(store?.timezone).toBe('UTC');
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl }));
    expect(await redis.getString(`poll-test-attest-${randomUUID()}`)).toBeNull();
  });

  beforeEach(async () => {
    chatId = `poll-retry-native-${randomUUID()}`;
    await db.chat.create({
      data: { id: chatId, title: 'Native retry fixture', entityType: 'CHAT' },
    });
    max.editMessageInlineKeyboard.mockReset().mockRejectedValue({ response: { status: 404 } });
    max.getExactMessagePresence.mockReset().mockRejectedValue({ response: { status: 503 } });
    admin.assertManagedEntityAdminAccess.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.chat.delete({ where: { id: chatId } });
    for (const key of keys) await redis.deleteKey(key);
    keys.clear();
  });
  afterAll(async () => {
    await redis?.onModuleDestroy();
    await db?.$disconnect();
  });

  async function poll(data: Partial<Prisma.ManagedPollUncheckedCreateInput> = {}) {
    const row = await db.managedPoll.create({
      data: {
        chatId,
        actorUserId: 'poll-admin',
        question: 'Question?',
        identitySalt: 'native-poll-identity-salt-1234567890',
        status: 'CLOSED',
        publicationMessageId: `message-${randomUUID()}`,
        publicationBotId: 'poll-bot',
        renderRevision: 2,
        renderedRevision: 1,
        renderFormatVersion: 7,
        publishedAt: new Date(Date.now() - 60 * minute),
        closedAt: new Date(),
        ...data,
        options: {
          create: [
            { position: 0, text: 'Yes' },
            { position: 1, text: 'No' },
          ],
        },
      },
    });
    return row;
  }

  function service() {
    const value = new ManagedPollService(
      db as unknown as PrismaService,
      max as unknown as MaxClientService,
      admin as unknown as AdminService,
      {} as ChatContextCacheService,
      undefined,
      redis,
    );
    return { value, internal: value as unknown as Internal };
  }

  async function render(row: ManagedPoll, action = 'background-repair') {
    const current = service();
    keys.add(current.internal.pollRenderRetryKey(row));
    return current.internal.renderPollPublication(chatId, row.id, action);
  }

  it('persists increasing waits across replicas and revisions, caps six hours, and recovers a closed poll', async () => {
    const row = await poll();
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    for (const [index, minutes] of [5, 10, 20, 40, 80, 160, 320, 360, 360].entries()) {
      expect(await render(row)).toBe(false);
      const saved = await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved.renderRetryCount).toBe(Math.min(8, index + 1));
      expect(saved.renderRetryAt?.getTime()).toBe(now + minutes * minute);
      expect(saved.publicationMessageId).toBe(row.publicationMessageId);
      expect(saved.status).toBe('CLOSED');
      await db.managedPoll.update({
        where: { id: row.id },
        data: { renderRevision: { increment: 1 } },
      });
      now += minutes * minute - 1;
      expect(await render(row)).toBe(false);
      expect(max.editMessageInlineKeyboard).toHaveBeenCalledTimes(index + 1);
      now++;
    }
    max.editMessageInlineKeyboard.mockResolvedValue(undefined);
    expect(await render(row)).toBe(true);
    const repaired = await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } });
    expect(repaired).toMatchObject({
      renderRetryCount: 0,
      renderRetryAt: null,
      lastRenderError: null,
      renderedRevision: repaired.renderRevision,
      status: 'CLOSED',
      publicationMessageId: row.publicationMessageId,
    });
    expect(await redis.getString(service().internal.pollRenderRetryKey(row))).toBeNull();
  });

  it('allows an authorized manual refresh after five minutes but preserves the short floor', async () => {
    const row = await poll({ renderRetryCount: 8 });
    const now = Date.now();
    const actor = { userId: 'poll-admin', username: null, displayName: 'Admin' };
    await db.managedPoll.update({
      where: { id: row.id },
      data: {
        renderRetryAt: new Date(now + 360 * minute),
        renderRetryMessageId: row.publicationMessageId,
        renderRetryBotId: row.publicationBotId,
      },
    });
    const current = service();
    max.editMessageInlineKeyboard.mockResolvedValue(undefined);
    jest.spyOn(Date, 'now').mockReturnValue(now + 4 * minute);
    await current.value.refreshChannelPollPublication(chatId, row.id, actor, 'chat');
    expect(max.editMessageInlineKeyboard).not.toHaveBeenCalled();
    jest.spyOn(Date, 'now').mockReturnValue(now + 5 * minute + 1);
    await current.value.refreshChannelPollPublication(chatId, row.id, actor, 'chat');
    expect(max.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(admin.assertManagedEntityAdminAccess).toHaveBeenCalledTimes(2);
  });

  it.each(['publicationMessageId', 'publicationBotId'] as const)(
    'isolates replacement %s and refuses stale failure/success writes',
    async (field) => {
      const row = await poll();
      const current = service();
      const snapshot = await current.internal.loadPollAggregate(chatId, row.id);
      const key = current.internal.pollRenderRetryKey(row);
      keys.add(key);
      await render(row);
      const replacement = await db.managedPoll.update({
        where: { id: row.id },
        data: { [field]: 'replacement' },
      });
      await current.internal.deferPollRender(key, snapshot, { response: { status: 404 } });
      expect(await current.internal.markPollRendered(snapshot)).toBe(false);
      const unchanged = await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } });
      expect(unchanged.renderedRevision).toBe(1);
      expect(unchanged.renderRetryCount).toBe(1);
      max.editMessageInlineKeyboard.mockResolvedValue(undefined);
      expect(await render(replacement)).toBe(true);
      expect(max.editMessageInlineKeyboard).toHaveBeenLastCalledWith(
        chatId,
        replacement.publicationMessageId,
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ botId: replacement.publicationBotId }),
      );
    },
  );

  it('does not overwrite a newer retry snapshot and keeps transport failures at five minutes', async () => {
    const row = await poll();
    const current = service();
    const snapshot = await current.internal.loadPollAggregate(chatId, row.id);
    const key = current.internal.pollRenderRetryKey(row);
    keys.add(key);
    await render(row);
    const first = await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } });
    await current.internal.deferPollRender(key, snapshot, { response: { status: 503 } });
    expect(await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } })).toEqual(first);
    expect(await current.internal.markPollRendered(snapshot)).toBe(false);
    const now = first.renderRetryAt!.getTime() + 1;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    max.editMessageInlineKeyboard.mockRejectedValue({ response: { status: 429 } });
    await render(row);
    const next = await db.managedPoll.findUniqueOrThrow({ where: { id: row.id } });
    expect(next.renderRetryCount).toBe(0);
    expect(next.renderRetryAt?.getTime()).toBe(now + 5 * minute);
  });

  it('selects due work ahead of 20000 rendered and 20000 deferred polls with bounded indexed work', async () => {
    const now = new Date();
    await db.$executeRaw`
      INSERT INTO managed_polls (id, chat_id, actor_user_id, question, identity_salt, status,
        publication_message_id, publication_bot_id, render_revision, rendered_revision,
        render_format_version, render_retry_count, render_retry_at, render_retry_message_id,
        render_retry_bot_id, last_render_error, updated_at)
      SELECT ${chatId} || n, ${chatId}, 'admin', 'History', 'native-poll-identity-salt-1234567890', 'CLOSED'::"ManagedPollStatus",
        'history-message', 'poll-bot', 2, CASE WHEN n <= 20000 THEN 2 ELSE 1 END,
        7, CASE WHEN n <= 20000 THEN 0 ELSE 8 END,
        CASE WHEN n <= 20000 THEN NULL ELSE ${now}::timestamp + interval '6 hours' END,
        'history-message', 'poll-bot', CASE WHEN n <= 20000 THEN NULL ELSE 'Unknown access' END,
        ${now}::timestamp - interval '1 day'
      FROM generate_series(1, 40000) n
    `;
    const due = await poll({ updatedAt: new Date(now.getTime() - minute) });
    const legacy = await poll({
      renderFormatVersion: 6,
      renderedRevision: 2,
      updatedAt: new Date(now.getTime() - minute),
    });
    const legacyError = await poll({
      lastRenderError: 'legacy failure',
      updatedAt: new Date(now.getTime() - 6 * minute),
    });
    await db.$executeRaw`ANALYZE managed_polls`;
    const selection = managedPollRenderSelection(
      new Date(),
      MANAGED_POLL_RENDER_FORMAT_VERSION,
      10,
    );
    const rows = await db.$queryRaw<Array<{ id: string; chatId: string }>>(selection);
    expect(rows.map((x) => x.id).sort()).toEqual([due.id, legacy.id, legacyError.id].sort());
    type Plan = {
      'Node Type': string;
      'Index Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      'Rows Removed by Filter'?: number;
      'Shared Hit Blocks'?: number;
      Plans?: Plan[];
    };
    const explained = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selection}`,
    );
    const root = explained[0]!['QUERY PLAN'][0]!.Plan;
    const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
    const nodes = flatten(root);
    expect(nodes.some((n) => n['Index Name'] === 'managed_polls_render_due_v7_idx')).toBe(true);
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' || n['Node Type'] === 'Sort')).toBe(
      false,
    );
    expect(
      nodes.reduce(
        (sum, n) =>
          sum + ((n['Rows Removed by Filter'] ?? 0) + n['Actual Rows']) * n['Actual Loops'],
        0,
      ),
    ).toBeLessThan(100);
    expect(root['Shared Hit Blocks']).toBeLessThan(100);
    max.editMessageInlineKeyboard.mockResolvedValue(undefined);
    for (const row of [due, legacy, legacyError])
      keys.add(service().internal.pollRenderRetryKey(row));
    expect(await service().value.processPendingPollRenderRepairs()).toBe(3);
    expect(max.editMessageInlineKeyboard).toHaveBeenCalledTimes(3);
    expect(await service().value.processPendingPollRenderRepairs()).toBe(0);
  });
});
