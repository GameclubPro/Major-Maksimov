import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Queue, Worker } from 'bullmq';
import { Prisma } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { buildDeleteWakeupQuery, processQueuedDeleteWakeup } from './moderation-delete-wakeup';
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
      lease_token text, leased_from_status "ModerationDeleteIntentStatus",
      completed_at timestamp, updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      $executeRaw: async (value: Prisma.Sql) =>
        (await client.query(value.text, value.values)).rowCount ?? 0,
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

  // FLAG: Removing 600,000 disposable jobs can exceed Jest's 5s default on CI runners.
  afterEach(async () => {
    jest.restoreAllMocks();
    const ownedQueue = queue;
    queue = undefined;
    if (ownedQueue) {
      try {
        await ownedQueue.obliterate({ force: true });
      } finally {
        await ownedQueue.close();
      }
    }
  }, 30_000);

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

  it('drains stale queue wakeups without reason reads or MAX attempts and retains unresolved effects', async () => {
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at,retry_until_at,retention_owned,lease_expires_at,
       remote_delete_succeeded_at,delete_dispatch_started_bot_id)
      VALUES
      ('settled','SUCCEEDED','2026-01-01','2026-01-01','2026-01-02',false,null,null,null),
      ('observed','OBSERVED','2026-01-01','2026-01-01','2026-01-02',false,null,null,null),
      ('future','RETRYABLE','2099-01-01','2026-01-01','2099-01-02',false,null,null,null),
      ('leased','IN_PROGRESS','2026-01-01','2026-01-01','2099-01-02',false,'2099-01-01',null,null),
      ('owned','PENDING','2026-01-01','2026-01-01','2099-01-02',true,null,null,null),
      ('receipt','AMBIGUOUS','2026-01-01','2026-01-01','2026-01-02',false,null,'2026-01-01',null),
      ('dispatch','AMBIGUOUS','2026-01-01','2026-01-01','2026-01-02',false,null,null,'bot-1'),
      ('fresh','PENDING','2026-01-01','2026-01-01','2099-01-02',false,null,null,null)`);
    const attempt = jest.spyOn(service, 'attemptIntent').mockImplementation(async (intentId) => ({
      intentId,
      kind: 'pending',
      confirmed: false,
      status: 'PENDING',
    }));
    for (const id of [
      'missing',
      'settled',
      'observed',
      'future',
      'leased',
      'owned',
      'receipt',
      'dispatch',
      'fresh',
    ]) {
      await service.processQueuedIntent(id);
      expect(query.text).not.toContain('moderation_delete_intent_reasons');
    }
    expect(attempt.mock.calls.map(([id]) => id)).toEqual(['receipt', 'dispatch', 'fresh']);
    const markers = await client.query(
      "SELECT id,status FROM moderation_delete_intents WHERE id IN ('receipt','dispatch') ORDER BY id",
    );
    expect(markers.rows).toEqual([
      { id: 'dispatch', status: 'AMBIGUOUS' },
      { id: 'receipt', status: 'AMBIGUOUS' },
    ]);
    expect(service.getDueSweepRuntimeSnapshot().wakeups).toMatchObject({
      calls: 9,
      missing: 1,
      settled: 2,
      scheduled: 1,
      leased: 1,
      retentionOwned: 1,
      expiryChecked: 0,
      attempted: 3,
      errors: 0,
    });
  });

  it('rechecks newly persisted dispatch evidence before fast expiry', async () => {
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at,retry_until_at)
      VALUES ('raced','PENDING','2026-01-01','2026-01-01','2026-01-02')`);
    const attempt = jest.fn();
    const prisma = {
      $queryRaw: async <T>(value: Prisma.Sql) =>
        (await client.query(value.text, value.values)).rows as T,
    };
    await processQueuedDeleteWakeup(prisma, 'raced', attempt, async () => {
      await locker.query(
        "UPDATE moderation_delete_intents SET delete_dispatch_started_bot_id='bot-1' WHERE id='raced'",
      );
      await (
        service as unknown as { expireIntentIfDue(id: string): Promise<void> }
      ).expireIntentIfDue('raced');
    });
    expect(attempt).not.toHaveBeenCalled();
    const current = await client.query(
      "SELECT status,delete_dispatch_started_bot_id FROM moderation_delete_intents WHERE id='raced'",
    );
    expect(current.rows).toEqual([{ status: 'PENDING', delete_dispatch_started_bot_id: 'bot-1' }]);
  });

  it('keeps queued-wakeup work to one primary-key row with 420000 retained intents', async () => {
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at)
      SELECT n::text,'SUCCEEDED','2026-01-01','2026-01-01' FROM generate_series(1,420000)n`);
    await client.query('ANALYZE moderation_delete_intents');
    const value = buildDeleteWakeupQuery('420000');
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${value.text}`,
      value.values,
    );
    const root = result.rows[0]['QUERY PLAN'][0].Plan as Plan;
    expect(root['Node Type']).toBe('Index Scan');
    expect(root['Actual Rows']).toBe(1);
    expect(Number(root['Shared Hit Blocks']) + Number(root['Shared Read Blocks'])).toBeLessThan(12);
    const attempt = jest.spyOn(service, 'attemptIntent');
    await service.processQueuedIntent('420000');
    expect(attempt).not.toHaveBeenCalled();
  }, 30_000);

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

  it('recovers a lost fresh enqueue and a vanished SQL head above the historical window', async () => {
    const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim();
    if (!redisUrl) throw new Error('This recovery case requires disposable PostgreSQL and Redis');
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Disposable local Redis required');
    const connection = { host: url.hostname, port: Number(url.port || 6379) };
    const prefix = `delete-full-recovery-${randomUUID()}`;
    queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, { connection, prefix });
    await queue.pause();
    for (let offset = 0; offset < 600_000; offset += 1000) {
      await queue.addBulk(
        Array.from({ length: 1000 }, (_, index) => {
          const intentId = `retained-${offset + index}`;
          return {
            name: 'execute-moderation-delete-intent',
            data: { intentId },
            opts: { jobId: `mdi-${intentId}`, priority: 10, removeOnComplete: true },
          };
        }),
      );
    }
    service = createService();
    jest
      .spyOn(service as unknown as { expireDueIntents(): Promise<number> }, 'expireDueIntents')
      .mockResolvedValue(0);
    // FLAG: These durable rows model a failed initial enqueue and retained history.
    // SQL selection and handoff use both real stores; no external effect is executed.
    await client.query(`INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,created_at)
      SELECT 'retained-'||n::text,'AMBIGUOUS',
        TIMESTAMP '2026-01-01' + n*INTERVAL '1 millisecond',
        TIMESTAMP '2026-01-01' + n*INTERVAL '1 millisecond'
      FROM generate_series(0,99)n;
      INSERT INTO moderation_delete_intents(id,status,next_attempt_at,created_at)
      VALUES ('fresh-lost','PENDING',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      INSERT INTO moderation_delete_intents(id,status,next_attempt_at,created_at)
      SELECT 'missing-tail-'||n::text,'AMBIGUOUS',
        TIMESTAMP '2026-01-02' + n*INTERVAL '1 millisecond',
        TIMESTAMP '2026-01-02' + n*INTERVAL '1 millisecond'
      FROM generate_series(0,99)n;
      INSERT INTO moderation_delete_intent_reasons(intent_id,rule_code,reason_key,metadata)
      SELECT id,'BOT_MESSAGE_AUTO_DELETE','fixture','{}'::jsonb FROM moderation_delete_intents;`);
    await service.sweepDueIntents();
    expect(await queue.getJob('mdi-fresh-lost')).toBeDefined();
    await (await queue.getJob('mdi-retained-0'))!.remove();
    await service.sweepDueIntents();
    expect(await queue.getJob('mdi-retained-0')).toBeDefined();
    for (let tick = 0; tick < 8; tick++) await service.sweepDueIntents();
    expect(service.getDueSweepRuntimeSnapshot().historicalAdmission.deferredCount).toBeGreaterThan(
      0,
    );
    expect(await queue.getJob('mdi-missing-tail-0')).toBeUndefined();
    expect((await queue.getJob('mdi-retained-1'))!.opts.priority).toBe(10);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 600_001 });
    expect(await queue.isPaused()).toBe(true);
    await queue.add(
      'execute-moderation-delete-intent',
      { intentId: 'direct-fresh' },
      {
        jobId: 'mdi-direct-fresh',
        priority: 1,
        removeOnComplete: true,
      },
    );
    await queue.resume();
    const worker = new Worker<ModerationDeleteIntentJob>(
      MODERATION_DELETE_INTENT_QUEUE,
      undefined,
      {
        connection,
        prefix,
        autorun: false,
      },
    );
    try {
      const handled: string[] = [];
      for (let index = 0; index < 4; index++) {
        const token = randomUUID();
        const job = await worker.getNextJob(token, { block: false });
        expect(job).toBeDefined();
        handled.push(job!.data.intentId);
        await job!.moveToCompleted(null, token, false);
      }
      expect(handled).toEqual(['direct-fresh', 'fresh-lost', 'retained-0', 'retained-1']);
    } finally {
      await worker.close();
    }
    const retained = await client.query(
      "SELECT status,lease_token,retry_until_at FROM moderation_delete_intents WHERE id='fresh-lost'",
    );
    expect(retained.rows[0]).toMatchObject({ status: 'PENDING', lease_token: null });
    expect(retained.rows[0].retry_until_at.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  }, 120_000);

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
