import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  safetyDeskOverviewResponseSchema,
  safetyDeskOverviewHistoryPointSchema,
  type SafetyDeskOverviewResponse,
  type SafetyDeskOverviewHistoryPoint,
} from '@maxim/contracts/safety-desk';

export const OVERVIEW_SNAPSHOT_KEY = 'safety-desk:overview:v1:snapshot';
export const OVERVIEW_HISTORY_KEY = 'safety-desk:overview:v1:history';
export const OVERVIEW_HISTORY_TTL_SEC = 86400;
export const OVERVIEW_HISTORY_POINTS = 1440;
export class OverviewInvalidEvidenceError extends Error {}
export const WRITE_OVERVIEW_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, value = pcall(cjson.decode, existing)
  if ok and type(value.generatedAt) == 'string' and value.generatedAt > ARGV[2] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], ARGV[3], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. tostring(tonumber(ARGV[3]) - 86400000 + 60000))
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -1441)
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1
`;

export async function writeOverview(
  redis: Pick<Redis, 'eval'>,
  snapshot: SafetyDeskOverviewResponse,
  point: SafetyDeskOverviewHistoryPoint,
): Promise<void> {
  const parsed = safetyDeskOverviewResponseSchema.parse(snapshot);
  const history = safetyDeskOverviewHistoryPointSchema.parse(point);
  const minute = Math.floor(Date.parse(parsed.generatedAt) / 60000) * 60000;
  if (Date.parse(history.at) !== minute) throw new Error('Invalid overview history bucket');
  await redis.eval(
    WRITE_OVERVIEW_LUA,
    2,
    OVERVIEW_SNAPSHOT_KEY,
    OVERVIEW_HISTORY_KEY,
    JSON.stringify(parsed),
    parsed.generatedAt,
    String(minute),
    JSON.stringify(history),
    String(OVERVIEW_HISTORY_TTL_SEC),
  );
}

@Injectable()
export class SafetyDeskOverviewStore implements OnModuleDestroy {
  private redis: Redis | null = null;
  private connecting: Promise<Redis> | null = null;
  private stopped = false;
  constructor(private readonly config: ConfigService) {}

  async connection(): Promise<Redis> {
    if (this.stopped) throw new Error('Overview store stopped');
    if (this.redis?.status === 'ready') return this.redis;
    if (this.connecting) return this.connecting;
    const request = (async () => {
      this.closeConnection();
      const redis = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        commandTimeout: 1500,
        connectTimeout: 1500,
        retryStrategy: () => null,
      });
      redis.on('error', () => {
        /* Connection failure is projected as unavailable evidence. */
      });
      this.redis = redis;
      await redis.connect();
      if (this.stopped) {
        redis.disconnect();
        throw new Error('Overview store stopped');
      }
      return redis;
    })();
    this.connecting = request;
    const clear = () => {
      if (this.connecting === request) this.connecting = null;
    };
    void request.then(clear, clear);
    return request;
  }
  async write(snapshot: SafetyDeskOverviewResponse, point: SafetyDeskOverviewHistoryPoint) {
    await writeOverview(await this.connection(), snapshot, point);
  }
  invalidate(): void {
    this.closeConnection();
    this.redis = null;
  }
  private closeConnection(): void {
    // FLAG: Disconnecting an already closed ioredis stream creates a new five-second
    // connector timer without a future close event to clear it. Closed clients need no teardown.
    if (this.redis && this.redis.status !== 'end' && this.redis.status !== 'wait')
      this.redis.disconnect();
  }
  async readSnapshot(): Promise<SafetyDeskOverviewResponse | null> {
    const raw = await (await this.connection()).get(OVERVIEW_SNAPSHOT_KEY);
    if (raw === null) return null;
    if (Buffer.byteLength(raw) > 250000)
      throw new OverviewInvalidEvidenceError('Invalid overview snapshot');
    try {
      return safetyDeskOverviewResponseSchema.parse(JSON.parse(raw));
    } catch {
      throw new OverviewInvalidEvidenceError('Invalid overview snapshot');
    }
  }
  async readHistory(now: number): Promise<SafetyDeskOverviewHistoryPoint[]> {
    const minute = Math.floor(now / 60000) * 60000;
    const rows = await (
      await this.connection()
    ).zrangebyscore(
      OVERVIEW_HISTORY_KEY,
      minute - 86400000 + 60000,
      minute,
      'LIMIT',
      0,
      OVERVIEW_HISTORY_POINTS,
    );
    return rows.map((raw) => {
      if (Buffer.byteLength(raw) > 1000)
        throw new OverviewInvalidEvidenceError('Invalid overview history');
      let row: SafetyDeskOverviewHistoryPoint;
      try {
        row = safetyDeskOverviewHistoryPointSchema.parse(JSON.parse(raw));
      } catch {
        throw new OverviewInvalidEvidenceError('Invalid overview history');
      }
      const at = Date.parse(row.at);
      if (at > now || at % 60000 !== 0)
        throw new OverviewInvalidEvidenceError('Invalid overview history clock');
      return row;
    });
  }
  onModuleDestroy(): void {
    this.stopped = true;
    this.closeConnection();
  }
}
