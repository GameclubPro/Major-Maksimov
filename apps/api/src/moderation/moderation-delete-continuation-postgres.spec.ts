import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { DeleteDueContinuation } from './moderation-delete-due-selection';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
const now = new Date('2026-11-10T20:00:00.000Z');
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const statuses = [
  'PENDING',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'IN_PROGRESS',
] as const;
type Status = (typeof statuses)[number];
type Plan = { [key: string]: unknown; Plans?: Plan[] };
type RawRow = { id: string; createdAt: Date; lane: Status; eligible: boolean };

describePostgres('PostgreSQL bounded DELETE continuation', () => {
  jest.setTimeout(30_000);
  const schema = `delete_continuation_${randomUUID().replaceAll('-', '')}`;
  let client: Client;
  let locker: Client;
  let continuation: DeleteDueContinuation;
  let statement: Prisma.Sql;
  let rawRows: RawRow[];
  let nextQueryError: Error | undefined;
  let createdIndex: string;
  let prisma: Pick<PrismaService, '$queryRaw'>;

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
      await connection.query("SET TIME ZONE 'UTC'");
      await connection.query('SET statement_timeout = 15000');
      await connection.query('SET lock_timeout = 1000');
      await connection.query('SET max_parallel_workers_per_gather = 0');
    }
    // FLAG: Clone the migrated production columns, constraints and indexes. Foreign
    // keys are not copied by LIKE, so this fixture cannot write production relations.
    await client.query(`CREATE TABLE moderation_delete_intents
      (LIKE public.moderation_delete_intents INCLUDING ALL)`);
    await client.query(`CREATE TABLE moderation_delete_intent_reasons
      (LIKE public.moderation_delete_intent_reasons INCLUDING ALL)`);
    // Only the exact indexed hold projection read by the selector is needed here.
    for (const relation of ['webhook_source_abandonments', 'webhook_backlog_receipts']) {
      await client.query(`CREATE TABLE ${relation}
        (chat_id text NOT NULL, message_id text NOT NULL, PRIMARY KEY (chat_id, message_id))`);
    }
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2',
      [schema, 'moderation_delete_intents'],
    );
    const creationIndexes = indexes.rows.filter((row) =>
      row.indexdef.endsWith('(status, created_at, id)'),
    );
    expect(creationIndexes).toHaveLength(1);
    createdIndex = creationIndexes[0]!.indexname;
    // The bridge executes the actual public helper's Prisma.Sql, including its
    // real eligibility/rollout expressions. It does not duplicate their SQL.
    prisma = {
      $queryRaw: async (query: Prisma.Sql) => {
        if (nextQueryError) {
          const error = nextQueryError;
          nextQueryError = undefined;
          throw error;
        }
        statement = query;
        const result = await client.query<RawRow>(query.text, query.values);
        rawRows = result.rows;
        return result.rows;
      },
    } as unknown as Pick<PrismaService, '$queryRaw'>;
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
    continuation = new DeleteDueContinuation();
    nextQueryError = undefined;
    rawRows = [];
    await client.query(`TRUNCATE moderation_delete_intent_reasons, moderation_delete_intents,
      webhook_source_abandonments, webhook_backlog_receipts`);
  });

  afterEach(async () => {
    await locker.query('ROLLBACK');
  });

  function rollout(overrides: Record<string, unknown> = {}): Prisma.Sql {
    const service = new ModerationDeleteIntentService(
      prisma as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({
        MODERATION_DELETE_INTENT_MODE: 'off',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'another-chat',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
        ...overrides,
      }),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return (
      service as unknown as { buildSweepRolloutFilter(): Prisma.Sql }
    ).buildSweepRolloutFilter();
  }

  const select = (
    limit = 100,
    options: {
      now?: Date;
      headIds?: ReadonlySet<string>;
      rolloutFilter?: Prisma.Sql;
    } = {},
  ) =>
    continuation.select(prisma, {
      now: options.now ?? now,
      limit,
      headIds: options.headIds ?? new Set<string>(),
      rolloutFilter: options.rolloutFilter ?? rollout(),
    });

  async function insert(
    id: string,
    options: {
      status?: Status;
      createdAt?: Date;
      rule?: string;
    } = {},
  ) {
    const status = options.status ?? 'PENDING';
    await client.query(
      `INSERT INTO moderation_delete_intents
      (id,chat_id,message_id,status,execute_at,next_attempt_at,retry_until_at,created_at,
        lease_token,lease_expires_at)
      VALUES ($1,'fixture',$1,$2::"ModerationDeleteIntentStatus",'2026-01-01','2026-01-01',
        '2099-01-01',$3,$4,$5)`,
      [
        id,
        status,
        options.createdAt ?? createdAt,
        status === 'IN_PROGRESS' ? `lease-${id}` : null,
        status === 'IN_PROGRESS' ? createdAt : null,
      ],
    );
    await client.query(
      `INSERT INTO moderation_delete_intent_reasons
      (id,intent_id,reason_key,rule_code,metadata)
      VALUES ($1,$2,'fixture',$3,'{}')`,
      [`reason-${id}`, id, options.rule ?? 'BOT_MESSAGE_AUTO_DELETE'],
    );
  }

  async function seedHistory(count: number, skew: boolean, status?: 'OBSERVED') {
    await client.query(
      `INSERT INTO moderation_delete_intents
      (id,chat_id,message_id,status,execute_at,next_attempt_at,retry_until_at,created_at,
        retention_owned,attempt_count,lease_token,lease_expires_at)
      SELECT 'history-'||lpad(n::text,6,'0'),'fixture','history-'||lpad(n::text,6,'0'),
        CASE WHEN $3::text IS NOT NULL THEN $3::"ModerationDeleteIntentStatus"
          ELSE (ARRAY['PENDING','RETRYABLE','WAITING_CAPABILITY','AMBIGUOUS','IN_PROGRESS'])
            [1+(n-1)%5]::"ModerationDeleteIntentStatus" END,
        CASE WHEN $2 AND n%7=0 THEN $1::timestamp + INTERVAL '1 hour' ELSE TIMESTAMP '2026-01-01' END,
        CASE WHEN $2 AND n%11=0 THEN $1::timestamp + INTERVAL '1 hour' ELSE TIMESTAMP '2026-01-01' END,
        TIMESTAMP '2099-01-01',TIMESTAMP '2026-01-01',
        $2 AND n%13=0,CASE WHEN $2 AND n%19=0 THEN 5 ELSE 0 END,
        CASE WHEN $3::text IS NULL AND n%5=0 THEN 'lease-'||n ELSE NULL END,
        CASE WHEN $3::text IS NULL AND n%5=0 THEN
          CASE WHEN $2 AND n%3=0 THEN $1::timestamp + INTERVAL '1 hour'
            ELSE TIMESTAMP '2026-01-01' END ELSE NULL END
      FROM generate_series(1,$4::int)n`,
      [now, skew, status ?? null, count],
    );
    await client.query(
      `INSERT INTO moderation_delete_intent_reasons
      (id,intent_id,reason_key,rule_code,metadata)
      SELECT 'reason-'||id,id,'fixture',
        CASE WHEN $1 AND right(id,6)::int%17=0 THEN 'UNENABLED_FIXTURE'
          ELSE 'BOT_MESSAGE_AUTO_DELETE' END,'{}'::jsonb
      FROM moderation_delete_intents`,
      [skew],
    );
    await client.query('ANALYZE moderation_delete_intents');
    await client.query('ANALYZE moderation_delete_intent_reasons');
  }

  function nodes(plan: Plan): Plan[] {
    return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
  }

  function visits(node: Plan): number {
    return (
      (Number(node['Actual Rows']) +
        Number(node['Rows Removed by Filter'] ?? 0) +
        Number(node['Rows Removed by Index Recheck'] ?? 0)) *
      Number(node['Actual Loops'])
    );
  }

  async function assertBoundedPlan(limit: number, seek = false) {
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
      statement.values,
    );
    const all = nodes(result.rows[0]['QUERY PLAN'][0].Plan as Plan);
    const rawScans = all.filter(
      (node) => node['Relation Name'] === 'moderation_delete_intents' && node.Alias === 'source',
    );
    expect(rawScans.length).toBeGreaterThan(0);
    for (const scan of rawScans) {
      expect(scan['Index Name']).toBe(createdIndex);
      expect(scan['Index Cond']).toContain('status');
      if (seek && visits(scan)) {
        expect(scan['Index Cond']).toContain('created_at');
        expect(scan['Index Cond']).toContain('id');
      }
    }
    expect(rawScans.reduce((sum, node) => sum + visits(node), 0)).toBeLessThanOrEqual(limit);
    const intentProbes = all.filter(
      (node) => node['Relation Name'] === 'moderation_delete_intents' && node.Alias === 'intent',
    );
    expect(intentProbes.reduce((sum, node) => sum + visits(node), 0)).toBeLessThanOrEqual(limit);
    for (const probe of intentProbes) expect(String(probe['Index Cond'])).toContain('id');
    const reasonProbes = all.filter(
      (node) => node['Relation Name'] === 'moderation_delete_intent_reasons',
    );
    expect(reasonProbes.reduce((sum, node) => sum + visits(node), 0)).toBeLessThan(100 * limit);
    for (const probe of reasonProbes) expect(String(probe['Index Cond'])).toContain('intent_id');
  }

  it.each([1, 100])(
    'bounds raw, PK and reason work before skew/locks with budget %i',
    async (limit) => {
      await seedHistory(50_000, true);
      await select(limit);
      const firstPage = rawRows.map((row) => row.id);
      expect(firstPage).toHaveLength(limit);
      await assertBoundedPlan(limit);

      await locker.query('BEGIN');
      await locker.query(
        'SELECT id FROM moderation_delete_intents WHERE id=ANY($1::text[]) FOR UPDATE',
        [firstPage],
      );
      const locked = await select(limit);
      expect(rawRows.map((row) => row.id)).toEqual(firstPage);
      expect(locked.ids).toEqual([]);
      await assertBoundedPlan(limit);
      // FLAG: Locked/rejected raw rows consume the bounded page rather than making
      // the query scan ahead to fill its eligible result. Wrap retries them later.
      locked.commit();
      const next = await select(limit);
      expect(rawRows.length).toBeLessThanOrEqual(limit);
      expect(rawRows.every((row) => !firstPage.includes(row.id))).toBe(true);
      expect(next.ids.length).toBeLessThanOrEqual(limit);
    },
  );

  it('seeks beyond retained tied history when the committed cursor row disappears', async () => {
    await seedHistory(50_000, false, 'OBSERVED');
    await insert('cursor-anchor', { createdAt: new Date('2026-02-01T00:00:00.000Z') });
    await insert('next-page', { createdAt: new Date('2026-03-01T00:00:00.000Z') });
    const first = await select(1);
    expect(first.ids).toEqual([{ id: 'cursor-anchor' }]);
    first.commit();
    await client.query("DELETE FROM moderation_delete_intents WHERE id='cursor-anchor'");
    await client.query(
      "UPDATE moderation_delete_intents SET status='PENDING' WHERE status='OBSERVED'",
    );
    await client.query('ANALYZE moderation_delete_intents');
    const next = await select(100);
    expect(next.ids).toEqual([{ id: 'next-page' }]);
    expect(rawRows).toHaveLength(1);
    await assertBoundedPlan(100, true);
  });

  it('rotates a one-row budget across all five status lanes', async () => {
    for (const [index, status] of statuses.entries()) await insert(`lane-${index}`, { status });
    const selected: string[] = [];
    for (let index = 0; index < statuses.length; index++) {
      const page = await select(1);
      expect(rawRows).toHaveLength(1);
      selected.push(...page.ids.map((row) => row.id));
      page.commit();
      page.commit();
    }
    expect(selected).toEqual(statuses.map((_, index) => `lane-${index}`));
  });

  it('uses the id tie-break, excludes current head rows and wraps without changing SQL state', async () => {
    for (let index = 1; index <= 7; index++) await insert(`tied-${index}`);
    const before = await client.query(
      'SELECT row_to_json(intent) AS row FROM moderation_delete_intents intent ORDER BY id',
    );
    const selected: string[] = [];
    for (let index = 0; index < 9; index++) {
      const page = await select(5, { headIds: new Set(['tied-1', 'tied-2']) });
      expect(rawRows.length).toBeLessThanOrEqual(1);
      selected.push(...page.ids.map((row) => row.id));
      page.commit();
    }
    expect(selected).toEqual(['tied-3', 'tied-4', 'tied-5', 'tied-6', 'tied-7']);
    const after = await client.query(
      'SELECT row_to_json(intent) AS row FROM moderation_delete_intents intent ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);
    await locker.query('BEGIN');
    await expect(
      locker.query('SELECT id FROM moderation_delete_intents FOR UPDATE NOWAIT'),
    ).resolves.toMatchObject({ rowCount: 7 });
  });

  it('keeps a fixed cycle horizon and admits newer work after wrapping', async () => {
    await insert('old', { createdAt: new Date(now.getTime() - 1) });
    const first = await select(5);
    expect(first.ids).toEqual([{ id: 'old' }]);
    first.commit();
    const later = new Date(now.getTime() + 1000);
    await insert('new', { createdAt: new Date(now.getTime() + 1) });
    const end = await select(5, { now: later });
    expect(rawRows).toEqual([]);
    expect(end.ids).toEqual([]);
    end.commit();
    const wrapped = await select(5, { now: later });
    expect(wrapped.ids).toEqual([{ id: 'old' }]);
    wrapped.commit();
    expect((await select(5, { now: later })).ids).toEqual([{ id: 'new' }]);
  });

  it('rechecks formerly ineligible rows on wrap and skips a changed status', async () => {
    await insert('a-future');
    await insert('b-changed');
    await insert('c-current');
    await client.query(
      "UPDATE moderation_delete_intents SET next_attempt_at='2099-01-01' WHERE id='a-future'",
    );
    const first = await select(5);
    expect(rawRows.map((row) => row.id)).toEqual(['a-future']);
    expect(first.ids).toEqual([]);
    first.commit();
    await client.query(
      "UPDATE moderation_delete_intents SET next_attempt_at='2026-01-01' WHERE id='a-future'",
    );
    await client.query(
      "UPDATE moderation_delete_intents SET status='SUCCEEDED' WHERE id='b-changed'",
    );
    const current = await select(5);
    expect(current.ids).toEqual([{ id: 'c-current' }]);
    current.commit();
    const end = await select(5);
    expect(end.ids).toEqual([]);
    end.commit();
    expect((await select(5)).ids).toEqual([{ id: 'a-future' }]);
  });

  it.each(['off', 'shadow', 'canary', 'on'])(
    'preserves current eligibility and evidence guards in every lane with rollout %s',
    async (mode) => {
      const expected: string[] = [];
      for (const status of statuses) {
        const ids = Object.fromEntries(
          [
            'due',
            'future-attempt',
            'future-execute',
            'retention',
            'expired',
            'dispatch',
            'receipt',
            'held',
            'cancelled',
            'live-lease',
            'capped',
            'base-only',
            'ordinary',
            'ocr-off',
          ].map((kind) => [kind, `${status}-${kind}`]),
        );
        for (const [kind, id] of Object.entries(ids)) {
          await insert(id, {
            status,
            rule:
              kind === 'base-only'
                ? 'BASE_ONLY_FIXTURE'
                : kind === 'ordinary'
                  ? 'VOICE_BLOCKED_DELETE'
                  : kind === 'ocr-off'
                    ? 'COMMERCIAL_OCR_DELETE'
                    : 'BOT_MESSAGE_AUTO_DELETE',
          });
        }
        await client.query('UPDATE moderation_delete_intents SET next_attempt_at=$2 WHERE id=$1', [
          ids['future-attempt'],
          new Date(now.getTime() + 1000),
        ]);
        await client.query('UPDATE moderation_delete_intents SET execute_at=$2 WHERE id=$1', [
          ids['future-execute'],
          new Date(now.getTime() + 1000),
        ]);
        await client.query(
          'UPDATE moderation_delete_intents SET retention_owned=true WHERE id=$1',
          [ids.retention],
        );
        await client.query(
          `UPDATE moderation_delete_intents SET retry_until_at='2026-01-02'
        WHERE id=ANY($1::text[])`,
          [[ids.expired, ids.dispatch, ids.receipt]],
        );
        await client.query(
          `UPDATE moderation_delete_intents SET delete_dispatch_started_at='2026-01-01',
        delete_dispatch_started_bot_id='exact-bot',attempt_count=5 WHERE id=$1`,
          [ids.dispatch],
        );
        await client.query(
          `UPDATE moderation_delete_intents SET remote_delete_succeeded_at='2026-01-01',
        remote_delete_succeeded_bot_id='exact-bot',attempt_count=5 WHERE id=$1`,
          [ids.receipt],
        );
        await client.query(
          'UPDATE moderation_delete_intents SET lease_token=$2,lease_expires_at=$3 WHERE id=$1',
          [ids['live-lease'], `live-${status}`, new Date(now.getTime() + 1000)],
        );
        await client.query('UPDATE moderation_delete_intents SET attempt_count=5 WHERE id=$1', [
          ids.capped,
        ]);
        await client.query(
          `INSERT INTO webhook_source_abandonments(chat_id,message_id)
        VALUES ('fixture',$1),('fixture',$2)`,
          [ids.held, ids.receipt],
        );
        await client.query(
          `INSERT INTO webhook_backlog_receipts(chat_id,message_id)
        VALUES ('fixture',$1),('fixture',$2)`,
          [ids.cancelled, ids.receipt],
        );
        expected.push(ids.due!, ids.dispatch!, ids.receipt!, ids.ordinary!);
        if (status !== 'IN_PROGRESS') expected.push(ids['live-lease']!);
        if (mode === 'on') expected.push(ids['base-only']!);
      }
      const result = await select(100, {
        rolloutFilter: rollout({ MODERATION_DELETE_INTENT_MODE: mode }),
      });
      expect(rawRows).toHaveLength(70);
      expect(result.ids.map((row) => row.id).sort()).toEqual(expected.sort());
      const retained =
        await client.query(`SELECT count(*)::int AS count FROM moderation_delete_intents
      WHERE delete_dispatch_started_bot_id='exact-bot' OR remote_delete_succeeded_bot_id='exact-bot'`);
      expect(retained.rows[0].count).toBe(10);
    },
  );

  it('retries aborted/failed SQL pages and restarts from the head without durable cursor state', async () => {
    for (const status of statuses) {
      await insert(`${status}-a`, { status });
      await insert(`${status}-b`, { status });
    }
    const first = await select(5);
    const firstIds = first.ids.map((row) => row.id);
    expect(firstIds).toHaveLength(5);
    first.commit();
    const failure = new Error('fixture SQL unavailable');
    nextQueryError = failure;
    await expect(select(5)).rejects.toBe(failure);
    const uncommitted = await select(5);
    expect(uncommitted.ids.map((row) => row.id)).toEqual(
      firstIds.map((id) => id.replace(/-a$/u, '-b')),
    );
    expect((await select(5)).ids).toEqual(uncommitted.ids);
    continuation = new DeleteDueContinuation();
    expect((await select(5)).ids.map((row) => row.id)).toEqual(firstIds);
  });
});
