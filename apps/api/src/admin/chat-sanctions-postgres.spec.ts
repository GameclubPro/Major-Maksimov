import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  SanctionAction,
  EventType,
} from '../prisma/prisma-client';
import { ChatSanctionsService } from './chat-sanctions.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import { SanctionHistoryRetention } from '../moderation/sanction-history-retention';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

type SanctionsPlanNode = {
  Plans?: SanctionsPlanNode[];
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
};

describePostgres('PostgreSQL sanctions registry and retention', () => {
  let prisma: PrismaClient;
  let service: ChatSanctionsService;
  let fence: ModerationSanctionStateFenceService;
  const chatId = `sanctions-race-${randomUUID()}`;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Sanctions PostgreSQL tests require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    await prisma.chat.create({ data: { id: chatId, title: 'Sanctions integration test' } });
    fence = new ModerationSanctionStateFenceService(prisma as never);
    service = new ChatSanctionsService(prisma as never, fence);
    for (const [key, userId, action, ruleCode, days, metadata] of [
      ['active-ban', 'banned', SanctionAction.BAN, 'MANUAL_BAN', 500, {}],
      ['active-mute', 'muted', SanctionAction.MUTE, 'MANUAL_MUTE', 600, { mutePermanent: true }],
      ['old-ban', 'released', SanctionAction.BAN, 'MANUAL_BAN', 700, {}],
      ['release', 'released', SanctionAction.NONE, 'MANUAL_UNBAN', 500, {}],
      [
        'recent-archive',
        'archived',
        SanctionAction.MUTE,
        'MANUAL_MUTE',
        50,
        { muteDurationHours: 1, muteExpiresAt: ago(49).toISOString() },
      ],
      ['ordinary', 'ordinary', SanctionAction.WARN, 'PROFANITY', 400, {}],
    ] as const) {
      const id = randomUUID();
      ids[key] = id;
      await prisma.moderationEvent.create({
        data: {
          id,
          chatId,
          userId,
          action,
          ruleCode,
          eventType: EventType.SYSTEM,
          createdAt: ago(days),
          metadata,
        },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.chatModerationFeedItem.deleteMany({ where: { chatId } });
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });

  it('reads old active bans and permanent mutes from maintained feed rows', async () => {
    const page = await service.getPage(chatId, 'admin', {});
    expect(page.items.map((item) => item.userId).sort()).toEqual(['banned', 'muted']);
    expect(page.items.every((item) => item.releaseAction !== null)).toBe(true);
    const archive = await service.getPage(chatId, 'admin', { status: 'archive' });
    expect(archive.items.map((item) => item.userId)).toEqual(['archived']);
    const filtered = await service.getPage(chatId, 'admin', { action: 'BAN', userId: 'banned' });
    expect(filtered.items[0]?.id).toBe(ids['active-ban']);
  });

  it('does not remove active state or latest release tombstones with ordinary retention', async () => {
    const outbox = Object.create(WebhookOutboxService.prototype) as {
      prisma: PrismaClient;
      deleteModerationEventBatch: (cutoff: Date) => Promise<number>;
    };
    outbox.prisma = prisma;
    await outbox.deleteModerationEventBatch(ago(90));
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.ordinary! } })).toBeNull();
    expect(
      await prisma.moderationEvent.findUnique({ where: { id: ids['active-ban']! } }),
    ).not.toBeNull();
    expect(
      await prisma.moderationEvent.findUnique({ where: { id: ids['active-mute']! } }),
    ).not.toBeNull();
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.release! } })).not.toBeNull();
  });

  it('prunes completed history after a year but preserves a state checkpoint', async () => {
    await new SanctionHistoryRetention().cleanup(prisma as never, now);
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids['old-ban']! } })).toBeNull();
    expect(
      await prisma.chatModerationFeedItem.findUnique({ where: { id: ids['old-ban']! } }),
    ).toBeNull();
    expect(await prisma.moderationEvent.findUnique({ where: { id: ids.release! } })).not.toBeNull();
    expect(
      (await service.getPage(chatId, 'admin', {})).items.map((item) => item.userId).sort(),
    ).toEqual(['banned', 'muted']);
  });

  it('shows an interrupted transition for review and restores an explicitly aborted transition', async () => {
    const transition = await fence.prepare({
      chatId,
      userId: 'banned',
      intendedAction: 'UNBAN',
      operator: 'ADMIN',
    });
    expect((await service.getPage(chatId, 'admin', { status: 'review' })).items[0]).toMatchObject({
      id: ids['active-ban'],
      releaseAction: null,
    });
    await fence.abort(transition);
    expect((await service.getPage(chatId, 'admin', { userId: 'banned' })).items[0]?.status).toBe(
      'active',
    );
  });

  it('bounds candidate and successor work under ordinary history and chat/user skew', async () => {
    const planChatId = `${chatId}-plan`;
    const otherChatId = `${chatId}-other`;
    const ownedChats = [planChatId, otherChatId];
    const candidateCount = 32;
    try {
      await prisma.chat.createMany({
        data: ownedChats.map((id) => ({ id, title: 'Sanctions plan fixture' })),
      });
      await prisma.moderationEvent.createMany({
        data: Array.from({ length: candidateCount }, (_, index) => ({
          id: `${planChatId}-ban-${index}`,
          chatId: planChatId,
          userId: `plan-user-${index}`,
          eventType: EventType.SYSTEM,
          action: SanctionAction.BAN,
          ruleCode: 'MANUAL_BAN',
          createdAt: ago(2),
        })),
      });
      // FLAG: New ordinary history for the same user and chat must not make the
      // successor probe scan 20,000 rows to prove this old ban has no successor.
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO chat_moderation_feed_items (id, chat_id, user_id, event_type, rule_code, action, created_at, updated_at)
        SELECT ${planChatId} || '-ordinary-' || n, ${planChatId}, 'plan-user-0', 'SYSTEM'::"EventType", 'PROFANITY', 'WARN'::"SanctionAction", NOW(), NOW()
        FROM generate_series(1, 20000) n
        UNION ALL
        SELECT ${planChatId} || '-other-user-' || n, ${planChatId}, 'other-user-' || n, 'SYSTEM'::"EventType", 'MANUAL_UNBAN', 'NONE'::"SanctionAction", NOW(), NOW()
        FROM generate_series(1, 4000) n
        UNION ALL
        SELECT ${otherChatId} || '-same-user-' || n, ${otherChatId}, 'plan-user-0', 'SYSTEM'::"EventType", 'MANUAL_UNBAN', 'NONE'::"SanctionAction", NOW(), NOW()
        FROM generate_series(1, 4000) n
      `);
      await prisma.$executeRawUnsafe('ANALYZE chat_moderation_feed_items');
      const statements: Prisma.Sql[] = [];
      const reader = {
        $queryRaw: (query: Prisma.Sql) => {
          statements.push(query);
          return prisma.$queryRaw(query);
        },
      };
      const page = await new ChatSanctionsService(reader as never, fence).getPage(
        planChatId,
        'admin',
        { status: 'all', limit: 50 },
      );
      expect(page.items).toHaveLength(candidateCount);
      expect(page.items.every((item) => item.status === 'active')).toBe(true);
      expect(statements).toHaveLength(1);
      const plan = await prisma.$queryRaw<{ 'QUERY PLAN': { Plan: SanctionsPlanNode }[] }[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statements[0]!}`,
      );
      const root = plan[0]!['QUERY PLAN'][0]!.Plan;
      const visit = (
        node: SanctionsPlanNode,
        parentAlias?: string,
      ): { node: SanctionsPlanNode; alias: string | undefined }[] => {
        const alias = node.Alias ?? parentAlias;
        return [{ node, alias }, ...(node.Plans ?? []).flatMap((child) => visit(child, alias))];
      };
      const physicalScans = visit(root).filter(({ node }) =>
        [
          'Seq Scan',
          'Index Scan',
          'Index Only Scan',
          'Bitmap Heap Scan',
          'Bitmap Index Scan',
        ].includes(node['Node Type']),
      );
      const blocks = (node: SanctionsPlanNode) =>
        (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);
      try {
        expect(
          physicalScans.some(
            ({ node, alias }) =>
              node['Relation Name'] === 'chat_moderation_feed_items' &&
              /^feed(?:_\d+)?$/u.test(alias ?? '') &&
              node['Actual Loops'] > 0,
          ),
        ).toBe(true);
        for (const alias of ['later', 'original'])
          expect(
            physicalScans.some((scan) => scan.alias === alias && scan.node['Actual Loops'] > 0),
          ).toBe(true);
        // FLAG: Inspect every physical scan, including renamed candidate aliases
        // and bitmap children. Buffer counts already include every loop.
        for (const { node, alias } of physicalScans) {
          expect(
            alias === 'later' || alias === 'original' || /^feed(?:_\d+)?$/u.test(alias ?? ''),
          ).toBe(true);
          const perLoop =
            node['Actual Rows'] +
            (node['Rows Removed by Filter'] ?? 0) +
            (node['Rows Removed by Index Recheck'] ?? 0);
          expect(perLoop).toBeLessThanOrEqual(alias === 'later' ? 8 : 64);
          expect(perLoop * node['Actual Loops']).toBeLessThanOrEqual(
            alias === 'later' ? candidateCount * 8 : 64,
          );
          expect(blocks(node)).toBeLessThanOrEqual(alias === 'later' ? 256 : 128);
        }
        // Parent buffer totals are inclusive; do not sum them with child totals.
        expect(blocks(root)).toBeLessThanOrEqual(512);
      } catch (error: unknown) {
        throw new Error(`Sanctions registry exceeded work bounds: ${JSON.stringify(plan)}`, {
          cause: error,
        });
      }
    } finally {
      await prisma.chatModerationFeedItem.deleteMany({ where: { chatId: { in: ownedChats } } });
      await prisma.chat.deleteMany({ where: { id: { in: ownedChats } } });
    }
  });
});
