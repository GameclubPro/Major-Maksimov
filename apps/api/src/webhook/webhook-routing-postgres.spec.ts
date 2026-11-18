import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Prisma } from '../prisma/prisma-client';
import { WebhookRoutingService } from './webhook-routing.service';
import { DEFAULT_WEBHOOK_QUEUE_NAMES } from './webhook-queues';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

type Result = { has_pending: boolean; queue_name: string | null };

function oldQuery(chatId: string, eventId: string): Prisma.Sql {
  return Prisma.sql`
    WITH outstanding AS MATERIALIZED (
      SELECT queue_name, created_at, id FROM webhook_events
      WHERE id <> ${eventId}
        AND (status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
          OR (status = 'FAILED'::"WebhookStatus" AND
            (next_enqueue_at IS NOT NULL OR LEFT(COALESCE(error_message, ''), 37)
              = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')))
        AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
          NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
          = ANY(ARRAY['message_created', 'message_edited'])
        AND COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
          NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = ${chatId}
    )
    SELECT EXISTS (SELECT 1 FROM outstanding LIMIT 1) AS has_pending,
      (SELECT queue_name FROM outstanding
       WHERE queue_name IN (${Prisma.join(DEFAULT_WEBHOOK_QUEUE_NAMES)})
       ORDER BY created_at, id LIMIT 1) AS queue_name
  `;
}

async function productionQuery(chatId: string, eventId: string): Promise<Prisma.Sql> {
  let captured: Prisma.Sql | undefined;
  const service = Object.create(WebhookRoutingService.prototype) as {
    findOutstandingMessageQueueWork(chat: string, event: string): Promise<unknown>;
  };
  Object.defineProperty(service, 'prisma', {
    value: {
      $queryRaw: async (query: Prisma.Sql) => {
        captured = query;
        return [{ has_pending: false, queue_name: null }];
      },
    },
  });
  await service.findOutstandingMessageQueueWork(chatId, eventId);
  if (!captured) throw new Error('Routing query was not captured');
  return captured;
}

function planNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(planNodes)];
}

function testLiteral(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected test string parameter');
  return `'${value.replaceAll("'", "''")}'`;
}

