import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { StatsChangesService } from './stats-changes.service';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const native = databaseUrl ? describe : describe.skip;
const maxInt64 = 9_223_372_036_854_775_807n;
type Query = { query: string; params: string };
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
};

native('central statistics relay on native PostgreSQL', () => {
  let db: PrismaClient;
  let raw: Client;
  let entityId: string;
  let feed: StatsChangesService;
  const queries: Query[] = [];
  const applicationName = `stats-relay-${randomUUID()}`;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL race_test database required');
    const logged = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, {
        max: 6,
        statement_timeout: 15_000,
        application_name: applicationName,
      }),
      log: [{ emit: 'event', level: 'query' }],
    });
    logged.$on('query', ({ query, params }) => queries.push({ query, params }));
    db = logged;
    raw = new Client({ connectionString: databaseUrl, statement_timeout: 15_000 });
    await raw.connect();
    expect((await raw.query('SHOW TimeZone')).rows[0].TimeZone).toBe('UTC');
  });

  beforeEach(async () => {
    // FLAG: Every fixture owns one entity and removes only its cascading source rows.
    // An unrelated pending fixture would make global relay order assertions ambiguous.
    expect(await db.statsChange.count({ where: { publishedSeq: null } })).toBe(0);
    entityId = randomUUID();
    await db.statsEntity.create({
      data: {
        id: entityId,
        kind: 'CHANNEL',
        maxId: `-${BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)) + 1n}`,
      },
    });
    feed = new StatsChangesService(db as PrismaService, new ConfigService());
    queries.length = 0;
  });

  afterEach(async () => {
    await raw.query('ROLLBACK');
    if (entityId) await db.statsEntity.deleteMany({ where: { id: entityId } });
  });

  afterAll(async () => {
    await raw?.end();
    await db?.$disconnect();
  });

  const head = async () =>
    (
      await raw.query<{ seq: string }>(
        'SELECT COALESCE(max(published_seq),0)::text AS seq FROM stats_changes',
      )
    ).rows[0]!.seq;
  const rows = () =>
    db.statsChange.findMany({
      where: { entityId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const pending = async (count: number) => {
    const createdAt = new Date(Date.now() - 3_600_000);
    await db.statsChange.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        entityId,
        entityRevision: 9_007_199_254_740_991n + BigInt(index),
        cause: ['DATA', 'AUTHORITY', 'DELETE'][index % 3]!,
        authorityId: index % 2 ? randomUUID() : null,
        createdAt: new Date(createdAt.getTime() + Math.floor(index / 7)),
      })),
    });
    return db.statsChange.findMany({
      where: { entityId, publishedSeq: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  };
  const seedHead = async (publishedSeq: bigint) => {
    expect(BigInt(await head())).toBeLessThan(publishedSeq);
    return db.statsChange.create({
      data: {
        entityId,
        entityRevision: 0n,
        cause: 'DATA',
        createdAt: new Date(Date.now() - 2 * 3_600_000),
        publishedSeq,
        publishedAt: new Date(),
      },
    });
  };
  const publicationCommands = (captured: Query[]) =>
    captured.filter(({ query }) => /^(?:SELECT|UPDATE|WITH)\b/iu.test(query.trimStart()));
  const updates = (captured: Query[]) =>
    captured.filter(({ query }) => /\bUPDATE\s+stats_changes\b/iu.test(query));
  const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
  const planWork = (nodes: Plan[]) =>
    nodes.map((node) => ({
      type: node['Node Type'],
      relation: node['Relation Name'],
      index: node['Index Name'],
      rows: node['Actual Rows'],
      loops: node['Actual Loops'],
      filtered: node['Rows Removed by Filter'] ?? 0,
    }));
  const visits = (nodes: Plan[]) =>
    nodes.reduce(
      (sum, node) =>
        sum +
        (node['Actual Rows'] +
          (node['Rows Removed by Filter'] ?? 0) +
          (node['Rows Removed by Index Recheck'] ?? 0)) *
          node['Actual Loops'],
      0,
    );
  const explain = async (query: Query): Promise<Plan[]> => {
    const result = await raw.query<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`,
      JSON.parse(query.params) as unknown[],
    );
    return flatten(result.rows[0]!['QUERY PLAN'][0]!.Plan);
  };

  it('publishes 500 then 3 ordered rows with exact bigint slots and one UPDATE per party', async () => {
    const initialHead = 9_007_199_254_740_991n;
    const anchor = await seedHead(initialHead);
    const source = (await pending(503)).filter(({ id }) => id !== anchor.id);
    queries.length = 0;
    await feed.relay();
    const firstCommands = [...queries];
    expect(publicationCommands(firstCommands)).toHaveLength(4);
    expect(updates(firstCommands)).toHaveLength(1);
    const first = (await rows()).filter(({ id }) => id !== anchor.id);
    expect(first.map(({ publishedSeq }) => publishedSeq)).toEqual([
      ...Array.from({ length: 500 }, (_, index) => initialHead + BigInt(index) + 1n),
      null,
      null,
      null,
    ]);
    expect(new Set(first.slice(0, 500).map(({ publishedAt }) => publishedAt!.getTime())).size).toBe(
      1,
    );
    expect(first.slice(500).every(({ publishedAt }) => publishedAt === null)).toBe(true);
    queries.length = 0;
    await feed.relay();
    expect(publicationCommands(queries)).toHaveLength(4);
    expect(updates(queries)).toHaveLength(1);
    const complete = (await rows()).filter(({ id }) => id !== anchor.id);
    expect(complete.map(({ publishedSeq }) => publishedSeq)).toEqual(
      source.map((_, index) => initialHead + BigInt(index) + 1n),
    );
    expect(new Set(complete.slice(500).map(({ publishedAt }) => publishedAt!.getTime())).size).toBe(
      1,
    );
    expect(
      complete.map(({ publishedSeq: _seq, publishedAt: _at, ...original }) => original),
    ).toEqual(source.map(({ publishedSeq: _seq, publishedAt: _at, ...original }) => original));
    expect(complete.slice(0, 500)).toEqual(first.slice(0, 500));

    queries.length = 0;
    await feed.relay();
    expect(publicationCommands(queries)).toHaveLength(2);
    expect(updates(queries)).toHaveLength(0);
    expect((await rows()).filter(({ id }) => id !== anchor.id)).toEqual(complete);
  });

  it('serializes two real concurrent relays into unique contiguous publication slots', async () => {
    const initialHead = BigInt(await head());
    const source = await pending(700);
    const second = new StatsChangesService(db as PrismaService, new ConfigService());
    const outcomes = await Promise.allSettled([feed.relay(), second.relay()]);
    expect(outcomes.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    const published = await rows();
    expect(published.map(({ id }) => id)).toEqual(source.map(({ id }) => id));
    expect(published.map(({ publishedSeq }) => publishedSeq)).toEqual(
      source.map((_, index) => initialHead + BigInt(index) + 1n),
    );
    expect(new Set(published.map(({ publishedSeq }) => publishedSeq)).size).toBe(700);
  });

  it('reads the committed new head after actually waiting for the preceding advisory owner', async () => {
    const initialHead = BigInt(await head());
    const [predecessor, successor] = await pending(2);
    await raw.query('BEGIN');
    await raw.query('SELECT pg_advisory_xact_lock(763429014)');
    const waiting = feed.relay();
    // FLAG: Attach rejection handling while the independent observer establishes a real wait.
    void waiting.catch(() => undefined);
    try {
      let observedWait = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        await raw.query('SELECT pg_stat_clear_snapshot()');
        const result = await raw.query<{ waiting: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.locktype='advisory' AND l.objid=763429014 AND NOT l.granted
              AND a.application_name=$1 AND a.wait_event='advisory'
          ) AS waiting`,
          [applicationName],
        );
        if (result.rows[0]!.waiting) {
          observedWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedWait).toBe(true);
      await raw.query(
        'UPDATE stats_changes SET published_seq=$2::bigint,published_at=now() WHERE id=$1::uuid',
        [predecessor!.id, (initialHead + 1n).toString()],
      );
      await raw.query('COMMIT');
      await waiting;
      const published = await rows();
      expect(published.find(({ id }) => id === predecessor!.id)!.publishedSeq).toBe(
        initialHead + 1n,
      );
      expect(published.find(({ id }) => id === successor!.id)!.publishedSeq).toBe(initialHead + 2n);
    } finally {
      await raw.query('ROLLBACK');
      await waiting.catch(() => undefined);
    }
  });

  it('does not publish an uncommitted source insert and publishes it after commit', async () => {
    const initialHead = BigInt(await head());
    const [visible] = await pending(1);
    const hiddenId = randomUUID();
    await raw.query('BEGIN');
    await raw.query(
      `INSERT INTO stats_changes(id,entity_id,entity_revision,cause,created_at)
       VALUES($1::uuid,$2::uuid,44,'DATA',now()-interval '2 hours')`,
      [hiddenId, entityId],
    );
    await feed.relay();
    expect((await rows()).map(({ id }) => id)).toEqual([visible!.id]);
    expect(
      (await raw.query('SELECT published_seq FROM stats_changes WHERE id=$1::uuid', [hiddenId]))
        .rows,
    ).toEqual([{ published_seq: null }]);
    await raw.query('COMMIT');
    await feed.relay();
    const published = await rows();
    expect(published.find(({ id }) => id === visible!.id)!.publishedSeq).toBe(initialHead + 1n);
    expect(published.find(({ id }) => id === hiddenId)!.publishedSeq).toBe(initialHead + 2n);
  });

  it('skips a locked pending row and makes progress on it after its owner releases it', async () => {
    const initialHead = BigInt(await head());
    const [locked, independent] = await pending(2);
    await raw.query('BEGIN');
    await raw.query('SELECT id FROM stats_changes WHERE id=$1::uuid FOR UPDATE', [locked!.id]);
    await feed.relay();
    let published = await rows();
    expect(published.find(({ id }) => id === locked!.id)!.publishedSeq).toBeNull();
    expect(published.find(({ id }) => id === independent!.id)!.publishedSeq).toBe(initialHead + 1n);
    await raw.query('COMMIT');
    await feed.relay();
    published = await rows();
    expect(published.find(({ id }) => id === locked!.id)!.publishedSeq).toBe(initialHead + 2n);
  });

  it('publishes the final valid int64 slot exactly', async () => {
    const anchor = await seedHead(maxInt64 - 1n);
    const [target] = (await pending(1)).filter(({ id }) => id !== anchor.id);
    await feed.relay();
    expect((await rows()).find(({ id }) => id === target!.id)!.publishedSeq).toBe(maxInt64);
  });

  it('rolls back the whole party when a later assigned slot would overflow int64', async () => {
    const anchor = await seedHead(maxInt64 - 1n);
    const source = (await pending(2)).filter(({ id }) => id !== anchor.id);
    await expect(feed.relay()).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'ValueOutOfRange' } } },
    });
    expect((await rows()).filter(({ id }) => id !== anchor.id)).toEqual(source);
    expect(BigInt(await head())).toBe(maxInt64 - 1n);
  });

  it('uses bounded candidate, head and target index work beside 50,000 retained rows', async () => {
    const initialHead = BigInt(await head());
    await raw.query(
      `INSERT INTO stats_changes(entity_id,entity_revision,cause,created_at,published_seq,published_at)
       SELECT $1::uuid,g,'DATA',now()-interval '3 days'+(g%10)*interval '1 millisecond',
         $2::bigint+g,now()
       FROM generate_series(1,50000) g`,
      [entityId, initialHead.toString()],
    );
    const source = (await pending(5_000)).filter(({ publishedSeq }) => publishedSeq === null);
    await raw.query('ANALYZE stats_changes');
    queries.length = 0;
    await feed.relay();
    const captured = [...queries];
    const candidate = captured.find(({ query }) => /SELECT id,ctid/iu.test(query))!;
    const publishedHead = captured.find(({ query }) => /SELECT COALESCE/iu.test(query))!;
    expect(updates(captured)).toHaveLength(1);
    const update = updates(captured)[0]!;
    expect(candidate).toBeDefined();
    expect(publishedHead).toBeDefined();

    // FLAG: Only this disposable fixture is reset; EXPLAIN ANALYZE UPDATE runs under
    // an explicit rollback, never against production or another test's source rows.
    await raw.query(
      'UPDATE stats_changes SET published_seq=NULL,published_at=NULL WHERE entity_id=$1::uuid AND id=ANY($2::uuid[])',
      [entityId, source.map(({ id }) => id)],
    );
    await raw.query('ANALYZE stats_changes');
    await raw.query('BEGIN');
    try {
      const candidatePlan = await explain(candidate);
      expect(planWork(candidatePlan)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 'stats_changes_unpublished_idx' }),
        ]),
      );
      const candidateScans = candidatePlan.filter(
        (node) => node['Relation Name'] === 'stats_changes',
      );
      expect(candidateScans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      expect(visits(candidateScans)).toBeLessThanOrEqual(500);

      const headPlan = await explain(publishedHead);
      expect(
        headPlan.some((node) => node['Index Name'] === 'stats_changes_published_seq_key'),
      ).toBe(true);
      expect(
        visits(headPlan.filter((node) => node['Relation Name'] === 'stats_changes')),
      ).toBeLessThanOrEqual(1);

      // FLAG: The fixture reset created new tuple versions. Rebind only physical
      // addresses by exact UUID before replaying the captured SQL in this transaction.
      const currentTuples = await raw.query<{ id: string; tuple_id: string }>(
        'SELECT id,ctid::text AS tuple_id FROM stats_changes WHERE entity_id=$1::uuid AND id=ANY($2::uuid[])',
        [entityId, source.map(({ id }) => id)],
      );
      const byId = new Map(currentTuples.rows.map((row) => [row.id, row.tuple_id]));
      const rebound: unknown[] = JSON.parse(update.params);
      const tupleSlots = [...update.query.matchAll(/\$(\d+)::uuid,\s*\$(\d+)::tid/gu)];
      expect(tupleSlots).toHaveLength(500);
      for (const [, idSlot, tupleSlot] of tupleSlots) {
        const id = rebound[Number(idSlot) - 1];
        expect(typeof id).toBe('string');
        const tuple = byId.get(id as string);
        expect(tuple).toBeDefined();
        rebound[Number(tupleSlot) - 1] = tuple;
      }
      const targetPlan = await explain({ ...update, params: JSON.stringify(rebound) });
      expect(planWork(targetPlan)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'Tid Scan',
            relation: 'stats_changes',
            rows: 500,
            loops: 1,
          }),
        ]),
      );
      const targetScans = targetPlan.filter(
        (node) => node['Relation Name'] === 'stats_changes' && /Scan$/u.test(node['Node Type']),
      );
      expect(targetScans.length).toBeGreaterThan(0);
      expect(targetScans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
      expect(visits(targetScans)).toBeLessThanOrEqual(500);
    } finally {
      await raw.query('ROLLBACK');
    }
    expect(await db.statsChange.count({ where: { entityId, publishedSeq: null } })).toBe(5_000);
  }, 30_000);
});
