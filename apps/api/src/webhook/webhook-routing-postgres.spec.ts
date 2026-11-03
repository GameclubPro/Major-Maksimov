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
  const prefix = `routing-${randomUUID()}-`;
  const chatId = `${prefix}chat`;
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
    await client.query('DELETE FROM webhook_events WHERE id LIKE $1', [`${prefix}%`]);
  });

  afterAll(async () => {
    await client?.end();
  });

  async function insert(params: {
    id: string;
    status?: string;
    queue?: string | null;
    payload?: object;
    createdAt?: string;
    retry?: boolean;
    error?: string | null;
  }) {
    await client.query(
      `INSERT INTO webhook_events
       (id, dedup_key, status, queue_name, raw_payload, normalized_payload, created_at, next_enqueue_at, error_message)
       VALUES ($1, $1, $2::"WebhookStatus", $3, '{}', $4::jsonb, $5, $6, $7)`,
      [
        `${prefix}${params.id}`,
        params.status ?? 'RECEIVED',
        params.queue ?? null,
        JSON.stringify(params.payload ?? { type: 'message_created', message: { chatId } }),
        params.createdAt ?? '2026-01-01T00:00:00Z',
        params.retry ? new Date('2026-01-02T00:00:00Z') : null,
        params.error ?? null,
      ],
    );
  }

  async function assertEquivalent(excluded: string, expected: Result) {
    const previous = oldQuery(chatId, `${prefix}${excluded}`);
    const next = await productionQuery(chatId, `${prefix}${excluded}`);
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

  it('uses bounded queue probes for custom and generic plans with a hot chat', async () => {
    await client.query(
      `INSERT INTO webhook_events (id, dedup_key, status, queue_name, raw_payload, normalized_payload, created_at)
       SELECT $1 || n, $1 || n, 'RECEIVED'::"WebhookStatus",
         CASE WHEN n % 2 = 0 THEN NULL ELSE 'legacy-queue' END, '{}',
         jsonb_build_object('type', 'message_created', 'message', jsonb_build_object('chatId', $2::text)),
         '2020-01-01'::timestamp + n * interval '1 second'
       FROM generate_series(1, 4000) n`,
      [`${prefix}hot-`, chatId],
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
    await client.query('ANALYZE webhook_events');
    await assertEquivalent('current', {
      has_pending: true,
      queue_name: DEFAULT_WEBHOOK_QUEUE_NAMES[0]!,
    });
    const query = await productionQuery(chatId, `${prefix}current`);
    await client.query(`PREPARE routing_plan AS ${query.text}`);
    try {
      for (const mode of ['force_custom_plan', 'force_generic_plan']) {
        await client.query(`SET plan_cache_mode = ${mode}`);
        const execution = query.values.map(testLiteral).join(', ');
        const result = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE routing_plan(${execution})`,
        );
        const nodes = planNodes(result.rows[0]!['QUERY PLAN']);
        const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
        const planRoot = nodes.find((node) => typeof node['Node Type'] === 'string');
        const safeIndexes = [
          'webhook_events_ordered_chat_head_idx',
          'webhook_events_chat_queue_head_idx',
          'webhook_events_pkey',
        ];
        process.stdout.write(
          `routing-plan-before-assert ${JSON.stringify({
            mode,
            scans: scans.map((scan) => ({
              type: scan['Node Type'],
              index: safeIndexes.includes(String(scan['Index Name']))
                ? scan['Index Name']
                : 'other',
              queueInIndex: String(scan['Index Cond'] ?? '').includes('queue_name'),
              queueInFilter: String(scan.Filter ?? '').includes('queue_name'),
              parameterized: /\$\d+/u.test(String(scan['Index Cond'] ?? '')),
              rows: scan['Actual Rows'],
              loops: scan['Actual Loops'],
              filtered: scan['Rows Removed by Filter'] ?? 0,
              rechecked: scan['Rows Removed by Index Recheck'] ?? 0,
              sharedHits: scan['Shared Hit Blocks'] ?? 0,
              sharedReads: scan['Shared Read Blocks'] ?? 0,
            })),
            sorts: nodes
              .filter((node) => node['Node Type'] === 'Sort')
              .map((node) => ({
                rows: node['Actual Rows'],
                loops: node['Actual Loops'],
                method: node['Sort Method'],
              })),
            sharedHits: planRoot?.['Shared Hit Blocks'],
            sharedReads: planRoot?.['Shared Read Blocks'],
          })}\n`,
        );
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(['Index Scan', 'Index Only Scan']).toContain(scan['Node Type']);
          expect([
            'webhook_events_ordered_chat_head_idx',
            'webhook_events_chat_queue_head_idx',
          ]).toContain(scan['Index Name']);
        }
        const indexed = scans.filter(
          (node) =>
            node['Index Name'] === 'webhook_events_chat_queue_head_idx' &&
            typeof node['Index Cond'] === 'string' &&
            node['Index Cond'].includes('queue_name'),
        );
        expect(indexed.length).toBeGreaterThan(0);
        const queueLoops = indexed.reduce(
          (total, node) => total + Number(node['Actual Loops'] ?? 0),
          0,
        );
        expect(queueLoops).toBe(DEFAULT_WEBHOOK_QUEUE_NAMES.length);
        const existenceScans = scans.filter((node) => !indexed.includes(node));
        expect(existenceScans.length).toBeGreaterThan(0);
        const examined = (records: Record<string, unknown>[]) =>
          records.reduce(
            (total, node) =>
              total +
              (Number(node['Actual Rows'] ?? 0) +
                Number(node['Rows Removed by Filter'] ?? 0) +
                Number(node['Rows Removed by Index Recheck'] ?? 0)) *
                Number(node['Actual Loops'] ?? 0),
            0,
          );
        const queueRows = examined(indexed);
        const existenceRows = examined(existenceScans);
        expect(queueRows).toBeLessThanOrEqual(DEFAULT_WEBHOOK_QUEUE_NAMES.length + 1);
        expect(existenceRows).toBeLessThanOrEqual(2);
        const sorts = nodes.filter((node) => node['Node Type'] === 'Sort');
        const sortInputs = sorts.map((node) => {
          const children = Array.isArray(node.Plans) ? node.Plans : [];
          expect(children).toHaveLength(1);
          const child = children[0] as Record<string, unknown>;
          return Number(child['Actual Rows'] ?? 0) * Number(child['Actual Loops'] ?? 0);
        });
        for (const rows of sortInputs)
          expect(rows).toBeLessThanOrEqual(DEFAULT_WEBHOOK_QUEUE_NAMES.length);
        const rootPlan = nodes.find((node) => typeof node['Node Type'] === 'string');
        expect(rootPlan).toBeDefined();
        expect(typeof rootPlan!['Shared Hit Blocks']).toBe('number');
        expect(typeof rootPlan!['Shared Read Blocks']).toBe('number');
        const sharedBlocks =
          Number(rootPlan!['Shared Hit Blocks']) + Number(rootPlan!['Shared Read Blocks']);
        expect(sharedBlocks).toBeLessThanOrEqual(512);
        expect(Number(rootPlan!['Temp Read Blocks'] ?? 0)).toBe(0);
        expect(Number(rootPlan!['Temp Written Blocks'] ?? 0)).toBe(0);
        if (mode === 'force_generic_plan') expect(JSON.stringify(indexed)).toMatch(/\$\d+/u);
        console.info(
          'routing-plan-summary',
          JSON.stringify({ mode, queueLoops, queueRows, existenceRows, sortInputs, sharedBlocks }),
        );
      }
    } finally {
      await client.query('DEALLOCATE routing_plan');
      await client.query('RESET plan_cache_mode');
    }
  });
});
