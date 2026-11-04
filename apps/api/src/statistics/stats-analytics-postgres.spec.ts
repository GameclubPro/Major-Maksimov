import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import type {
  StatsAuthorityOperation,
  StatsEntity,
  StatsReadContext,
  StatsReplaceDay,
} from '@maxim/contracts/statistics-central';
import type {
  StatsAnalyticsRequest,
  StatsAnalyticsResult,
} from '@maxim/contracts/statistics-analytics';
import { statsAnalyticsResultSchema } from '@maxim/contracts/statistics-analytics-validation';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { ConnectionAdmissionPool } from '../prisma/connection-admission-pool';
import { withConnectionAdmissionBudget } from '../prisma/connection-admission-budget';
import { StatsAccessService } from './stats-access.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsReadService } from './stats-read.service';
import { StatsAnalyticsService } from './stats-analytics.service';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import { allKeys, DAY_MS } from './stats-common';
import { StatsReadBudget, statsReadTransaction } from './stats-read-budget';
import { decodeCursor, encodeCursor } from './stats-cursor';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const native = databaseUrl ? describe : describe.skip;
type Ready = Extract<StatsAnalyticsResult, { status: 'READY' }>;
function ready(value: StatsAnalyticsResult): Ready {
  expect(statsAnalyticsResultSchema.safeParse(value).success).toBe(true);
  if (!('status' in value)) throw new Error('Expected ready analytics');
  return value;
}

