import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Queue } from 'bullmq';
import { Prisma } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
type Plan = { [key: string]: unknown; Plans?: Plan[] };

describePostgres('PostgreSQL delete due selection', () => {
  const schema = `delete_due_${randomUUID().replaceAll('-', '')}`;
  let client: Client;
  let locker: Client;
  let query: Prisma.Sql;
  let explain = false;
  let plan: Plan;
  let service: ModerationDeleteIntentService;
  let queue: Queue<ModerationDeleteIntentJob> | undefined;
  let createService: (overrides?: Record<string, unknown>) => ModerationDeleteIntentService;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    client = new Client({ connectionString: databaseUrl });
    locker = new Client({ connectionString: databaseUrl });
    await client.connect();
    await locker.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    for (const connection of [client, locker]) {
      await connection.query(`SET search_path TO "${schema}", public`);
      await connection.query('SET statement_timeout = 15000');
      await connection.query('SET max_parallel_workers_per_gather = 0');
    }
    await client.query(`CREATE TABLE moderation_delete_intents (
      id text PRIMARY KEY, chat_id text NOT NULL DEFAULT 'fixture',
      message_id text NOT NULL DEFAULT 'fixture',
      status "ModerationDeleteIntentStatus" NOT NULL,
      next_attempt_at timestamp NOT NULL, execute_at timestamp NOT NULL DEFAULT '2026-01-01',
      created_at timestamp NOT NULL, retry_until_at timestamp NOT NULL DEFAULT '2099-01-01',
      retention_owned boolean NOT NULL DEFAULT false,
      remote_delete_succeeded_at timestamp, remote_delete_succeeded_bot_id text,
      delete_dispatch_started_at timestamp, delete_dispatch_started_bot_id text,
      lease_expires_at timestamp DEFAULT '2026-01-01', suggestion_subscription_id text,
      attempt_count integer NOT NULL DEFAULT 0, commercial_ocr_guard_required boolean NOT NULL DEFAULT false
    )`);
    // Use the production index, including its execute_at rather than created_at suffix.
    await client.query(
      'CREATE INDEX due_idx ON moderation_delete_intents(status, next_attempt_at, execute_at)',
    );
    await client.query(
      'CREATE INDEX status_created_id_idx ON moderation_delete_intents(status, created_at, id)',
    );
    await client.query(`CREATE TABLE moderation_delete_intent_reasons (
      intent_id text NOT NULL, rule_code text NOT NULL, reason_key text NOT NULL, metadata jsonb,
      id text NOT NULL DEFAULT 'fixture-reason',
      created_at timestamp NOT NULL DEFAULT '2026-01-01'
    )`);
    await client.query(
      'CREATE INDEX reason_idx ON moderation_delete_intent_reasons(intent_id, reason_key)',
    );
    const prisma = {
      $queryRaw: async (value: Prisma.Sql) => {
        query = value;
        const result = await client.query(
          `${explain ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' : ''}${value.text}`,
          value.values,
        );
        if (explain) {
          plan = result.rows[0]['QUERY PLAN'][0].Plan as Plan;
          return [];
        }
        return result.rows;
      },
    };
    createService = (overrides = {}) =>
      new ModerationDeleteIntentService(
        prisma as never,
        {} as never,
        {} as never,
        queue as never,
        new ConfigService({
          MODERATION_DELETE_INTENT_MODE: 'shadow',
          COMMERCIAL_OCR_ROLLOUT_MODE: 'baseline',
          MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
          MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
          ...overrides,
        }),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
  });

  afterAll(async () => {
    await locker?.query('ROLLBACK');
    await locker?.end();
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  beforeEach(async () => {
    explain = false;
    service = createService();
    await client.query('TRUNCATE moderation_delete_intent_reasons, moderation_delete_intents');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
      queue = undefined;
    }
  });

  const select = () =>
    (
      service as unknown as { selectDueIntentIds(): Promise<Array<{ id: string }>> }
    ).selectDueIntentIds();

  async function seed(count: number) {
    await client.query(
      `INSERT INTO moderation_delete_intents (id, status, next_attempt_at, created_at)
      SELECT n::text, (ARRAY['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'])[1+n%5]::"ModerationDeleteIntentStatus",
        TIMESTAMP '2026-01-01' + n * INTERVAL '1 millisecond', TIMESTAMP '2026-01-01' + n * INTERVAL '1 millisecond'
      FROM generate_series(1, $1::int) n`,
      [count],
    );
    await client.query(`INSERT INTO moderation_delete_intent_reasons
      (intent_id, rule_code, reason_key, metadata)
      SELECT id, 'BOT_MESSAGE_AUTO_DELETE', 'fixture', '{}'::jsonb FROM moderation_delete_intents`);
    await client.query('ANALYZE moderation_delete_intents');
    await client.query('ANALYZE moderation_delete_intent_reasons');
  }

  it('repairs a missing tail wakeup behind existing jobs while the real queue is paused', async () => {
    const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim();
    if (!redisUrl) throw new Error('This recovery case requires disposable PostgreSQL and Redis');
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Disposable local Redis required');
    queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, {
      connection: { host: url.hostname, port: Number(url.port || 6379) },
      prefix: `delete-due-recovery-${randomUUID()}`,
    });
    await queue.pause();
    service = createService();
    // FLAG: Isolate scheduling from unchanged expiry; real SQL selects and real Redis
    // handoffs remain in the test. A failed initial enqueue leaves this durable state.
    jest
      .spyOn(service as unknown as { expireDueIntents(): Promise<number> }, 'expireDueIntents')
      .mockResolvedValue(0);
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at)
      SELECT 'recover-'||lpad(n::text,3,'0'),'PENDING',
        TIMESTAMP '2026-01-01' + n*INTERVAL '1 millisecond',
        TIMESTAMP '2026-01-01' + n*INTERVAL '1 millisecond'
      FROM generate_series(1,101)n;
      INSERT INTO moderation_delete_intent_reasons(intent_id,rule_code,reason_key,metadata)
      SELECT id,'BOT_MESSAGE_AUTO_DELETE','fixture','{}'::jsonb FROM moderation_delete_intents;`);
    await queue.addBulk(
      Array.from({ length: 100 }, (_, index) => {
        const intentId = `recover-${String(index + 1).padStart(3, '0')}`;
        return {
          name: 'execute-moderation-delete-intent',
          data: { intentId },
          opts: {
            jobId: `mdi-${intentId}`,
            priority: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        };
      }),
    );
    for (let tick = 0; tick < 8; tick++) await service.sweepDueIntents();
    expect(await queue.getJob('mdi-recover-101')).toBeDefined();
    expect(await queue.isPaused()).toBe(true);
    expect((await queue.getJob('mdi-recover-001'))?.opts.priority).toBe(1);

    await (await queue.getJob('mdi-recover-001'))!.remove();
    await service.sweepDueIntents();
    expect(await queue.getJob('mdi-recover-001')).toBeDefined();
    const retained = await client.query(
      "SELECT count(*)::int AS count FROM moderation_delete_intents WHERE status='PENDING'",
    );
    expect(retained.rows[0].count).toBe(101);
  });

  it.each(['base', 'optional', 'guarded'])(
    'bounds intent and reason scans with scope %s',
    async (scope) => {
      if (scope === 'optional')
        service = createService({
          MODERATION_DELETE_INTENT_MODE: 'canary',
          MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-fixture',
          MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: true,
          MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
          IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
        });
      await seed(50_000);
      if (scope === 'guarded') {
        await client.query(
          "UPDATE moderation_delete_intent_reasons SET rule_code='MESSAGE_TOO_LONG_DELETE'",
        );
        await client.query('ANALYZE moderation_delete_intent_reasons');
      }
      explain = true;
      await select();
      const scans: Plan[] = [];
      const visit = (node: Plan) => {
        if (node['Relation Name'] === 'moderation_delete_intents') scans.push(node);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      const visited = scans.reduce(
        (sum, node) =>
          sum +
          (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) *
            Number(node['Actual Loops']),
        0,
      );
      expect(visited).toBeLessThan(2_000);
      const reasonScans: Plan[] = [];
      const visitReasons = (node: Plan) => {
        if (node['Relation Name'] === 'moderation_delete_intent_reasons') reasonScans.push(node);
        node.Plans?.forEach(visitReasons);
      };
      visitReasons(plan);
      const reasonRowsVisited = reasonScans.reduce(
        (sum, node) =>
          sum +
          (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) *
            Number(node['Actual Loops']),
        0,
      );
      expect(reasonRowsVisited).toBeLessThan(10_000);
      explain = false;
      expect(await select()).toEqual(
        Array.from({ length: 100 }, (_, n) => ({ id: String(n + 1) })),
      );
    },
  );

  it('indexes the production active-mute projection independently of unrelated reason history', async () => {
    await seed(50_000);
    await client.query(
      "UPDATE moderation_delete_intent_reasons SET rule_code='MUTE_ACTIVE_DELETE' WHERE intent_id='7'",
    );
    await client.query("DELETE FROM moderation_delete_intent_reasons WHERE intent_id='9'");
    await client.query('ANALYZE moderation_delete_intent_reasons');
    const selectors = service as unknown as {
      intentColumnsSql(alias?: string): Prisma.Sql;
      intentSelectSql(alias: string): Prisma.Sql;
    };
    // FLAG: Exercise the real derived projection. Only base columns absent from this
    // disposable schema are narrowed; no production reason predicate is duplicated here.
    const columns = jest
      .spyOn(selectors, 'intentColumnsSql')
      .mockReturnValue(Prisma.sql`intent."id"`);
    try {
      for (const [id, activeMuteDeleteReason] of [
        ['7', true],
        ['8', false],
        ['9', false],
      ] as const) {
        const statement = Prisma.sql`
          SELECT ${selectors.intentSelectSql('intent')}
          FROM moderation_delete_intents intent
          WHERE intent."id" = ${id}
          LIMIT 1
        `;
        const result = await client.query<{ id: string; activeMuteDeleteReason: boolean }>(
          statement.text,
          statement.values,
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({ id, activeMuteDeleteReason });
        const explained = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
          statement.values,
        );
        const nodes: Plan[] = [];
        const visit = (node: Plan) => {
          nodes.push(node);
          node.Plans?.forEach(visit);
        };
        visit(explained.rows[0]['QUERY PLAN'][0].Plan as Plan);
        const muteScans = nodes.filter(
          (node) =>
            node['Relation Name'] === 'moderation_delete_intent_reasons' &&
            node.Alias === 'mute_reason',
        );
        expect(muteScans).toHaveLength(1);
        expect(muteScans[0]).toMatchObject({ 'Index Name': 'reason_idx' });
        expect(String(muteScans[0]!['Index Cond'])).toContain('intent_id');
        const visited = (node: Plan) =>
          (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) *
          Number(node['Actual Loops']);
        expect(visited(muteScans[0]!)).toBeLessThanOrEqual(1);
        const allReasonRows = nodes
          .filter((node) => node['Relation Name'] === 'moderation_delete_intent_reasons')
          .reduce((sum, node) => sum + visited(node), 0);
        expect(allReasonRows).toBeLessThan(100);
      }
    } finally {
      columns.mockRestore();
    }
  });

  it('keeps due, lease, retention, rollout and retry-evidence predicates in every status lane', async () => {
    await seed(30);
    await client.query(
      `UPDATE moderation_delete_intents SET next_attempt_at='2099-01-01' WHERE id='1'`,
    );
    await client.query(`UPDATE moderation_delete_intents SET execute_at='2099-01-01' WHERE id='2'`);
    await client.query(`UPDATE moderation_delete_intents SET retention_owned=true WHERE id='3'`);
    await client.query(
      `UPDATE moderation_delete_intents SET retry_until_at='2025-01-01' WHERE id IN ('4','6')`,
    );
    await client.query(
      `UPDATE moderation_delete_intents SET lease_expires_at='2099-01-01' WHERE id='9'`,
    );
    await client.query(
      `UPDATE moderation_delete_intents SET delete_dispatch_started_at='2026-01-01', attempt_count=5 WHERE id='6'`,
    );
    await client.query(`UPDATE moderation_delete_intents SET attempt_count=5 WHERE id='7'`);
    await client.query(
      `UPDATE moderation_delete_intent_reasons SET rule_code='UNENABLED_FIXTURE' WHERE intent_id='8'`,
    );
    const result = (await select()).map((row) => row.id);
    expect(result).toContain('6'); // Unknown dispatch remains reconciliation work, never a new send.
    for (const id of ['1', '2', '3', '4', '7', '8', '9']) expect(result).not.toContain(id);
    expect(result).toHaveLength(23);
  });

  it('admits fresh pending and retryable deletes alongside a full older ambiguous backlog', async () => {
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at,retry_until_at,delete_dispatch_started_at)
      SELECT 'old-'||n,'AMBIGUOUS','2026-01-01','2026-01-01','2026-01-02','2026-01-01'
      FROM generate_series(1,200)n;
      INSERT INTO moderation_delete_intent_reasons
      (intent_id,rule_code,reason_key,metadata)
      SELECT id,'BOT_MESSAGE_AUTO_DELETE','fixture','{}'::jsonb FROM moderation_delete_intents;
      INSERT INTO moderation_delete_intents (id,status,next_attempt_at,created_at)
      VALUES ('fresh-voice','RETRYABLE','2026-10-01','2026-10-01'),
        ('fresh-pending','PENDING','2026-10-01','2026-10-01');
      INSERT INTO moderation_delete_intent_reasons (intent_id,rule_code,reason_key,metadata) VALUES
        ('fresh-voice','VOICE_BLOCKED_DELETE','voice','{}'),
        ('fresh-pending','PHOTO_BLOCKED_DELETE','photo','{}');`);
    const selected = (await select()).map((row) => row.id);
    expect(selected).toContain('fresh-voice');
    expect(selected).toContain('fresh-pending');
    expect(selected).toHaveLength(100);
    expect(selected.filter((id) => id.startsWith('old-'))).toHaveLength(98);
    const evidence = await client.query(`SELECT count(*)::int AS retained
      FROM moderation_delete_intents WHERE status='AMBIGUOUS'
        AND delete_dispatch_started_at='2026-01-01' AND retry_until_at='2026-01-02'`);
    expect(evidence.rows[0].retained).toBe(200);
  });

  it('skips locked rows and interleaves ordered status lanes under the total batch cap', async () => {
    await seed(600);
    await locker.query('BEGIN');
    try {
      await locker.query(
        `SELECT id FROM moderation_delete_intents WHERE id::int <= 120 FOR UPDATE`,
      );
      expect(await select()).toEqual(
        Array.from({ length: 100 }, (_, n) => ({ id: String(n + 121) })),
      );
      expect(query.text).toContain('SKIP LOCKED');
    } finally {
      await locker.query('ROLLBACK');
    }
  });
});
