import type { Redis } from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';
import type { RateLimitStore } from './rate-limit.js';

export class HttpAdmissionDeferred extends Error {
  constructor(readonly retryAtMs: number) {
    super('MAX cooldown remains active');
  }
  get retryAfterMs(): number {
    return Math.max(0, this.retryAtMs - Date.now());
  }
}

// FLAG: All HTTP attempts, including reads, share this Redis-clock admission gate.
export const ADMIT_HTTP_LUA = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local cooldown=tonumber(redis.call('GET',KEYS[1]) or '0')
if cooldown-now>1000 then return -cooldown end
local gap=tonumber(ARGV[1]); local next=tonumber(redis.call('GET',KEYS[2]) or '0')
local chat=KEYS[3] ~= '' and tonumber(redis.call('GET',KEYS[3]) or '0') or 0
local safetyKey=KEYS[4] or ''
local safety=safetyKey ~= '' and tonumber(redis.call('GET',safetyKey) or '0') or 0
local at=math.max(cooldown,next,chat,safety)
if at>now then return at-now end
redis.call('SET',KEYS[2],now+gap,'PX',60000)
if KEYS[3] ~= '' then redis.call('SET',KEYS[3],now+1000,'PX',60000) end
if safetyKey ~= '' then redis.call('SET',safetyKey,now+1000,'PX',60000) end
return 0`;
export const COOLDOWN_LUA = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local deadline=math.min(tonumber(ARGV[1]),now+86400000)
local old=tonumber(redis.call('GET',KEYS[1]) or '0')
if deadline>now and deadline>old then redis.call('SET',KEYS[1],deadline,'PX',deadline-now+60000) end
return math.max(deadline,old)`;
export class HttpLimiter {
  private reducedUntil = 0;
  private observedUntil = 0;
  private pendingDurableUntil = 0;
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly rps: number,
    private readonly prefix = 'eraser:http',
    private readonly durable?: RateLimitStore,
  ) {}
  private async checkDurable(): Promise<void> {
    if (!this.durable) return;
    // FLAG: Failed persistence closes admission until the observed deadline is durable.
    if (this.pendingDurableUntil) {
      const deadline = this.pendingDurableUntil;
      await this.durable.extend(new Date(deadline));
      if (this.pendingDurableUntil <= deadline) this.pendingDurableUntil = 0;
    }
    const referenceMs = Date.now();
    const remainingMs = await this.durable.remainingMs(referenceMs);
    if (remainingMs > 0) throw new HttpAdmissionDeferred(referenceMs + remainingMs);
  }
  async acquire(chatId?: string, signal?: AbortSignal, purpose?: 'safety'): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      await this.checkDurable();
      if (this.observedUntil > Date.now()) throw new HttpAdmissionDeferred(this.observedUntil);
      const effectiveRps =
        Date.now() < this.reducedUntil ? Math.max(1, Math.floor(this.rps / 2)) : this.rps;
      const wait = Number(
        await this.redis.eval(
          ADMIT_HTTP_LUA,
          4,
          `${this.prefix}:cooldown`,
          `${this.prefix}:next`,
          chatId ? `${this.prefix}:chat:${chatId}` : '',
          purpose === 'safety' ? `${this.prefix}:safety` : '',
          Math.ceil(1000 / effectiveRps),
        ),
      );
      // FLAG: Long legacy Redis cooldowns also release the worker. Short cadence waits
      // stay local, so a safety rights read cannot repeatedly starve its following page.
      if (wait < 0) throw new HttpAdmissionDeferred(-wait);
      if (wait === 0) {
        // FLAG: Another response may persist a cooldown while Redis admission is in flight.
        await this.checkDurable();
        if (this.observedUntil > Date.now()) throw new HttpAdmissionDeferred(this.observedUntil);
        signal?.throwIfAborted();
        return;
      }
      await delay(Math.min(wait, 1000), undefined, { signal });
    }
  }
  async cooldownUntil(deadline: number, observedAt = Date.now()): Promise<void> {
    this.reducedUntil = Date.now() + 60_000;
    this.observedUntil = Math.max(this.observedUntil, deadline);
    if (this.durable) this.pendingDurableUntil = Math.max(this.pendingDurableUntil, deadline);
    const results = await Promise.allSettled([
      this.durable?.extend(new Date(deadline)).then(() => {
        if (this.pendingDurableUntil <= deadline) this.pendingDurableUntil = 0;
      }),
      this.redis.eval(
        COOLDOWN_LUA,
        1,
        `${this.prefix}:cooldown`,
        Math.min(deadline, observedAt + 86_400_000),
      ),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