native('analytics native snapshots, authorization, pagination and resource deadlines', () => {
  let db: PrismaClient;
  let verifier: Pool;
  let config: ConfigService;
  let access: StatsAccessService;
  let ingest: StatsIngestService;
  let reader: StatsReadService;
  let service: StatsAnalyticsService;
  let entity: StatsEntity;
  let epoch: string;
  let source: StatsAuthorityOperation;
  let consumer: StatsAuthorityOperation;
  let sourceEpoch: string;
  let context: StatsReadContext;
  const token = 'synthetic-analytics-cursor-test';
  const day = (offset = 0) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, {
        max: 6,
        // FLAG: Fixture setup uses the ordinary pool budget; deadline cases own separate limits.
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        application_name: 'analytics-native-test',
      }),
    });
    verifier = new Pool({ connectionString: databaseUrl, max: 1 });
    await db.$connect();
    await db.$queryRaw`SELECT 1`;
  });
  beforeEach(async () => {
    entity = {
      kind: 'CHANNEL',
      maxId: `-${BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)) + 1n}`,
    };
    epoch = randomUUID();
    config = new ConfigService({
      STATISTICS_CENTRAL_ENABLED: 'true',
      STATISTICS_CENTRAL_MODE: 'CENTRAL',
      STATISTICS_CENTRAL_EXCHANGE_EPOCH: epoch,
      SVYAZKA_ANALYTICS_TOKEN: token,
    });
    access = new StatsAccessService(db as PrismaService, config);
    ingest = new StatsIngestService(db as PrismaService, access);
    reader = new StatsReadService(
      db as PrismaService,
      access,
      new MaximNativeStatsAdapter(db as PrismaService),
      config,
    );
    service = new StatsAnalyticsService(db as PrismaService, reader, config);
    source = {
      id: randomUUID(),
      revision: '1',
      operation: 'ATTEST',
      entity,
      role: 'SOURCE',
      actorMaxUserId: '323459159',
      botRef: 'synthetic-analytics',
      consumer: 'EXCHANGE',
      purpose: 'OWNER_ANALYTICS',
      scopes: allKeys,
      checkedAt: new Date().toISOString(),
      producerEpoch: epoch,
      localAccessFence: 'synthetic-analytics-fence',
    };
    consumer = { ...source, id: randomUUID(), role: 'CONSUMER' };
    const result = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [source, consumer],
    });
    expect(result.results).toMatchObject([
      { id: source.id, status: 'APPLIED', state: 'ACTIVE', epoch: '1', errorCode: null },
      { id: consumer.id, status: 'APPLIED', state: 'ACTIVE', epoch: '1', errorCode: null },
    ]);
    sourceEpoch = result.results[0]!.epoch;
    context = {
      contextId: randomUUID(),
      entity,
      actorMaxUserId: source.actorMaxUserId,
      purpose: source.purpose,
      consumerAuthority: { id: consumer.id, epoch: result.results[1]!.epoch },
    };
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.$executeRaw`DELETE FROM stats_entities WHERE kind=${entity.kind} AND max_id=${entity.maxId}`;
    await db.$executeRaw`DELETE FROM stats_ingest_requests WHERE producer_epoch=${epoch}::uuid`;
  });
  afterAll(async () => {
    await db?.$disconnect();
    await verifier?.end();
  });
  const request = (patch: Partial<StatsAnalyticsRequest> = {}): StatsAnalyticsRequest => ({
    contractVersion: 1,
    analyticsVersion: 1,
    context,
    periodDays: 7,
    metrics: ['AUDIENCE'],
    horizons: [],
    includeComparison: true,
    includeHistory: true,
    cursor: null,
    ...patch,
  });
  const audience = (value: number, offset = 0): StatsReplaceDay => ({
    operation: 'REPLACE_DAY',
    metric: 'AUDIENCE',
    horizon: 0,
    method: { id: 'AUDIENCE_SNAPSHOT', version: 1 },
    day: day(offset),
    sourceRevision: '1',
    authority: { id: source.id, epoch: sourceEpoch },
    value: { value, observedAt: offset ? `${day(offset)}T12:00:00Z` : new Date().toISOString() },
    coverage: { state: 'COMPLETE', intervals: [], populationComplete: true },
  });
  const put = (operations: StatsReplaceDay[]) =>
    ingest.ingest({
      contractVersion: 1,
      requestId: randomUUID(),
      producerEpoch: epoch,
      entity,
      operations,
    });

  it('keeps one asOf and revision across all bounded pages without repeating aggregate reads', async () => {
    await put([audience(5, 80), audience(10, 45), audience(15, 6), audience(20)]);
    const readSpy = jest.spyOn(reader, 'candidatesWithin');
    const query = request({
      periodDays: 90,
      metrics: ['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'],
      horizons: [0, 24, 48],
    });
    const pages: Ready[] = [];
    let cursor: string | null = null;
    do {
      const result = ready(await service.read({ ...query, cursor }, StatsReadBudget.start()));
      pages.push(result);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(524288);
      if (result.history.state !== 'READY') throw new Error('Missing history');
      expect(result.history.rows.length).toBeLessThanOrEqual(256);
      cursor = result.history.nextCursor;
      if (pages.length > 4) throw new Error('Cursor did not converge');
    } while (cursor);
    expect(pages.length).toBe(3);
    expect(pages[0]!.page).toBe('INITIAL');
    const allRows = pages.flatMap((page) =>
      page.history.state === 'READY' ? page.history.rows : [],
    );
    expect(allRows).toHaveLength(540);
    expect(new Set(allRows.map((row) => `${row.day}:${row.metric}:${row.horizon}`)).size).toBe(540);
    expect(allRows.find((row) => row.metric === 'AUDIENCE' && row.day === day(45))).toMatchObject({
      changeFromPrevious: {
        value: null,
        reason: 'GAP_IN_OBSERVATIONS',
        interval: { fromDay: day(80), toDay: day(45) },
      },
    });
    for (const page of pages.slice(1)) {
      expect(page.page).toBe('HISTORY');
      expect(page).not.toHaveProperty('metrics');
      expect(page.asOf).toBe(pages[0]!.asOf);
      expect(page.revision).toEqual(pages[0]!.revision);
      if (page.history.state === 'READY') expect(page.history.publicationBreakdown).toBeNull();
    }
    expect(readSpy).toHaveBeenCalledTimes(5);
    for (const call of readSpy.mock.calls.slice(1))
      expect(Date.parse(call[4]) - Date.parse(call[3])).toBeLessThan(
        (call[2].every((key) => key.metric === 'AUDIENCE') ? 90 : 60) * DAY_MS,
      );
  });

  it('reads audience together with only the requested 48h reach, not recent or 24h metrics', async () => {
    await put([audience(19)]);
    const spy = jest.spyOn(reader, 'candidatesWithin');
    const result = ready(
      await service.read(
        request({ metrics: ['AUDIENCE', 'REACH'], horizons: [48], includeHistory: false }),
        StatsReadBudget.start(),
      ),
    );
    expect(result.page).toBe('INITIAL');
    if (result.page !== 'INITIAL') throw new Error('Expected initial page');
    expect(result.metrics.map((metric) => [metric.metric, metric.horizon])).toEqual([
      ['AUDIENCE', 0],
      ['REACH', 48],
    ]);
    expect(result.metrics[0]!.current).toMatchObject({ state: 'AVAILABLE', value: { value: 19 } });
    const keys = spy.mock.calls[0]![2];
    expect(
      keys.every(
        (key) => key.metric === 'AUDIENCE' || (key.metric === 'REACH' && key.horizon === 48),
      ),
    ).toBe(true);
    expect(result.history).toEqual({ state: 'NOT_REQUESTED' });
  });

  it('rejects forbidden public history before any snapshot or data read', async () => {
    const spy = jest.spyOn(reader, 'prepareWithin');
    await expect(
      service.read(
        request({ context: { ...context, purpose: 'PUBLISHED_AGGREGATE' } }),
        StatsReadBudget.start(),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns public aggregates from their own grants without exposing owner history', async () => {
    await put([audience(10, 6), audience(18)]);
    const publicSource = { ...source, id: randomUUID(), purpose: 'PUBLISHED_AGGREGATE' as const };
    const publicConsumer = {
      ...consumer,
      id: randomUUID(),
      purpose: 'PUBLISHED_AGGREGATE' as const,
    };
    const grants = await access.attest({
      contractVersion: 1,
      requestId: randomUUID(),
      operations: [publicSource, publicConsumer],
    });
    const result = ready(
      await service.read(
        request({
          includeHistory: false,
          context: {
            ...context,
            purpose: 'PUBLISHED_AGGREGATE',
            consumerAuthority: { id: publicConsumer.id, epoch: grants.results[1]!.epoch },
          },
        }),
        StatsReadBudget.start(),
      ),
    );
    expect(result.historyAllowed).toBe(false);
    expect(result.history).toEqual({ state: 'NOT_REQUESTED' });
    if (result.page !== 'INITIAL') throw new Error('Expected initial page');
    expect(result.metrics[0]).toMatchObject({
      current: { state: 'AVAILABLE', value: { value: 18 } },
      growth: { state: 'AVAILABLE', value: { delta: 8 } },
    });
    expect(
      result.access.sourceAuthorityDependencies.every(
        (dependency) => dependency.purpose === 'PUBLISHED_AGGREGATE',
      ),
    ).toBe(true);
  });

  it('rejects a changed data revision or cursor filter rather than combining pages', async () => {
    const query = request({
      periodDays: 90,
      metrics: ['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'],
      horizons: [0, 24, 48],
    });
    const first = ready(await service.read(query, StatsReadBudget.start()));
    if (first.history.state !== 'READY' || !first.history.nextCursor)
      throw new Error('Expected continuation');
    await expect(
      service.read(
        { ...query, cursor: first.history.nextCursor, includeComparison: false },
        StatsReadBudget.start(),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_REQUEST' } } });
    await put([audience(10)]);
    await expect(
      service.read({ ...query, cursor: first.history.nextCursor }, StatsReadBudget.start()),
    ).rejects.toMatchObject({ response: { error: { code: 'READ_RESTART' } } });
  });

  it('rejects malformed retention and expires a valid previous UTC generation without a data revision change', async () => {
    const query = request({
      periodDays: 90,
      metrics: ['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'],
      horizons: [0, 24, 48],
    });
    const first = ready(await service.read(query, StatsReadBudget.start()));
    if (first.history.state !== 'READY' || !first.history.nextCursor)
      throw new Error('Expected continuation');
    const body = decodeCursor<Record<string, unknown>>(first.history.nextCursor, token);
    const cursor = encodeCursor({ ...body, retentionFloor: day(90) }, token);
    await expect(service.read({ ...query, cursor }, StatsReadBudget.start())).rejects.toMatchObject(
      { response: { error: { code: 'INVALID_REQUEST' } } },
    );
    const midnight = Date.parse(`${day()}T00:00:00Z`);
    const expired = encodeCursor(
      {
        ...body,
        retentionFloor: day(90),
        asOf: new Date(midnight - 1000).toISOString(),
        expiresAt: new Date(midnight).toISOString(),
      },
      token,
    );
    await expect(
      service.read({ ...query, cursor: expired }, StatsReadBudget.start()),
    ).rejects.toMatchObject({ response: { error: { code: 'CURSOR_EXPIRED' } } });
  });

  it('does not include a stored publication observation collected after the pinned asOf', async () => {
    const from = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 20_000).toISOString();
    const hours: Array<number | null> = Array(24).fill(null);
    hours[new Date().getUTCHours()] = 17;
    await put([
      {
        operation: 'REPLACE_DAY',
        metric: 'PUBLICATION_HOUR',
        horizon: 0,
        method: { id: 'PUBLICATION_DAY_HOURS', version: 1 },
        day: day(),
        sourceRevision: '1',
        authority: { id: source.id, epoch: sourceEpoch },
        value: { hours, observedFrom: from, observedTo: future },
        coverage: { state: 'PARTIAL', intervals: [], populationComplete: false },
      },
    ]);
    const result = ready(
      await service.read(
        request({ metrics: ['PUBLICATION_HOUR'], includeHistory: false }),
        StatsReadBudget.start(),
      ),
    );
    if (result.page !== 'INITIAL') throw new Error('Expected initial page');
    expect(result.metrics[0]!.current).toMatchObject({ state: 'UNAVAILABLE', reason: 'NO_DATA' });
  });

  it('checks current authority after the snapshot transaction releases its locks', async () => {
    await put([audience(30)]);
    let calls = 0;
    const transaction: PrismaService['$transaction'] = ((
      ...args: Parameters<PrismaService['$transaction']>
    ) =>
      Reflect.apply(db.$transaction, db, args).then(async (result: unknown) => {
        if (calls++ === 0)
          await access.attest({
            contractVersion: 1,
            requestId: randomUUID(),
            operations: [{ ...consumer, operation: 'REVOKE', revision: '2' }],
          });
        return result;
      })) as PrismaService['$transaction'];
    const racing = new StatsAnalyticsService(
      { $transaction: transaction } as PrismaService,
      reader,
      config,
    );
    await expect(racing.read(request(), StatsReadBudget.start())).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    expect(calls).toBe(1);
  });

  it('actually stops PostgreSQL pg_sleep and releases the transaction after its deadline', async () => {
    const started = performance.now();
    await expect(
      statsReadTransaction(db as PrismaService, StatsReadBudget.start(180), async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(2)`;
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
    const active = await verifier.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='analytics-native-test' AND state='active' AND query LIKE '%pg_sleep%' AND pid<>pg_backend_pid()",
    );
    expect(active.rows[0].n).toBe(0);
    expect(await db.$queryRaw`SELECT 7 AS healthy`).toEqual([{ healthy: 7 }]);
  });

  it('does not reset the total deadline for individually short SQL statements', async () => {
    let completed = 0;
    await expect(
      statsReadTransaction(db as PrismaService, StatsReadBudget.start(190), async (tx) => {
        for (let i = 0; i < 5; i++) {
          await tx.$executeRaw`SELECT pg_sleep(0.075)`;
          completed++;
        }
      }),
    ).rejects.toThrow();
    expect(completed).toBeLessThan(3);
  });

  it('does not issue another SQL statement after cancellation of the active read', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    let secondQuery = false;
    try {
      await expect(
        statsReadTransaction(
          db as PrismaService,
          StatsReadBudget.start(250, controller.signal),
          async (tx) => {
            await tx.$executeRaw`SELECT pg_sleep(0.1)`;
            secondQuery = true;
            await tx.$queryRaw`SELECT 1`;
          },
        ),
      ).rejects.toThrow();
      expect(secondQuery).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it('releases an expired pool acquisition without handing it to a caller or retrying', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 70,
    });
    const occupied = await pool.connect();
    const budget = StatsReadBudget.start(15);
    const pending = withConnectionAdmissionBudget(budget, () => pool.connect());
    const rejected = expect(pending).rejects.toThrow();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      occupied.release();
      await rejected;
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
      expect((await pool.query('SELECT 11 AS healthy')).rows).toEqual([{ healthy: 11 }]);
    } finally {
      await pool.end();
    }
  });

  it('never issues a late BEGIN after Prisma maxWait expires in a saturated shared pool', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 500,
    });
    const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
    await client.$queryRaw`SELECT 1`;
    const occupied = await pool.connect();
    const query = jest.spyOn(occupied, 'query');
    let released = false;
    try {
      await expect(
        statsReadTransaction(client as PrismaService, StatsReadBudget.start(90), async (tx) => {
          await tx.$queryRaw`SELECT 91`;
        }),
      ).rejects.toThrow();
      expect(pool.waitingCount).toBe(1);
      occupied.release();
      released = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
      expect(query).not.toHaveBeenCalled();
      query.mockRestore();
      expect(await client.$queryRaw`SELECT 92 AS healthy`).toEqual([{ healthy: 92 }]);
    } finally {
      query.mockRestore();
      if (!released) occupied.release();
      await client.$disconnect();
    }
  });
});
