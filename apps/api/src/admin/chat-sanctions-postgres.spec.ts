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
  'Parent Relationship'?: string;
  'Subplan Name'?: string;
  'CTE Name'?: string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
};

type SanctionsPlan = { 'QUERY PLAN': { Plan: SanctionsPlanNode }[] }[];

function assertBoundedSanctionsPlan(
  plan: SanctionsPlan,
  candidateCount: number,
  sourceHistoryPhase?: 'retained' | 'cleared',
): void {
  const root = plan[0]!['QUERY PLAN'][0]!.Plan;
  const visit = (
    node: SanctionsPlanNode,
    parentAlias?: string,
  ): { node: SanctionsPlanNode; alias: string | undefined }[] => {
    const alias = node.Alias ?? parentAlias;
    return [{ node, alias }, ...(node.Plans ?? []).flatMap((child) => visit(child, alias))];
  };
  const physicalScans = visit(root).filter(({ node }) =>
    ['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Bitmap Index Scan'].includes(
      node['Node Type'],
    ),
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
      // FLAG: Only compact source history may repeat a tiny table scan. Bound
      // each iteration and its loop count; retained/cleared history stays indexed.
      const compactSourceScan =
        sourceHistoryPhase === undefined &&
        alias === 'original' &&
        node['Relation Name'] === 'moderation_events' &&
        node['Node Type'] === 'Seq Scan';
      if (compactSourceScan) expect(node['Actual Loops']).toBeLessThanOrEqual(candidateCount);
      expect(perLoop * node['Actual Loops']).toBeLessThanOrEqual(
        alias === 'later' ? candidateCount * 8 : compactSourceScan ? candidateCount * 64 : 64,
      );
      // FLAG: Point-lookup buffers vary with B-tree depth and visibility work.
      // Grant a per-candidate budget only to bounded source index probes;
      // repeated compact source scans retain the fixed physical-buffer ceiling.
      const sourcePointProbe =
        alias === 'original' &&
        ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) &&
        perLoop <= 1 &&
        node['Actual Loops'] <= candidateCount;
      expect(blocks(node)).toBeLessThanOrEqual(
        alias === 'later' || sourcePointProbe ? candidateCount * 8 : 128,
      );
    }
    // Parent buffer totals are inclusive; do not sum them with child totals.
    expect(blocks(root)).toBeLessThanOrEqual(512);
    if (sourceHistoryPhase) {
      // FLAG: Retained and sparse source history stays behind closed candidate
      // key ranges. Missing evidence must not scan the deleted-key gap after it.
      const originals = physicalScans
        .filter(({ alias }) => alias === 'original')
        .map(({ node }) => node);
      const original = originals[0]!;
      let index = original;
      if (original['Node Type'] === 'Bitmap Heap Scan') {
        expect(originals).toHaveLength(2);
        expect(original['Relation Name']).toBe('moderation_events');
        const children = (original.Plans ?? []).filter(
          (node) => node['Parent Relationship'] !== 'InitPlan',
        );
        expect(children).toHaveLength(1);
        index = children[0]!;
        expect(index).toBe(originals[1]);
        expect(index['Node Type']).toBe('Bitmap Index Scan');
      } else {
        expect(originals).toHaveLength(1);
        expect(['Index Scan', 'Index Only Scan']).toContain(original['Node Type']);
      }
      expect(index['Index Name']).toBe('moderation_events_pkey');
      expect(index['Index Cond']).toMatch(/id >= feed(?:_\d+)?\.id/u);
      expect(index['Index Cond']).toMatch(/id <= feed(?:_\d+)?\.id/u);
      if (original['Node Type'] === 'Bitmap Heap Scan') {
        expect(original['Recheck Cond']).toMatch(/id >= feed(?:_\d+)?\.id/u);
        expect(original['Recheck Cond']).toMatch(/id <= feed(?:_\d+)?\.id/u);
      }
      for (const node of originals) {
        expect(
          node['Actual Rows'] +
            (node['Rows Removed by Filter'] ?? 0) +
            (node['Rows Removed by Index Recheck'] ?? 0),
        ).toBeLessThanOrEqual(1);
        expect(node['Actual Loops']).toBe(candidateCount);
      }
    }
    console.info('Sanctions source probe bounds', {
      phase: sourceHistoryPhase ?? 'compact',
      candidateCount,
      blocks: blocks(root),
      sources: physicalScans
        .filter(({ alias }) => alias === 'original')
        .map(({ node }) => ({
          type: node['Node Type'],
          index: node['Index Name'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
          blocks: blocks(node),
        })),
    });
  } catch (error: unknown) {
    throw new Error(
      `Sanctions registry exceeded work bounds (${sourceHistoryPhase ?? 'feed history'}): ${JSON.stringify(plan)}`,
      { cause: error },
    );
  }
}

