import { Client, Pool, type PoolClient } from 'pg';
import { ConnectionAdmissionPool } from './connection-admission-pool';
import { connectionAdmissionMetrics } from './connection-admission-metrics';

type PgConnectCallback = Parameters<Pool['connect']>[0];
type PgRelease = Parameters<PgConnectCallback>[2];

function stubConnect(respond: (callback: PgConnectCallback) => void) {
  return jest.spyOn(Pool.prototype, 'connect').mockImplementation(((
    callback?: PgConnectCallback,
  ) => {
    if (!callback) throw new Error('Expected the pg callback overload');
    respond(callback);
  }) as Pool['connect']);
}

describe('PostgreSQL admission callback contract', () => {
  let pool: ConnectionAdmissionPool;

  beforeEach(() => {
    pool = new ConnectionAdmissionPool();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await pool.end();
  });

  it('preserves synchronous throw identity for callbacks and Promise rejection', async () => {
    const original = new Error('synchronous pg failure');
    stubConnect(() => {
      throw original;
    });
    const before = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    const callback = jest.fn<void, Parameters<PgConnectCallback>>();
    let caught: unknown;
    try {
      pool.connect(callback);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(callback).not.toHaveBeenCalled();
    await expect(pool.connect()).rejects.toBe(original);
    const after = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    expect(after.calls - before.calls).toBe(2);
    expect(after.errors - before.errors).toBe(2);
  });

  it('records missing clients as failures while preserving the original callback arguments', async () => {
    const release = jest.fn<ReturnType<PgRelease>, Parameters<PgRelease>>();
    stubConnect((callback) => callback(undefined, undefined, release));
    const before = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    const callback = jest.fn<void, Parameters<PgConnectCallback>>();
    expect(pool.connect(callback)).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(undefined, undefined, release);
    await expect(pool.connect()).rejects.toThrow('PostgreSQL admission returned no connection');
    expect(release).not.toHaveBeenCalled();
    const after = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    expect(after.calls - before.calls).toBe(2);
    expect(after.errors - before.errors).toBe(2);
  });

  it('hands off the exact client and release callback once without wrapping release', () => {
    const release = jest.fn<ReturnType<PgRelease>, Parameters<PgRelease>>();
    const client: PoolClient = Object.assign(new Client(), { release });
    stubConnect((callback) => callback(undefined, client, release));
    const before = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    const callback = jest.fn<void, Parameters<PgConnectCallback>>();
    expect(pool.connect(callback)).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(undefined, client, release);
    expect(release).not.toHaveBeenCalled();
    callback.mock.calls[0]![2]();
    expect(release).toHaveBeenCalledTimes(1);
    const after = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    expect(after.calls - before.calls).toBe(1);
    expect(after.errors - before.errors).toBe(0);
  });

  it('does not count a caller callback exception as a second or failed admission', () => {
    const release = jest.fn<ReturnType<PgRelease>, Parameters<PgRelease>>();
    const client: PoolClient = Object.assign(new Client(), { release });
    stubConnect((callback) => callback(undefined, client, release));
    const before = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    const original = new Error('caller callback failure');
    let caught: unknown;
    try {
      pool.connect(() => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(release).not.toHaveBeenCalled();
    const after = connectionAdmissionMetrics.snapshot().lanes.ordinary;
    expect(after.calls - before.calls).toBe(1);
    expect(after.errors - before.errors).toBe(0);
  });
});
