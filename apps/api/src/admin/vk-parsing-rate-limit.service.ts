import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { readVkRetryAtMs, VK_API_MAX_RETRY_AT_MS, VkApiRequestError } from './vk-parsing-errors';

const VK_API_RATE_LIMIT_SLOT_TTL_MS = 2_000;
const VK_API_METRICS_TTL_SEC = 6 * 60 * 60;
const VK_API_METRICS_MAX_WINDOW_SEC = 900;
export type VkApiAdmissionOptions = {
  credentialScope: string;
  deadlineAtMs: number;
};

const VK_API_RATE_LIMIT_RESERVATION_SCRIPT = `
local ttlMs = tonumber(ARGV[3])
local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cooldownUntil = tonumber(redis.call('GET', KEYS[3]) or '0')
if cooldownUntil == nil or cooldownUntil < 0 or cooldownUntil > ${VK_API_MAX_RETRY_AT_MS} or cooldownUntil ~= math.floor(cooldownUntil) then
  return redis.error_reply('Invalid VK provider cooldown')
end
if cooldownUntil > nowMs then
  return {0, 3, cooldownUntil - nowMs, cooldownUntil}
end

for index = 1, 2 do
  local limit = tonumber(ARGV[index])
  local count = tonumber(redis.call('GET', KEYS[index]) or '0')
  if count >= limit then
    local ttl = redis.call('PTTL', KEYS[index])
    if ttl == nil or ttl < 1 then
      ttl = ttlMs
    end
    return {0, index, ttl, 0}
  end
end

for index = 1, 2 do
  local nextCount = redis.call('INCR', KEYS[index])
  if nextCount == 1 then
    redis.call('PEXPIRE', KEYS[index], ttlMs)
  else
    local ttl = redis.call('PTTL', KEYS[index])
    if ttl == nil or ttl < 1 then
      redis.call('PEXPIRE', KEYS[index], ttlMs)
    end
  end
end

return {1, 0, 0, 0}
`;

const VK_API_PROVIDER_COOLDOWN_SCRIPT = `
local requestedUntil = tonumber(ARGV[1])
local existingUntil = tonumber(redis.call('GET', KEYS[1]) or '0')
if existingUntil == nil or existingUntil < 0 or existingUntil > ${VK_API_MAX_RETRY_AT_MS} or existingUntil ~= math.floor(existingUntil) then
  return redis.error_reply('Invalid VK provider cooldown')
end
local clock = redis.call('TIME')
local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local effectiveUntil = math.max(requestedUntil, existingUntil)
if effectiveUntil <= nowMs then return 0 end
local exactUntil = string.format('%.0f', effectiveUntil)
redis.call('SET', KEYS[1], exactUntil, 'PXAT', exactUntil)
return effectiveUntil
`;

