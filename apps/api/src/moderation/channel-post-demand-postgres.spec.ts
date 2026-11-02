import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import {
  captureChannelPostDemand,
  claimChannelPostDemandChannels,
  claimChannelPostDemandItems,
  deferUnavailableChannelPostDemand,
  idleChannelPostDemand,
  persistChannelPostDemand,
  purgeExpiredChannelPostDemands,
  settleChannelPostDemand,
  type ChannelPostDemandInput,
} from './channel-post-demand';
import { WebhookParser } from '../webhook/webhook.parser';
import { WebhookService } from '../webhook/webhook.service';
import { ConfigService } from '@nestjs/config';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
jest.setTimeout(45_000);

native('durable channel post demand in PostgreSQL', () => {
  let db: PrismaClient;
  const channels: string[] = [];
  const receipts: string[] = [];
  const policies: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Only disposable local race_test PostgreSQL is permitted');
    db = createPrismaClient(databaseUrl, { max: 4 });
    const [clock] = await db.$queryRaw<
      { timezone: string }[]
    >`SELECT current_setting('TimeZone') AS timezone`;
    expect(clock?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
  });
  afterEach(async () => {
    const ids = policies.splice(0);
    if (ids.length) {
      await db.$executeRaw`DELETE FROM marketplace_button_contexts WHERE policy_id = ANY(${ids}::uuid[])`;
      await db.$executeRaw`DELETE FROM marketplace_button_policies WHERE id = ANY(${ids}::uuid[])`;
    }
    await db.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
    await db.chat.deleteMany({ where: { id: { in: channels.splice(0) } } });
  });
  afterAll(async () => db?.$disconnect());
  async function channel() {
    const chatId = `-${Date.now()}${channels.length}${Math.floor(Math.random() * 1000)}`;
    channels.push(chatId);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Disposable demand fixture',
        entityType: 'CHANNEL',
        channelSettings: {
          create: { postSignatureEnabled: true, updatedAt: new Date(Date.now() - 60_000) },
        },
      },
    });
    return chatId;
  }
  function input(chatId: string): ChannelPostDemandInput {
    return {
      chatId,
      messageId: randomUUID(),
      sourceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
  }
  async function persist(value: ChannelPostDemandInput) {
    await db.$transaction((tx) => persistChannelPostDemand(tx, value));
  }
  async function retainIdleChannels() {
    const prefix = `demand-history-${randomUUID()}-`;
    const extra = Array.from({ length: 10_000 }, (_, n) => prefix + n);
    channels.push(...extra);
    await db.$executeRaw(Prisma.sql`INSERT INTO chats (id,title,entity_type,updated_at)
      SELECT ${prefix} || n, 'Disposable plan fixture', 'CHANNEL', NOW() AT TIME ZONE 'UTC' FROM generate_series(0,9999) n`);
    await db.$executeRaw(Prisma.sql`INSERT INTO channel_post_demand_channels (chat_id)
      SELECT id FROM chats WHERE id = ANY(${extra}::text[])`);
    await db.$executeRawUnsafe('ANALYZE channel_post_demand_channels');
  }

  it('pages channel scan settings through the unique chat index before filtering flags', async () => {
    const prefix = `channel-scan-${randomUUID()}-`;
    const ids = Array.from(
      { length: 4_096 },
      (_, index) => `${prefix}${String(index).padStart(5, '0')}`,
    );
    try {
      await db.chat.createMany({
        data: ids.map((id) => ({ id, title: 'Disposable scan fixture', entityType: 'CHANNEL' })),
      });
      await db.channelSettings.createMany({
        data: ids.map((chatId, index) => ({
          id: `${prefix}settings-${index}`,
          chatId,
          quickButtonsEnabled: index === ids.length - 1,
        })),
      });
      await db.$executeRawUnsafe('ANALYZE channel_settings');
      const after = ids[2_000]!;
      const page = await db.channelSettings.findMany({
        where: { chatId: { gt: after } },
        select: {
          chatId: true,
          quickButtonsEnabled: true,
          postSignatureEnabled: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
        },
        orderBy: { chatId: 'asc' },
        take: 64,
      });
      expect(page).toHaveLength(64);
      expect(page[0]?.chatId).toBe(ids[2_001]);
      expect(page.every((row) => !row.quickButtonsEnabled)).toBe(true);

      type Plan = {
        'Node Type': string;
        'Index Name'?: string;
        'Actual Rows'?: number;
        'Actual Loops'?: number;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      const plans = await db.$queryRaw<{ 'QUERY PLAN': Array<{ Plan: Plan }> }[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
        SELECT chat_id, quick_buttons_enabled, post_signature_enabled,
          comments_enabled, post_suggestions_enabled
        FROM channel_settings WHERE chat_id > ${after} ORDER BY chat_id ASC LIMIT 64
      `);
      const visit = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(visit)];
      const indexScan = visit(plans[0]!['QUERY PLAN'][0]!.Plan).find(
        (node) => node['Index Name'] === 'channel_settings_chat_id_key',
      );
      expect(indexScan).toMatchObject({
        'Node Type': 'Index Scan',
        'Actual Rows': 64,
        'Actual Loops': 1,
      });
      expect(indexScan?.['Rows Removed by Filter'] ?? 0).toBe(0);
    } finally {
      await db.chat.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('admits only new moderation channel-button posts even when every legacy decorator is off', async () => {
    const chatId = await channel();
    await db.channelSettings.update({
      where: { chatId },
      data: {
        postSignatureEnabled: false,
        quickButtonsEnabled: false,
        commentsEnabled: false,
        postSuggestionsEnabled: false,
      },
    });
    const id = randomUUID();
    policies.push(id);
    const enabledAt = new Date(Date.now() - 10_000);
    await db.$executeRaw`INSERT INTO marketplace_button_policies(id,entity_id,kind,profile) VALUES(${id}::uuid,${chatId},'CHANNEL','moderation')`;
    await db.$executeRaw`INSERT INTO marketplace_button_contexts(policy_id,context,enabled,confirmed_by,confirmed_at) VALUES(${id}::uuid,'CHANNEL_POSTS',true,'fixture-admin',${enabledAt})`;
    const old = { ...input(chatId), sourceAt: new Date(enabledAt.getTime() - 1) };
    const fresh = input(chatId);
    await persist(old);
    await persist(fresh);
    expect(
      (await db.channelPostDemand.findMany({ where: { chatId } })).map((row) => row.messageId),
    ).toEqual([fresh.messageId]);
    await db.$executeRaw`UPDATE marketplace_button_contexts SET suspended_reason='ACCESS_LOST' WHERE policy_id=${id}::uuid`;
    await persist(input(chatId));
    expect(await db.channelPostDemand.count({ where: { chatId } })).toBe(1);
    await db.$executeRaw`UPDATE marketplace_button_contexts SET suspended_reason=NULL,enabled=false WHERE policy_id=${id}::uuid`;
    await persist(input(chatId));
    expect(await db.channelPostDemand.count({ where: { chatId } })).toBe(1);
  });
  it('coalesces mirrors and preserves item and channel retry waits across a new client', async () => {
    const first = input(await channel());
    await Promise.all(Array.from({ length: 4 }, () => persist(first)));
    expect(await db.channelPostDemand.count()).toBe(1);
    await claimChannelPostDemandChannels(db, 1, 120_000);
    await claimChannelPostDemandItems(db, first.chatId, 1, 120_000);
    const before = await db.channelPostDemand.findMany();
    const channelBefore = await db.channelPostDemandChannel.findMany();
    const restarted = createPrismaClient(databaseUrl, { max: 1 });
    try {
      await restarted.$transaction((tx) => persistChannelPostDemand(tx, first));
    } finally {
      await restarted.$disconnect();
    }
    expect(await db.channelPostDemand.findMany()).toEqual(before);
    expect(await db.channelPostDemandChannel.findMany()).toEqual(channelBefore);
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([]);
  });
  it('rotates channel and message attempts without settling an unfinished effect', async () => {
    const busy = await channel(),
      quiet = await channel();
    for (let i = 0; i < 12; i++) await persist(input(busy));
    await persist(input(quiet));
    const claimed = await Promise.all([
      claimChannelPostDemandChannels(db, 1, 30_000),
      claimChannelPostDemandChannels(db, 1, 30_000),
    ]);
    expect(new Set(claimed.flat().map((r) => r.chatId))).toEqual(new Set([busy, quiet]));
    const first = await claimChannelPostDemandItems(db, busy, 1, 30_000);
    const second = await claimChannelPostDemandItems(db, busy, 1, 30_000);
    expect(second[0]?.messageId).not.toBe(first[0]?.messageId);
    expect(await db.channelPostDemand.count({ where: { chatId: busy } })).toBe(12);
  });
  it('schedules the parent from its earliest remaining child, including an unvisited sibling', async () => {
    const first = input(await channel());
    const second = input(first.chatId);
    await persist(first);
    await persist(second);
    await claimChannelPostDemandChannels(db, 1, 30_000);
    await claimChannelPostDemandItems(db, first.chatId, 1, 300_000);
    await db.$transaction((tx) => idleChannelPostDemand(tx, first.chatId));
    const earliest = await db.channelPostDemand.findFirstOrThrow({
      where: { chatId: first.chatId },
      orderBy: [{ dueAt: 'asc' }, { messageId: 'asc' }],
    });
    const parent = await db.channelPostDemandChannel.findUniqueOrThrow({
      where: { chatId: first.chatId },
    });
    expect(parent.dueAt!.getTime()).toBeGreaterThanOrEqual(earliest.dueAt.getTime());
    expect(parent.dueAt!.getTime()).toBeLessThanOrEqual(Date.now());
    await claimChannelPostDemandItems(db, first.chatId, 1, 300_000);
    await db.$transaction((tx) => idleChannelPostDemand(tx, first.chatId));
    expect(
      (
        await db.channelPostDemandChannel.findUniqueOrThrow({ where: { chatId: first.chatId } })
      ).dueAt!.getTime(),
    ).toBeGreaterThan(Date.now() + 250_000);
  });
  it('rotates a ready hot channel behind a quiet channel without postponing its remaining posts', async () => {
    const busy = await channel(),
      quiet = await channel();
    for (let i = 0; i < 12; i++) await persist(input(busy));
    await persist(input(quiet));
    const busyDueAt = new Date(Date.now() - 60_000);
    const quietDueAt = new Date(Date.now() - 30_000);
    for (const [chatId, dueAt] of [
      [busy, busyDueAt],
      [quiet, quietDueAt],
    ] as const) {
      await db.channelPostDemand.updateMany({ where: { chatId }, data: { dueAt } });
      await db.channelPostDemandChannel.update({ where: { chatId }, data: { dueAt } });
    }
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([{ chatId: busy }]);
    await claimChannelPostDemandItems(db, busy, 1, 300_000);
    await db.$transaction((tx) => idleChannelPostDemand(tx, busy));
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([{ chatId: quiet }]);
    expect(await db.channelPostDemand.count({ where: { chatId: busy, dueAt: busyDueAt } })).toBe(
      11,
    );
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([{ chatId: busy }]);
  });
  it('wakes a delayed parent for a new post without renewing a mirrored post retry', async () => {
    const first = input(await channel());
    await persist(first);
    await claimChannelPostDemandChannels(db, 1, 300_000);
    await claimChannelPostDemandItems(db, first.chatId, 1, 300_000);
    const before = await db.channelPostDemandChannel.findUniqueOrThrow({
      where: { chatId: first.chatId },
    });
    await persist(first);
    expect(
      await db.channelPostDemandChannel.findUniqueOrThrow({ where: { chatId: first.chatId } }),
    ).toEqual(before);
    await persist(input(first.chatId));
    expect(
      (
        await db.channelPostDemandChannel.findUniqueOrThrow({ where: { chatId: first.chatId } })
      ).dueAt!.getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });
  it('does not lose arrivals racing an empty-channel transition', async () => {
    const chatId = await channel();
    for (let i = 0; i < 12; i++) {
      const seed = input(chatId);
      await persist(seed);
      await settleChannelPostDemand(db, seed);
      const next = input(chatId);
      await Promise.all([
        db.$transaction((tx) => idleChannelPostDemand(tx, chatId)),
        persist(next),
      ]);
      expect(
        (await db.channelPostDemandChannel.findUniqueOrThrow({ where: { chatId } })).dueAt,
      ).not.toBeNull();
      expect(await db.channelPostDemand.count({ where: { chatId } })).toBe(1);
      await settleChannelPostDemand(db, next);
    }
  });
  it('delays only the exact read reservation and never extends its source horizon', async () => {
    const value = input(await channel());
    value.expiresAt = new Date(Date.now() + 120_000);
    await persist(value);
    const [first] = await claimChannelPostDemandItems(db, value.chatId, 1, 30_000);
    expect(typeof first!.claimedUntil).toBe('string');
    await db.channelPostDemand.update({
      where: { chatId_messageId: { chatId: value.chatId, messageId: value.messageId } },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
    const [next] = await claimChannelPostDemandItems(db, value.chatId, 1, 30_000);
    const read = () =>
      db.channelPostDemand.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: value.chatId, messageId: value.messageId } },
      });
    const before = await read();
    await deferUnavailableChannelPostDemand(db, first!);
    expect(await read()).toEqual(before);
    await deferUnavailableChannelPostDemand(db, next!);
    expect(await read()).toEqual({ ...before, dueAt: value.expiresAt });
    await persist(value);
    expect(await read()).toEqual({ ...before, dueAt: value.expiresAt });
  });
  it('keeps capture atomic with the receipt and excludes held creations', async () => {
    const chatId = await channel(),
      at = Date.now();
    const raw = {
      update_type: 'message_created',
      timestamp: at,
      message: {
        timestamp: at,
        recipient: { chat_id: chatId, chat_type: 'channel' },
        body: { mid: randomUUID(), text: 'Fixture' },
      },
    };
    const update = new WebhookParser().parse(raw);
    update.botId = 'fixture-moderator';
    expect(captureChannelPostDemand(update, 'publisher')).not.toBeNull();
    const ingress = new WebhookService(
      db as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
      {} as never,
    );
    const port = ingress as unknown as {
      persistReceipt: (u: typeof update, ip: null, r: Prisma.InputJsonValue) => Promise<string>;
    };
    try {
      Object.assign(ingress, {
        legacyHolds: { isUpdateHeld: async () => true, materializeReceipt: async () => 'HELD' },
      });
      receipts.push(await port.persistReceipt(update, null, raw));
      expect(await db.channelPostDemand.count()).toBe(0);
      update.updateId = randomUUID();
      Object.assign(ingress, {
        legacyHolds: { isUpdateHeld: async () => false },
        messageRetention: {
          captureInput: () => ({}),
          capture: async () => {
            throw new Error('fixture transaction failure');
          },
        },
      });
      await expect(port.persistReceipt(update, null, raw)).rejects.toThrow(
        'fixture transaction failure',
      );
      expect(await db.channelPostDemand.count()).toBe(0);
      expect(
        await db.webhookEvent.count({
          where: { botId: 'fixture-moderator', id: { notIn: receipts } },
        }),
      ).toBe(0);
      Object.assign(ingress, { messageRetention: undefined });
      receipts.push(await port.persistReceipt(update, null, raw));
      expect(await db.channelPostDemand.count()).toBe(1);
    } finally {
      await ingress.onModuleDestroy();
    }
  });
  it('bounds due selection and expiry against retained history and a hot channel', async () => {
    const chatId = await channel();
    await persist(input(chatId));
    await db.$executeRaw(Prisma.sql`INSERT INTO channel_post_demands (chat_id,message_id,source_at,expires_at,due_at)
      SELECT ${chatId}, 'history-' || n, NOW() AT TIME ZONE 'UTC',
        (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day', (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
      FROM generate_series(1,25000) n`);
    await db.$executeRawUnsafe('ANALYZE channel_post_demands');
    // FLAG: Parent locking also needs representative history. A one-row parent table
    // legitimately favors a sequential scan and cannot prove indexed fleet-scale work.
    await retainIdleChannels();
    expect(await db.channelPostDemandChannel.count()).toBe(10_001);
    const captured: Prisma.Sql[] = [];
    const store = {
      $queryRaw: async (q: Prisma.Sql) => {
        captured.push(q);
        return [];
      },
      $executeRaw: async (q: Prisma.Sql) => {
        captured.push(q);
        return 0;
      },
    };
    await claimChannelPostDemandItems(store as never, chatId, 3, 30_000);
    await purgeExpiredChannelPostDemands(store as never);
    for (const [index, q] of captured.entries()) {
      const plan = await db.$queryRawUnsafe<unknown[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`,
        ...q.values,
      );
      const text = JSON.stringify(plan);
      expect(text).toContain(
        index === 0 ? 'channel_post_demands_due_idx' : 'channel_post_demands_expiry_idx',
      );
      expect(text).not.toContain('Seq Scan');
    }
    expect(await db.channelPostDemand.count()).toBe(24501);
    captured.length = 0;
    await idleChannelPostDemand(store as never, chatId);
    for (const q of captured) {
      const plan = await db.$queryRawUnsafe<unknown[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`,
        ...q.values,
      );
      const text = JSON.stringify(plan);
      expect(text).not.toContain('Seq Scan');
      expect(text).toContain('channel_post_demand_channels_pkey');
      if (q.text.trimStart().startsWith('UPDATE ')) {
        expect(text).toContain('channel_post_demands_due_idx');
        const root = (plan as { 'QUERY PLAN': { Plan: Record<string, unknown> }[] }[])[0]![
          'QUERY PLAN'
        ][0]!.Plan;
        const visit = (node: Record<string, unknown>) => {
          if (
            ['channel_post_demands', 'channel_post_demand_channels'].includes(
              String(node['Relation Name']),
            )
          ) {
            expect(
              Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0),
            ).toBeLessThanOrEqual(1);
            expect(node['Actual Loops']).toBe(1);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
        };
        visit(root);
      }
    }
  });

  it('selects indexed due channels through idle history and skips a locked channel', async () => {
    const first = input(await channel()),
      second = input(await channel());
    await persist(first);
    await persist(second);
    await retainIdleChannels();
    let query: Prisma.Sql | undefined;
    await claimChannelPostDemandChannels(
      {
        $queryRaw: async (q: Prisma.Sql) => {
          query = q;
          return [];
        },
      } as never,
      1,
      30_000,
    );
    const plan = await db.$queryRawUnsafe<unknown[]>(
      `EXPLAIN (FORMAT JSON) ${query!.text}`,
      ...query!.values,
    );
    expect(JSON.stringify(plan)).toContain('channel_post_demand_channels_due_idx');
    expect(JSON.stringify(plan)).not.toContain('Seq Scan');
    let unlock!: () => void, locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const owner = db.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT chat_id FROM channel_post_demand_channels WHERE chat_id = ${first.chatId} FOR UPDATE`,
        );
        locked();
        await hold;
      },
      { timeout: 5_000 },
    );
    try {
      await barrier;
      expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([
        { chatId: second.chatId },
      ]);
    } finally {
      unlock();
      await owner;
    }
    expect(await claimChannelPostDemandChannels(db, 1, 30_000)).toEqual([{ chatId: first.chatId }]);
  });

  it.each(['module_off', 'before_settings', 'expired'] as const)(
    'does not persist %s demand',
    async (kind) => {
      const value = input(await channel());
      if (kind === 'module_off')
        await db.channelSettings.update({
          where: { chatId: value.chatId },
          data: {
            postSignatureEnabled: false,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            quickButtonsEnabled: false,
          },
        });
      if (kind === 'before_settings') value.sourceAt = new Date(Date.now() - 120_000);
      if (kind === 'expired') value.expiresAt = new Date(Date.now() - 1);
      await persist(value);
      expect(await db.channelPostDemand.count()).toBe(0);
      expect(await db.channelPostDemandChannel.count()).toBe(0);
    },
  );
});