describe('Sanctions query plan work bounds', () => {
  const candidateCount = 32;
  const createPlan = ({
    source = {},
    candidate = {},
    successor = {},
    rootBlocks = 169,
  }: {
    source?: Partial<SanctionsPlanNode>;
    candidate?: Partial<SanctionsPlanNode>;
    successor?: Partial<SanctionsPlanNode>;
    rootBlocks?: number;
  } = {}): SanctionsPlan => [
    {
      'QUERY PLAN': [
        {
          Plan: {
            'Node Type': 'Nested Loop',
            'Actual Rows': candidateCount,
            'Actual Loops': 1,
            'Shared Hit Blocks': rootBlocks,
            Plans: [
              {
                'Node Type': 'Bitmap Heap Scan',
                'Relation Name': 'chat_moderation_feed_items',
                Alias: 'feed_1',
                'Actual Rows': candidateCount,
                'Actual Loops': 1,
                'Shared Hit Blocks': 9,
                ...candidate,
              },
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'moderation_events',
                Alias: 'original',
                'Actual Rows': 1,
                'Rows Removed by Filter': 37,
                'Actual Loops': candidateCount,
                'Shared Hit Blocks': 64,
                ...source,
              },
              {
                'Node Type': 'Index Scan',
                'Relation Name': 'chat_moderation_feed_items',
                'Index Name': 'chat_moderation_feed_sanction_user_state_idx',
                Alias: 'later',
                'Actual Rows': 0,
                'Actual Loops': candidateCount,
                'Shared Hit Blocks': 96,
                ...successor,
              },
            ],
          },
        },
      ],
    },
  ];

  it('accepts the observed compact 38-row source scan repeated for 32 candidates', () => {
    expect(() => assertBoundedSanctionsPlan(createPlan(), candidateCount)).not.toThrow();
  });

  it('accepts the compact per-iteration and aggregate row boundaries', () => {
    expect(() =>
      assertBoundedSanctionsPlan(
        createPlan({ source: { 'Rows Removed by Filter': 63, 'Shared Hit Blocks': 128 } }),
        candidateCount,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'a compact scan examining 65 rows in one iteration',
      source: { 'Rows Removed by Filter': 64, 'Actual Loops': 1 },
    },
    { name: 'more compact source loops than candidates', source: { 'Actual Loops': 33 } },
    { name: 'compact source buffers above 128', source: { 'Shared Hit Blocks': 129 } },
    { name: 'root buffers above 512', rootBlocks: 513 },
    { name: 'the compact allowance on a different relation', source: { 'Relation Name': 'other' } },
    { name: 'the compact allowance on an index scan', source: { 'Node Type': 'Index Scan' } },
    { name: 'candidate per-iteration work above 64', candidate: { 'Actual Rows': 65 } },
    { name: 'candidate aggregate work above 64', candidate: { 'Actual Loops': 3 } },
    {
      name: 'successor per-iteration work above 8',
      successor: { 'Actual Rows': 9, 'Actual Loops': 1 },
    },
    {
      name: 'successor aggregate work above its candidate budget',
      successor: { 'Actual Rows': 8, 'Actual Loops': 33 },
    },
    {
      name: 'successor buffers above its candidate budget',
      successor: { 'Shared Hit Blocks': 257 },
      rootBlocks: 512,
    },
    {
      name: 'source point-probe buffers above its candidate budget',
      source: {
        'Node Type': 'Index Only Scan',
        'Rows Removed by Filter': 0,
        'Shared Hit Blocks': 257,
      },
      rootBlocks: 512,
    },
  ])('rejects $name', ({ name: _name, ...overrides }) => {
    expect(() => assertBoundedSanctionsPlan(createPlan(overrides), candidateCount)).toThrow(
      'Sanctions registry exceeded work bounds',
    );
  });

  describe.each(['retained', 'cleared'] as const)('%s source history', (phase) => {
    const pointProbe: Partial<SanctionsPlanNode> = {
      'Node Type': 'Index Only Scan',
      'Index Name': 'moderation_events_pkey',
      'Index Cond': '((id >= feed.id) AND (id <= feed.id))',
      'Rows Removed by Filter': 0,
      'Shared Hit Blocks': 128,
    };

    it('accepts the closed primary-key probe once per candidate', () => {
      expect(() =>
        assertBoundedSanctionsPlan(createPlan({ source: pointProbe }), candidateCount, phase),
      ).not.toThrow();
    });

    it('rejects even a one-row sequential source scan', () => {
      expect(() =>
        assertBoundedSanctionsPlan(
          createPlan({ source: { 'Rows Removed by Filter': 0 } }),
          candidateCount,
          phase,
        ),
      ).toThrow('Sanctions registry exceeded work bounds');
    });

    it('rejects an open source key range', () => {
      expect(() =>
        assertBoundedSanctionsPlan(
          createPlan({ source: { ...pointProbe, 'Index Cond': '(id >= feed.id)' } }),
          candidateCount,
          phase,
        ),
      ).toThrow('Sanctions registry exceeded work bounds');
    });

    it('requires exactly one source probe per candidate', () => {
      expect(() =>
        assertBoundedSanctionsPlan(
          createPlan({ source: { ...pointProbe, 'Actual Loops': candidateCount - 1 } }),
          candidateCount,
          phase,
        ),
      ).toThrow('Sanctions registry exceeded work bounds');
    });
  });
});

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
      await prisma.$executeRawUnsafe('ANALYZE moderation_events');
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
      const plan = await prisma.$queryRaw<SanctionsPlan>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statements[0]!}`,
      );
      assertBoundedSanctionsPlan(plan, candidateCount);
    } finally {
      await prisma.chatModerationFeedItem.deleteMany({ where: { chatId: { in: ownedChats } } });
      await prisma.chat.deleteMany({ where: { id: { in: ownedChats } } });
    }
  });

  it('bounds exact source probes through retained history and deleted-key gaps without losing missing sources', async () => {
    const planChatId = `${chatId}-source-plan`;
    const historyChatId = `${chatId}-source-history`;
    const ownedChats = [planChatId, historyChatId];
    const candidateCount = 32;
    const missingSourceId = `${planChatId}-ban-0`;
    try {
      await prisma.chat.createMany({
        data: ownedChats.map((id) => ({ id, title: 'Sanctions source plan fixture' })),
      });
      await prisma.moderationEvent.createMany({
        data: Array.from({ length: candidateCount }, (_, index) => ({
          id: `${planChatId}-ban-${index}`,
          chatId: planChatId,
          userId: `source-user-${index}`,
          eventType: EventType.SYSTEM,
          action: SanctionAction.BAN,
          ruleCode: 'MANUAL_BAN',
          createdAt: ago(2),
        })),
      });
      await prisma.$transaction(
        async (tx) => {
          // FLAG: Hold insertion, deletion and both plans in the same transaction.
          // Uncommitted history cannot be vacuumed away between the sparse-heap
          // fixture and its measurement. Place every deleted key after the missing
          // source and before its next live key; an open seek must cross that gap.
          expect(
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO moderation_events
                (id, chat_id, user_id, event_type, rule_code, action, created_at)
              SELECT ${missingSourceId} || '-ordinary-' || n, ${historyChatId}, 'history-user',
                'SYSTEM'::"EventType", 'PLAN_HISTORY', 'NONE'::"SanctionAction", NOW()
              FROM generate_series(1, 20000) n
            `),
          ).toBe(20_000);
          const [gap] = await tx.$queryRaw<{ count: bigint }[]>(Prisma.sql`
            SELECT count(*) AS count FROM moderation_events
            WHERE chat_id = ${historyChatId}
              AND id > ${missingSourceId} AND id < ${`${planChatId}-ban-1`}
          `);
          expect(gap!.count).toBe(20_000n);
          const transactionFence = new ModerationSanctionStateFenceService(tx as never);
          for (const phase of ['retained', 'cleared'] as const) {
            if (phase === 'cleared') {
              expect(
                (await tx.moderationEvent.deleteMany({ where: { chatId: historyChatId } })).count,
              ).toBe(20_000);
              await tx.moderationEvent.delete({ where: { id: missingSourceId } });
              expect(
                await tx.chatModerationFeedItem.findUnique({ where: { id: missingSourceId } }),
              ).not.toBeNull();
            }
            await tx.$executeRawUnsafe('ANALYZE moderation_events');
            await tx.$executeRawUnsafe('ANALYZE chat_moderation_feed_items');
            const [size] = await tx.$queryRaw<{ heapPages: bigint }[]>(Prisma.sql`
              SELECT pg_relation_size('moderation_events') / current_setting('block_size')::bigint AS "heapPages"
            `);
            expect(Number(size!.heapPages)).toBeGreaterThan(128);
            const statements: Prisma.Sql[] = [];
            const reader: Pick<Prisma.TransactionClient, '$queryRaw'> = {
              $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql) {
                if (!('sql' in query)) throw new Error('Expected the captured sanctions SQL');
                statements.push(query);
                return tx.$queryRaw<T>(query);
              },
            };
            const page = await new ChatSanctionsService(reader as never, transactionFence).getPage(
              planChatId,
              'admin',
              { status: 'all', limit: 50 },
            );
            expect(page.items).toHaveLength(candidateCount);
            expect(page.items.filter((item) => item.status === 'active')).toHaveLength(
              candidateCount - (phase === 'cleared' ? 1 : 0),
            );
            if (phase === 'cleared') {
              expect(page.items.find((item) => item.id === missingSourceId)).toMatchObject({
                status: 'review',
                releaseAction: null,
              });
            }
            expect(statements).toHaveLength(1);
            const plan = await tx.$queryRaw<SanctionsPlan>(
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statements[0]!}`,
            );
            assertBoundedSanctionsPlan(plan, candidateCount, phase);
          }
        },
        { timeout: 45_000 },
      );
    } finally {
      await prisma.chatModerationFeedItem.deleteMany({ where: { chatId: { in: ownedChats } } });
      await prisma.chat.deleteMany({ where: { id: { in: ownedChats } } });
      await prisma.$executeRawUnsafe('ANALYZE moderation_events');
      await prisma.$executeRawUnsafe('ANALYZE chat_moderation_feed_items');
    }
  }, 60_000);
});