describePostgres('bounded PostgreSQL webhook routing', () => {
  jest.setTimeout(60_000);
  const prefix = `r${randomUUID().slice(0, 7)}-`;
  const chatId = `${prefix}c`;
  let client: Client;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    client = new Client({ connectionString: databaseUrl, statement_timeout: 30_000 });
    await client.connect();
  });

  afterEach(async () => {
    await client.query('DROP TABLE IF EXISTS pg_temp.webhook_events');
    await client.query('DELETE FROM webhook_events WHERE id LIKE $1', [`${prefix}%`]);
  });

  afterAll(async () => {
    await client?.end();
  });

  async function insert(params: {
    id: string;
    botId?: string;
    status?: string;
    queue?: string | null;
    payload?: object;
    createdAt?: string;
    retry?: boolean;
    error?: string | null;
  }) {
    await client.query(
      `INSERT INTO webhook_events
       (id, dedup_key, status, queue_name, raw_payload, normalized_payload, created_at, next_enqueue_at, error_message, bot_id)
       VALUES ($1, $1, $2::"WebhookStatus", $3, '{}', $4::jsonb, $5, $6, $7, $8)`,
      [
        `${prefix}${params.id}`,
        params.status ?? 'RECEIVED',
        params.queue ?? null,
        JSON.stringify(params.payload ?? { type: 'message_created', message: { chatId } }),
        params.createdAt ?? '2026-01-01T00:00:00Z',
        params.retry ? new Date('2026-01-02T00:00:00Z') : null,
        params.error ?? null,
        params.botId ?? 'routing-bot-a',
      ],
    );
  }

  async function assertEquivalent(excluded: string, expected: Result, chat: string = chatId) {
    const previous = oldQuery(chat, `${prefix}${excluded}`);
    const next = await productionQuery(chat, `${prefix}${excluded}`);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const oldResult = await client.query<Result>(previous.text, previous.values);
      const newResult = await client.query<Result>(next.text, next.values);
      expect(newResult.rows).toEqual(oldResult.rows);
      expect(newResult.rows).toEqual([expected]);
    } finally {
      await client.query('ROLLBACK');
    }
  }

  it('matches the original pending and earliest shard semantics', async () => {
    await assertEquivalent('current', { has_pending: false, queue_name: null });
    await insert({ id: 'current', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0] });
    await assertEquivalent('current', { has_pending: false, queue_name: null });
    await insert({ id: 'terminal', status: 'FAILED', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0] });
    await insert({ id: 'processed', status: 'PROCESSED', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0] });
    await insert({ id: 'duplicate', status: 'DUPLICATE', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0] });
    await insert({
      id: 'quarantined',
      status: 'QUARANTINED',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0],
    });
    await insert({
      id: 'wrong-type',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0],
      payload: { type: 'bot_started', chatId },
    });
    await insert({
      id: 'other-chat',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[0],
      payload: { type: 'message_created', chatId: `${chatId}-other` },
    });
    await assertEquivalent('current', { has_pending: false, queue_name: null });
    await insert({ id: 'null' });
    await insert({ id: 'legacy', queue: 'legacy-queue' });
    await assertEquivalent('current', { has_pending: true, queue_name: null });
    await insert({
      id: 'tie-b',
      status: 'QUEUED',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[1],
      createdAt: '2026-01-03T00:00:00Z',
    });
    await insert({
      id: 'tie-a',
      botId: 'routing-bot-b',
      status: 'FAILED',
      retry: true,
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[2],
      createdAt: '2026-01-03T00:00:00Z',
      payload: {
        type: ' ',
        update_type: ' MESSAGE_EDITED ',
        chatId: ` ${chatId} `,
        botId: 'another-bot',
      },
    });
    await insert({
      id: 'quarantine',
      status: 'FAILED',
      error: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:marker',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[3],
      createdAt: '2026-01-04T00:00:00Z',
    });
    await assertEquivalent('current', {
      has_pending: true,
      queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[2]!,
    });
    await assertEquivalent('tie-a', {
      has_pending: true,
      queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[0]!,
    });
  });

  it('keeps pending and shard selection in the same snapshot during concurrent changes', async () => {
    await insert({ id: 'old', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[1] });
    const writer = new Client({ connectionString: databaseUrl, statement_timeout: 30_000 });
    await writer.connect();
    const next = await productionQuery(chatId, `${prefix}current`);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const before = await client.query<Result>(
        oldQuery(chatId, `${prefix}current`).text,
        oldQuery(chatId, `${prefix}current`).values,
      );
      await writer.query('UPDATE webhook_events SET status = $1::"WebhookStatus" WHERE id = $2', [
        'PROCESSED',
        `${prefix}old`,
      ]);
      const during = await client.query<Result>(next.text, next.values);
      expect(during.rows).toEqual(before.rows);
      expect(during.rows).toEqual([
        { has_pending: true, queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[1] },
      ]);
    } finally {
      await client.query('ROLLBACK');
      await writer.end();
    }
    const after = await client.query<Result>(next.text, next.values);
    expect(after.rows).toEqual([{ has_pending: false, queue_name: null }]);
  });

  it('excludes the current event within timestamp ties shared by different bots', async () => {
    await insert({ id: 'a' });
    await insert({ id: 'b', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[1] });
    await insert({ id: 'c', botId: 'routing-bot-b', queue: DEFAULT_WEBHOOK_QUEUE_NAMES[3] });
    await assertEquivalent('b', { has_pending: true, queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[3]! });
  });

  it('seeks the exact chat with and without the optional queue index', async () => {
    // FLAG: Index changes below belong only to the session-local clone of the migrated table.
    await client.query(
      'CREATE TEMP TABLE webhook_events (LIKE public.webhook_events INCLUDING DEFAULTS INCLUDING INDEXES)',
    );
    const orderedIndex = 'webhook_events_ordered_chat_head_idx';
    const queueIndex = 'webhook_events_chat_queue_head_idx';
    const indexes = await client.query<{ rename: string }>(
      `SELECT format('ALTER INDEX pg_temp.%I RENAME TO %I', clone.relname, original.relname) AS rename
       FROM pg_index ci JOIN pg_class clone ON clone.oid = ci.indexrelid
       JOIN pg_index oi ON oi.indrelid = 'public.webhook_events'::regclass
       JOIN pg_class original ON original.oid = oi.indexrelid
       WHERE ci.indrelid = 'pg_temp.webhook_events'::regclass AND original.relname = ANY($1)
         AND split_part(pg_get_indexdef(ci.indexrelid), ' USING ', 2)
           = split_part(pg_get_indexdef(oi.indexrelid), ' USING ', 2)`,
      [[orderedIndex, queueIndex]],
    );
    expect(indexes.rows).toHaveLength(2);
    for (const index of indexes.rows) await client.query(index.rename);
    const legacyOnlyChat = `${chatId}-legacy`;
    await client.query(
      `INSERT INTO webhook_events (id, dedup_key, status, queue_name, raw_payload, normalized_payload, created_at)
       SELECT $1 || lane || '-' || n, $1 || lane || '-' || n, 'RECEIVED'::"WebhookStatus",
         CASE WHEN n % 2 = 0 THEN NULL ELSE 'legacy-queue' END, '{}',
         jsonb_build_object('type', 'message_created', 'message',
           jsonb_build_object('chatId', CASE WHEN lane = 1 THEN $2::text ELSE $3::text END)),
         '2020-01-01'::timestamp + n * interval '1 second'
       FROM generate_series(1, 4000) n CROSS JOIN generate_series(1, 2) lane`,
      [`${prefix}hot-`, chatId, legacyOnlyChat],
    );
    await client.query(
      `INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
       SELECT $1 || n, $1 || n, 'PROCESSED'::"WebhookStatus", '{}', '{}', '2019-01-01'
       FROM generate_series(1, 12000) n`,
      [`${prefix}history-`],
    );
    for (const [index, queue] of DEFAULT_WEBHOOK_QUEUE_NAMES.entries()) {
      await insert({ id: `valid-${index}`, queue, createdAt: '2026-01-03T00:00:00Z' });
    }
    const knownChat = `${chatId}-known`;
    const currentChat = `${chatId}-current`;
    const emptyChat = `${chatId}-empty`;
    await client.query(
      `INSERT INTO webhook_events (id, dedup_key, bot_id, status, queue_name, raw_payload, normalized_payload, created_at)
       SELECT $1 || n, $1 || n, 'routing-bot-' || (n % 5), 'QUEUED'::"WebhookStatus", $3, '{}',
         jsonb_build_object('type', 'message_created', 'chatId',
           CASE WHEN n <= 4000 THEN $2::text ELSE $2::text || '-' || n END),
         '2026-01-01'::timestamp + n * interval '1 second'
       FROM generate_series(1, 24000) n`,
      [`${prefix}known-`, knownChat, DEFAULT_WEBHOOK_QUEUE_NAMES[3]],
    );
    await insert({
      id: 'current',
      queue: DEFAULT_WEBHOOK_QUEUE_NAMES[1],
      payload: { type: 'message_created', chatId: currentChat },
    });
    const scenarios = [
      {
        chat: chatId,
        name: 'legacy-head',
        headRows: 1,
        successorLoops: 1,
        successorRows: 4000,
        expected: { has_pending: true, queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[0]! },
      },
      {
        chat: legacyOnlyChat,
        name: 'legacy-only',
        headRows: 1,
        successorLoops: 1,
        successorRows: 3999,
        expected: { has_pending: true, queue_name: null },
      },
      {
        chat: knownChat,
        name: 'known-head',
        headRows: 1,
        successorLoops: 0,
        successorRows: 0,
        expected: { has_pending: true, queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[3]! },
      },
      {
        chat: currentChat,
        name: 'current-only',
        headRows: 1,
        successorLoops: 0,
        successorRows: 0,
        expected: { has_pending: false, queue_name: null },
      },
      {
        chat: emptyChat,
        name: 'empty',
        headRows: 0,
        successorLoops: 0,
        successorRows: 0,
        expected: { has_pending: false, queue_name: null },
      },
    ];
    await client.query('ANALYZE webhook_events');
    for (const scenario of scenarios)
      await assertEquivalent('current', scenario.expected, scenario.chat);
    const query = await productionQuery(chatId, `${prefix}current`);
    for (const stage of ['with_queue_index', 'without_queue_index']) {
      if (stage === 'without_queue_index')
        await client.query('DROP INDEX pg_temp.webhook_events_chat_queue_head_idx');
      await client.query(`PREPARE routing_plan AS ${query.text}`);
      try {
        for (const mode of ['force_custom_plan', 'force_generic_plan']) {
          await client.query(`SET plan_cache_mode = ${mode}`);
          for (const scenario of scenarios) {
            const execution = (await productionQuery(scenario.chat, `${prefix}current`)).values
              .map(testLiteral)
              .join(', ');
            const statement = `EXECUTE routing_plan(${execution})`;
            const result = await client.query<Result>(statement);
            expect(result.rows).toEqual([scenario.expected]);
            const explain = await client.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
            );
            const [plan] = explain.rows[0]!['QUERY PLAN'];
            const nodes = planNodes(plan.Plan);
            const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
            expect(scans).toHaveLength(2);
            const queueScans = scans.filter((node) => String(node.Filter).includes('queue_name'));
            expect(queueScans).toHaveLength(1);
            const successor = queueScans[0]!;
            const head = scans.find((node) => node !== successor)!;
            const visited = (node: Record<string, unknown>) =>
              (Number(node['Actual Rows']) +
                Number(node['Rows Removed by Filter'] ?? 0) +
                Number(node['Rows Removed by Index Recheck'] ?? 0)) *
              Number(node['Actual Loops']);
            const blocks =
              Number(plan.Plan['Local Hit Blocks']) + Number(plan.Plan['Local Read Blocks']);
            const observed = {
              stage,
              mode,
              scenario: scenario.name,
              headRows: visited(head),
              successorLoops: successor['Actual Loops'],
              successorRows: visited(successor),
              blocks,
            };
            console.info('routing-plan-summary', JSON.stringify(observed));
            for (const scan of scans) {
              expect(scan['Node Type']).toBe('Index Scan');
              expect(scan['Index Name']).toBe(orderedIndex);
              const cond = String(scan['Index Cond']);
              expect(cond).toContain('chatId');
              expect(cond).toMatch(mode === 'force_generic_plan' ? /= \$\d+/u : /= '[^']+'::text/u);
            }
            expect(String(successor['Index Cond'])).toMatch(/ROW\(created_at, id\) > ROW\(/u);
            expect(head['Actual Loops']).toBe(1);
            expect(observed).toMatchObject({
              headRows: scenario.headRows,
              successorLoops: scenario.successorLoops,
              successorRows: scenario.successorRows,
            });
            expect(nodes.filter((node) => String(node['Node Type']).includes('Sort'))).toHaveLength(
              0,
            );
            expect(blocks).toBeGreaterThan(0);
            expect(blocks).toBeLessThanOrEqual(512);
            expect(plan.Plan['Temp Read Blocks']).toBe(0);
            expect(plan.Plan['Temp Written Blocks']).toBe(0);
          }
        }
      } finally {
        await client.query('DEALLOCATE routing_plan');
        await client.query('RESET plan_cache_mode');
      }
    }
  });
});
