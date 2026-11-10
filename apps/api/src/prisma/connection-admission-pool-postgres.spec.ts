import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConnectionAdmissionPool } from './connection-admission-pool';
import { withConnectionAdmissionBudget } from './connection-admission-budget';
import { connectionAdmissionMetrics } from './connection-admission-metrics';
import { PrismaClient, createPrismaAdapter, createPrismaClient } from './prisma-client';
import type { PrismaService } from './prisma.service';
import { StatsReadBudget, statsReadTransaction } from '../statistics/stats-read-budget';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describeStores = databaseUrl ? describe : describe.skip;
// Cold transport setup is not the queue-wait behavior exercised by the short-timeout tests.
const lifecyclePoolConfig = { max: 1, connectionTimeoutMillis: 5_000 };
type AdmissionSnapshot = ReturnType<typeof connectionAdmissionMetrics.snapshot>;
type AdmissionCounter = keyof AdmissionSnapshot['counters'];

async function occupyWarmPool(pool: Pool, queueTimeoutMs: number): Promise<PoolClient> {
  const occupied = await pool.connect();
  pool.options.connectionTimeoutMillis = queueTimeoutMs;
  return occupied;
}

function expectAdmissionDelta(
  before: AdmissionSnapshot,
  lane: 'ordinary' | 'budgeted',
  calls: number,
  errors: number,
  counters: Partial<Record<AdmissionCounter, number>> = {},
): void {
  const after = connectionAdmissionMetrics.snapshot();
  expect(after.lanes[lane].calls - before.lanes[lane].calls).toBe(calls);
  expect(after.lanes[lane].errors - before.lanes[lane].errors).toBe(errors);
  const other = lane === 'ordinary' ? 'budgeted' : 'ordinary';
  expect(after.lanes[other].calls - before.lanes[other].calls).toBe(0);
  expect(after.lanes[other].errors - before.lanes[other].errors).toBe(0);
  for (const counter of Object.keys(before.counters) as AdmissionCounter[]) {
    expect(after.counters[counter] - before.counters[counter]).toBe(counters[counter] ?? 0);
  }
}