@Injectable()
export class VkParsingRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(VkParsingRateLimitService.name);
  private readonly redis: Redis;
  private readonly rpsLimit: number;
  private readonly maxWaitMs: number;
  private lastMetricFailureLogAtMs = 0;
  private lastCooldownFailureLogAtMs: number | undefined;
  private readonly localProviderCooldowns = new Map<string, number>();

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
      commandTimeout: 1_000,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', (error) => this.logMetricFailure(error));
    this.rpsLimit = this.readPositiveInt(configService.get<number>('VK_API_RPS'), 5);
    this.maxWaitMs = this.readNonNegativeInt(
      configService.get<number>('VK_API_RATE_LIMIT_WAIT_MS'),
      2_000,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async reserveVkApiSlot(method: string, options: VkApiAdmissionOptions): Promise<void> {
    this.assertCredentialScope(options.credentialScope);
    if (readVkRetryAtMs(options.deadlineAtMs) === undefined) {
      throw new Error('Invalid VK API request deadline');
    }
    const startedAtMs = Date.now();
    while (true) {
      this.assertRequestBudget(options.deadlineAtMs);
      const localUntil = this.localProviderCooldowns.get(options.credentialScope) ?? 0;
      if (localUntil <= Date.now()) this.localProviderCooldowns.delete(options.credentialScope);
      let reservation =
        localUntil > Date.now()
          ? {
              ok: false as const,
              reason: 'provider' as const,
              retryAfterMs: localUntil - Date.now(),
              retryAtMs: localUntil,
            }
          : await this.tryReserveVkApiSlot(method, options.credentialScope);
      const newlyObservedUntil = this.localProviderCooldowns.get(options.credentialScope) ?? 0;
      // FLAG: An HTTP response may retain a longer pause while this Redis acknowledgement is pending.
      if (
        newlyObservedUntil > Date.now() &&
        (reservation.ok ||
          reservation.reason === 'quota' ||
          newlyObservedUntil > reservation.retryAtMs)
      ) {
        reservation = {
          ok: false,
          reason: 'provider',
          retryAfterMs: newlyObservedUntil - Date.now(),
          retryAtMs: newlyObservedUntil,
        };
      }
      if (reservation.ok) {
        this.assertRequestBudget(options.deadlineAtMs);
        return;
      }

      const remainingWaitMs = Math.min(
        this.maxWaitMs - (Date.now() - startedAtMs),
        options.deadlineAtMs - Date.now(),
      );
      if (reservation.reason === 'provider') {
        this.rememberProviderCooldown(options.credentialScope, reservation.retryAtMs);
        const delayMs = Math.max(1, reservation.retryAfterMs, reservation.retryAtMs - Date.now());
        if (remainingWaitMs <= 0 || delayMs >= remainingWaitMs) {
          throw new VkApiRequestError(
            'VK API временно ограничил запросы.',
            'provider_cooldown',
            true,
            reservation.retryAtMs,
          );
        }
        await this.sleep(delayMs);
        continue;
      }
      if (remainingWaitMs <= 0) {
        this.assertRequestBudget(options.deadlineAtMs);
        throw new Error(`VK API rate limit exceeded for ${method}`);
      }

      const nextWindowMs = 1_000 - (Date.now() % 1_000);
      await this.sleep(Math.min(reservation.retryAfterMs, nextWindowMs, remainingWaitMs));
    }
  }

  async publishVkApiCooldown(credentialScope: string, retryAtMs: number): Promise<void> {
    this.assertCredentialScope(credentialScope);
    if (readVkRetryAtMs(retryAtMs) === undefined) {
      throw new Error('Invalid VK API provider deadline');
    }
    // FLAG: Keep the originating instance paused even if Redis rejects the write or loses its ACK.
    // Only an acknowledged atomic max-until publication establishes coverage for other instances.
    this.rememberProviderCooldown(credentialScope, retryAtMs);
    try {
      const effectiveUntil = await this.redis.eval(
        VK_API_PROVIDER_COOLDOWN_SCRIPT,
        1,
        this.providerCooldownKey(credentialScope),
        String(retryAtMs),
      );
      if (effectiveUntil === 0 && retryAtMs <= Date.now()) return;
      const acknowledgedUntil = readVkRetryAtMs(effectiveUntil);
      if (acknowledgedUntil === undefined || acknowledgedUntil < retryAtMs) {
        throw new Error('Failed to acknowledge VK API provider cooldown');
      }
      this.rememberProviderCooldown(credentialScope, acknowledgedUntil);
    } catch (error) {
      const nowMs = Date.now();
      if (
        this.lastCooldownFailureLogAtMs === undefined ||
        nowMs - this.lastCooldownFailureLogAtMs >= 10_000
      ) {
        this.lastCooldownFailureLogAtMs = nowMs;
        this.logger.warn(
          { code: 'vk_provider_cooldown_unconfirmed' },
          'VK provider cooldown publication was not acknowledged',
        );
      }
      throw error;
    }
  }

  async recordVkApiOutcome(params: {
    method: string;
    outcome: 'success' | 'error';
    code?: string | number | null;
  }): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const code = this.normalizeMetricPart(String(params.code ?? params.outcome));
    const key = `vkapi:metrics:v2:${nowSec}`;
    try {
      const result = await this.redis
        .multi()
        .hincrby(key, `${params.outcome}:${code}`, 1)
        .expire(key, VK_API_METRICS_TTL_SEC)
        .exec();
      const error = result?.find(([error]) => error)?.[0];
      if (error) throw error;
    } catch (error) {
      this.logMetricFailure(error);
    }
  }

  async getRecentVkApiMetrics(windowSec = 300): Promise<{
    rps: number;
    errorRate: number;
    recentErrors: Array<{ code: string; count: number }>;
  }> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const boundedWindowSec = Number.isFinite(windowSec)
      ? Math.max(1, Math.min(VK_API_METRICS_MAX_WINDOW_SEC, Math.trunc(windowSec)))
      : 300;
    const counts = new Map<string, number>();
    const pipeline = this.redis.pipeline();
    for (let offset = 0; offset < boundedWindowSec; offset += 1) {
      pipeline.hgetall(`vkapi:metrics:v2:${nowSec - offset}`);
    }
    const results = await pipeline.exec();
    if (!results) throw new Error('VK metrics are unavailable');
    for (const [error, values] of results) {
      if (error) throw error;
      if (!values || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) {
        const count = Number(value);
        if (
          !/^(success|error):[a-z0-9_.-]+$/u.test(key) ||
          !Number.isSafeInteger(count) ||
          count <= 0
        )
          continue;
        counts.set(key, (counts.get(key) ?? 0) + count);
      }
    }

    const success = [...counts.entries()].reduce(
      (total, [key, count]) => (key.startsWith('success:') ? total + count : total),
      0,
    );
    const error = [...counts.entries()].reduce(
      (total, [key, count]) => (key.startsWith('error:') ? total + count : total),
      0,
    );
    const total = success + error;
    const recentErrors = [...counts.entries()]
      .filter(([key]) => key.startsWith('error:'))
      .map(([key, count]) => ({ code: key.slice('error:'.length), count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10);

    return {
      rps: total / boundedWindowSec,
      errorRate: total > 0 ? error / total : 0,
      recentErrors,
    };
  }

  private async tryReserveVkApiSlot(
    method: string,
    credentialScope: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'quota'; retryAfterMs: number }
    | { ok: false; reason: 'provider'; retryAfterMs: number; retryAtMs: number }
  > {
    const nowSec = Math.floor(Date.now() / 1_000);
    const methodKey = this.normalizeMetricPart(method) || 'unknown';
    // FLAG: Provider admission is atomic with the two existing shared quotas; cooldown is never a quota slot.
    const keys = [
      `vkapi:rps:global:${nowSec}`,
      `vkapi:rps:method:${methodKey}:${nowSec}`,
      this.providerCooldownKey(credentialScope),
    ];
    const raw = await this.redis.eval(
      VK_API_RATE_LIMIT_RESERVATION_SCRIPT,
      keys.length,
      ...keys,
      String(this.rpsLimit),
      String(this.rpsLimit),
      String(VK_API_RATE_LIMIT_SLOT_TTL_MS),
    );
    const result = Array.isArray(raw) ? raw : null;
    const ok = typeof result?.[0] === 'number' ? result[0] : Number.NaN;
    const retryAfterMs = typeof result?.[2] === 'number' ? result[2] : Number.NaN;

    if (ok === 1) {
      return { ok: true };
    }
    if (ok !== 0) {
      throw new Error('Failed to execute VK API rate limit reservation script');
    }
    if (result?.[1] === 3) {
      const retryAtMs = readVkRetryAtMs(result[3]);
      if (retryAtMs === undefined || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1) {
        throw new Error('Invalid VK API provider admission response');
      }
      return { ok: false, reason: 'provider', retryAfterMs, retryAtMs };
    }
    if (result?.[1] !== 1 && result?.[1] !== 2) {
      throw new Error('Invalid VK API quota admission response');
    }

    return {
      ok: false,
      reason: 'quota',
      retryAfterMs: Number.isFinite(retryAfterMs)
        ? Math.max(1, Math.trunc(retryAfterMs))
        : VK_API_RATE_LIMIT_SLOT_TTL_MS,
    };
  }

  private providerCooldownKey(credentialScope: string): string {
    return `vkapi:provider-cooldown:v1:${credentialScope}`;
  }

  private assertCredentialScope(credentialScope: string): void {
    if (!/^[a-f0-9]{64}$/u.test(credentialScope))
      throw new Error('Invalid VK API credential scope');
  }

  private assertRequestBudget(deadlineAtMs: number): void {
    if (Date.now() >= deadlineAtMs) {
      throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
    }
  }

  private rememberProviderCooldown(credentialScope: string, retryAtMs: number): void {
    this.localProviderCooldowns.set(
      credentialScope,
      Math.max(this.localProviderCooldowns.get(credentialScope) ?? 0, retryAtMs),
    );
  }

  private normalizeMetricPart(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/giu, '_')
      .slice(0, 80);
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : fallback;
  }

  private readNonNegativeInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(numericValue) && numericValue >= 0 ? Math.trunc(numericValue) : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logMetricFailure(error: unknown): void {
    const nowMs = Date.now();
    if (nowMs - this.lastMetricFailureLogAtMs < 10_000) {
      return;
    }

    this.lastMetricFailureLogAtMs = nowMs;
    this.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to record VK API metric',
    );
  }
}
