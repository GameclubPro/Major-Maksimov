import type pg from 'pg';

export const ERASER_RATE_LIMIT_READER_VERSION = 1;

export interface RateLimitStore {
  remainingMs(referenceMs?: number): Promise<number>;
  extend(until: Date | number): Promise<void>;
}

export class DurableRateLimit implements RateLimitStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly botId: string,
  ) {}

  async remainingMs(referenceMs = Date.now()): Promise<number> {
    const result = await this.pool.query<{ not_before: Date }>(
      `SELECT not_before FROM eraser_rate_limits WHERE bot_id=$1 AND not_before>clock_timestamp()`,
      [this.botId],
    );
    return Math.max(0, (result.rows[0]?.not_before.getTime() ?? 0) - referenceMs);
  }

  async extend(until: Date | number): Promise<void> {
    const deadline = until instanceof Date ? until : new Date(Date.now() + until);
    if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= 0)
      throw new Error('Invalid cooldown deadline');
    // FLAG: A Redis outage or restart cannot erase a received token-wide Retry-After.
    await this.pool.query(
      `INSERT INTO eraser_rate_limits(bot_id,not_before)
       VALUES($1,$2::timestamptz)
       ON CONFLICT(bot_id) DO UPDATE SET not_before=GREATEST(eraser_rate_limits.not_before,EXCLUDED.not_before)`,
      [this.botId, deadline],
    );
  }
}