async function waitForIdlePool(pool: Pool): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pool.waitingCount !== 0 || pool.idleCount !== 1) {
    if (Date.now() >= deadline)
      throw new Error('Late PostgreSQL admission did not release its client');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describeStores('PostgreSQL connection admission under an occupied pool', () => {
  let verifier: Pool;
  const table = `admission_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Connection admission tests require disposable local stores');
    verifier = new Pool({ connectionString: databaseUrl, max: 1 });
    await verifier.query(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
    await verifier.query(`CREATE SEQUENCE ${table}_attempts`);
  });
  afterAll(async () => {
    if (!verifier) return;
    await verifier.query(`DROP TABLE IF EXISTS ${table}`);
    await verifier.query(`DROP SEQUENCE IF EXISTS ${table}_attempts`);
    await verifier.end();
  });

  it('reproduces the original pg-pool timeout before SQL runs', async () => {
    const pool = new Pool({ connectionString: databaseUrl, ...lifecyclePoolConfig });
    const occupied = await occupyWarmPool(pool, 60);
    try {
      await expect(pool.query(`INSERT INTO ${table} VALUES ('original')`)).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      expect((await verifier.query(`SELECT id FROM ${table} WHERE id = 'original'`)).rows).toEqual(
        [],
      );
    } finally {
      occupied.release();
      await pool.end();
    }
  });

  it('admits one write after the first queue wait expires, without repeating SQL', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 80);
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        occupied.release();
      }
    };
    const before = connectionAdmissionMetrics.snapshot();
    const release = setTimeout(releaseOnce, 120);
    try {
      await pool.query(`INSERT INTO ${table} VALUES ('recovered')`);
      expect((await verifier.query(`SELECT id FROM ${table} WHERE id = 'recovered'`)).rows).toEqual(
        [{ id: 'recovered' }],
      );
      expect(pool.totalCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
      expectAdmissionDelta(before, 'ordinary', 1, 0, { retryTimeouts: 1 });
    } finally {
      clearTimeout(release);
      releaseOnce();
      await pool.end();
    }
  });

  it('preserves the callback connect API and releases the connection once', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 80);
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        occupied.release();
      }
    };
    const before = connectionAdmissionMetrics.snapshot();
    const timer = setTimeout(releaseOnce, 120);
    let callbacks = 0;
    try {
      const client = await new Promise<PoolClient>((resolve, reject) =>
        pool.connect((error, connection) => {
          callbacks++;
          if (error) reject(error);
          else resolve(connection!);
        }),
      );
      expect((await client.query('SELECT 7 AS value')).rows[0]).toEqual({ value: 7 });
      client.release();
      expect(callbacks).toBe(1);
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
      expectAdmissionDelta(before, 'ordinary', 1, 0, { retryTimeouts: 1 });
    } finally {
      clearTimeout(timer);
      releaseOnce();
      await pool.end();
    }
  });

  it('stops after two bounded waits and leaves no abandoned waiter', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 60);
    const before = connectionAdmissionMetrics.snapshot();
    const started = Date.now();
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(110);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(pool.waitingCount).toBe(0);
      expectAdmissionDelta(before, 'ordinary', 1, 1, { retryTimeouts: 1 });
    } finally {
      occupied.release();
      await pool.query('SELECT 1');
      expect(pool.totalCount).toBe(1);
      await pool.end();
    }
  });

  it('never retries a dispatched query even when its error matches the admission text', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    try {
      await pool.query('SELECT 1');
      const before = connectionAdmissionMetrics.snapshot();
      await expect(
        pool.query(`DO $$ BEGIN
        PERFORM nextval('${table}_attempts');
        RAISE EXCEPTION 'timeout exceeded when trying to connect';
      END $$`),
      ).rejects.toThrow('timeout exceeded when trying to connect');
      expect(
        (await verifier.query(`SELECT last_value FROM ${table}_attempts`)).rows[0].last_value,
      ).toBe('1');
      expectAdmissionDelta(before, 'ordinary', 1, 0);
    } finally {
      await pool.end();
    }
  });

  it('does not start another admission after pool shutdown begins', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 60);
    const before = connectionAdmissionMetrics.snapshot();
    const pending = expect(pool.query('SELECT 1')).rejects.toThrow(
      'timeout exceeded when trying to connect',
    );
    const ended = pool.end();
    try {
      await pending;
      expect(pool.waitingCount).toBe(0);
      expectAdmissionDelta(before, 'ordinary', 1, 1);
    } finally {
      occupied.release();
      await ended;
    }
    expect(pool.ended).toBe(true);
  });

  it('executes SQL once when the observation clock is unavailable', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    try {
      await pool.query('SELECT 1');
      const before = connectionAdmissionMetrics.snapshot();
      const clock = jest.spyOn(performance, 'now').mockReturnValue(NaN);
      try {
        await pool.query(`INSERT INTO ${table} VALUES ('unknown-clock')`);
      } finally {
        clock.mockRestore();
      }
      expectAdmissionDelta(before, 'ordinary', 1, 0);
      expect(connectionAdmissionMetrics.snapshot().lanes.ordinary.unknownClock).toBe(
        before.lanes.ordinary.unknownClock + 1,
      );
      expect(
        (await verifier.query(`SELECT id FROM ${table} WHERE id = 'unknown-clock'`)).rows,
      ).toEqual([{ id: 'unknown-clock' }]);
    } finally {
      await pool.end();
    }
  });

  it('does not replay a Prisma transaction after a dispatched SQL failure', async () => {
    const prisma = createPrismaClient(databaseUrl, lifecyclePoolConfig);
    let attempts = 0;
    try {
      await prisma.$queryRaw`SELECT 1`;
      const before = connectionAdmissionMetrics.snapshot();
      await expect(
        prisma.$transaction(async (tx) => {
          attempts++;
          await tx.$executeRawUnsafe(`INSERT INTO ${table} VALUES ('rolled-back')`);
          await tx.$executeRawUnsafe(`DO $$ BEGIN
            RAISE EXCEPTION 'timeout exceeded when trying to connect';
          END $$`);
        }),
      ).rejects.toThrow('timeout exceeded when trying to connect');
      expect(attempts).toBe(1);
      expect(
        (await verifier.query(`SELECT id FROM ${table} WHERE id = 'rolled-back'`)).rows,
      ).toEqual([]);
      expectAdmissionDelta(before, 'ordinary', 1, 0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it.each(['expired', 'aborted'] as const)(
    'refuses an already %s budget without adding a waiter or issuing SQL',
    async (reason) => {
      const pool = new ConnectionAdmissionPool({
        connectionString: databaseUrl,
        ...lifecyclePoolConfig,
      });
      try {
        await pool.query('SELECT 1');
        const controller = new AbortController();
        const budget = StatsReadBudget.start(reason === 'expired' ? -1 : 5_000, controller.signal);
        if (reason === 'aborted') controller.abort();
        const before = connectionAdmissionMetrics.snapshot();
        await expect(
          withConnectionAdmissionBudget(budget, () =>
            pool.query(`INSERT INTO ${table} VALUES ($1)`, [`before-${reason}`]),
          ),
        ).rejects.toThrow();
        expect(pool.waitingCount).toBe(0);
        expect(pool.idleCount).toBe(1);
        expectAdmissionDelta(before, 'budgeted', 1, 1, { budgetRejectedBefore: 1 });
        expect(
          (await verifier.query(`SELECT id FROM ${table} WHERE id = $1`, [`before-${reason}`]))
            .rows,
        ).toEqual([]);
      } finally {
        await pool.end();
      }
    },
  );

  it('keeps sixteen budgeted waiters and rejects the seventeenth without running its SQL', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 5_000);
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        occupied.release();
      }
    };
    const before = connectionAdmissionMetrics.snapshot();
    const pending = Array.from({ length: 16 }, (_, index) =>
      withConnectionAdmissionBudget(StatsReadBudget.start(5_000), () =>
        pool.query(`INSERT INTO ${table} VALUES ($1)`, [`bounded-${index}`]),
      ).then(
        () => true,
        () => false,
      ),
    );
    try {
      expect(pool.waitingCount).toBe(16);
      expect(connectionAdmissionMetrics.snapshot().gauges?.budgetedInFlight).toBe(
        before.gauges!.budgetedInFlight + 16,
      );
      await expect(
        withConnectionAdmissionBudget(StatsReadBudget.start(5_000), () =>
          pool.query(`INSERT INTO ${table} VALUES ('bounded-rejected')`),
        ),
      ).rejects.toThrow('Read admission capacity exhausted');
      expect(pool.waitingCount).toBe(16);
      releaseOnce();
      expect(await Promise.all(pending)).toEqual(Array<boolean>(16).fill(true));
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
      expectAdmissionDelta(before, 'budgeted', 17, 1, { capacityRejected: 1 });
      expect(
        (
          await verifier.query(
            `SELECT count(*)::int AS count FROM ${table} WHERE id LIKE 'bounded-%'`,
          )
        ).rows,
      ).toEqual([{ count: 16 }]);
      expect(
        (await verifier.query(`SELECT id FROM ${table} WHERE id = 'bounded-rejected'`)).rows,
      ).toEqual([]);
    } finally {
      releaseOnce();
      await Promise.all(pending);
      await pool.end();
    }
  });

  it('uses only one queue wait for a budgeted timeout and never dispatches its SQL', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const occupied = await occupyWarmPool(pool, 60);
    const before = connectionAdmissionMetrics.snapshot();
    try {
      await expect(
        withConnectionAdmissionBudget(StatsReadBudget.start(5_000), () =>
          pool.query(`INSERT INTO ${table} VALUES ('budget-timeout')`),
        ),
      ).rejects.toThrow('timeout exceeded when trying to connect');
      expect(pool.waitingCount).toBe(0);
      expectAdmissionDelta(before, 'budgeted', 1, 1);
      expect(
        (await verifier.query(`SELECT id FROM ${table} WHERE id = 'budget-timeout'`)).rows,
      ).toEqual([]);
    } finally {
      occupied.release();
      await pool.end();
    }
  });

  it.each(['expired', 'aborted'] as const)(
    'releases a connection acquired after its budget is %s without handing it to SQL',
    async (reason) => {
      const pool = new ConnectionAdmissionPool({
        connectionString: databaseUrl,
        ...lifecyclePoolConfig,
      });
      const occupied = await occupyWarmPool(pool, 500);
      const query = jest.spyOn(occupied, 'query');
      const controller = new AbortController();
      const budget = StatsReadBudget.start(reason === 'expired' ? 15 : 5_000, controller.signal);
      const before = connectionAdmissionMetrics.snapshot();
      const settled = withConnectionAdmissionBudget(budget, () =>
        pool.query(`INSERT INTO ${table} VALUES ($1)`, [`late-${reason}`]),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let released = false;
      try {
        expect(pool.waitingCount).toBe(1);
        if (reason === 'expired') await new Promise((resolve) => setTimeout(resolve, 30));
        else controller.abort();
        occupied.release();
        released = true;
        expect(await settled).toBeInstanceOf(Error);
        expect(pool.waitingCount).toBe(0);
        expect(pool.idleCount).toBe(1);
        expect(query).not.toHaveBeenCalled();
        expectAdmissionDelta(before, 'budgeted', 1, 1, {
          budgetRejectedAfter: 1,
          lateReleases: 1,
        });
        expect(
          (await verifier.query(`SELECT id FROM ${table} WHERE id = $1`, [`late-${reason}`])).rows,
        ).toEqual([]);
        query.mockRestore();
        expect((await pool.query('SELECT 11 AS healthy')).rows).toEqual([{ healthy: 11 }]);
      } finally {
        query.mockRestore();
        if (!released) occupied.release();
        await settled;
        await pool.end();
      }
    },
  );

  it('aggregates two actual pools while reporting occupied and budgeted admission pressure', async () => {
    const baseline = connectionAdmissionMetrics.snapshot().gauges;
    expect(baseline).not.toBeNull();
    const first = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const second = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
      max: 2,
    });
    let occupied: PoolClient | undefined;
    let pending: Promise<unknown[] | null> | undefined;
    try {
      occupied = await first.connect();
      await second.query('SELECT 1');
      const before = connectionAdmissionMetrics.snapshot();
      pending = withConnectionAdmissionBudget(StatsReadBudget.start(5_000), () =>
        first.query('SELECT 33 AS healthy'),
      ).then(
        (result) => result.rows,
        () => null,
      );
      expect(connectionAdmissionMetrics.snapshot().gauges).toMatchObject({
        pools: baseline!.pools + 2,
        capacity: baseline!.capacity + 3,
        total: baseline!.total + 2,
        idle: baseline!.idle + 1,
        waiting: baseline!.waiting + 1,
        budgetedInFlight: baseline!.budgetedInFlight + 1,
      });
      occupied.release();
      occupied = undefined;
      expect(await pending).toEqual([{ healthy: 33 }]);
      expectAdmissionDelta(before, 'budgeted', 1, 0);
    } finally {
      occupied?.release();
      await pending;
      await Promise.all([first.end(), second.end()]);
    }
    expect(connectionAdmissionMetrics.snapshot().gauges).toEqual(baseline);
  });

  it('never issues a late BEGIN after real Prisma maxWait expires in a saturated pool', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    const client = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
    let occupied: PoolClient | undefined;
    try {
      await client.$queryRaw`SELECT 1`;
      occupied = await occupyWarmPool(pool, 500);
      const query = jest.spyOn(occupied, 'query');
      const before = connectionAdmissionMetrics.snapshot();
      let transactionCallbacks = 0;
      try {
        await expect(
          statsReadTransaction(client as PrismaService, StatsReadBudget.start(90), async (tx) => {
            transactionCallbacks++;
            await tx.$executeRawUnsafe(`INSERT INTO ${table} VALUES ('late-prisma')`);
          }),
        ).rejects.toThrow();
        expect(transactionCallbacks).toBe(0);
        expect(pool.waitingCount).toBe(1);
        occupied.release();
        occupied = undefined;
        await waitForIdlePool(pool);
        expect(query).not.toHaveBeenCalled();
        expectAdmissionDelta(before, 'budgeted', 1, 1, {
          budgetRejectedAfter: 1,
          lateReleases: 1,
        });
        expect(
          (await verifier.query(`SELECT id FROM ${table} WHERE id = 'late-prisma'`)).rows,
        ).toEqual([]);
      } finally {
        query.mockRestore();
      }
      expect(await client.$queryRaw`SELECT 92 AS healthy`).toEqual([{ healthy: 92 }]);
    } finally {
      occupied?.release();
      await client.$disconnect();
    }
  });

  it('owns a new bounded pool after adapter disposal and Prisma reconnect', async () => {
    const before = connectionAdmissionMetrics.snapshot().gauges;
    expect(before).not.toBeNull();
    const factory = createPrismaAdapter(databaseUrl, lifecyclePoolConfig);
    const first = await factory.connect();
    const firstPool = first.underlyingDriver() as Pool;
    try {
      expect(firstPool).toBeInstanceOf(ConnectionAdmissionPool);
      expect(firstPool.options).toMatchObject(lifecyclePoolConfig);
      await firstPool.query('SELECT 1');
      expect(connectionAdmissionMetrics.snapshot().gauges?.pools).toBe(before!.pools + 1);
    } finally {
      await first.dispose();
    }
    expect(firstPool.ended).toBe(true);
    expect(connectionAdmissionMetrics.snapshot().gauges?.pools).toBe(before!.pools);
    const second = await factory.connect();
    const secondPool = second.underlyingDriver() as Pool;
    try {
      expect(secondPool).not.toBe(firstPool);
      expect(secondPool).toBeInstanceOf(ConnectionAdmissionPool);
      expect(secondPool.options).toMatchObject(lifecyclePoolConfig);
      await secondPool.query('SELECT 1');
      expect(connectionAdmissionMetrics.snapshot().gauges?.pools).toBe(before!.pools + 1);
    } finally {
      await second.dispose();
    }
    expect(secondPool.ended).toBe(true);
    expect(connectionAdmissionMetrics.snapshot().gauges?.pools).toBe(before!.pools);

    const prisma = createPrismaClient(databaseUrl, lifecyclePoolConfig);
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.$disconnect();
      await prisma.$queryRaw`SELECT 1`;
    } finally {
      await prisma.$disconnect();
    }
    expect(connectionAdmissionMetrics.snapshot().gauges?.pools).toBe(before!.pools);
  });
});
