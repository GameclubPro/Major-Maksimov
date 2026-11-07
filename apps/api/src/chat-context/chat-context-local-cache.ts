import type { ChatContext } from './chat-context-cache.service';

export type ChatContextLocalCacheSnapshot = {
  entries: number;
  estimatedBytes: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  hits: number;
  misses: number;
  writes: number;
  oversizedSkips: number;
  capacityEvictions: number;
  expiredEvictions: number;
  invalidations: number;
  sweepInspected: number;
};

type LocalEntry = { value: ChatContext; expiresAtMs: number; estimatedBytes: number };
type CacheOptions = {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  sweepBatchSize: number;
  now?: () => number;
};

export class ChatContextLocalCache {
  private readonly entries = new Map<string, LocalEntry>();
  private readonly sweepOrder = new Map<string, true>();
  private readonly encodedSizes = new WeakMap<ChatContext, number>();
  private readonly now: () => number;
  private estimatedBytes = 0;
  private readonly counters = {
    hits: 0,
    misses: 0,
    writes: 0,
    oversizedSkips: 0,
    capacityEvictions: 0,
    expiredEvictions: 0,
    invalidations: 0,
    sweepInspected: 0,
  };

  constructor(private readonly options: CacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): ChatContext | null {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAtMs <= this.now()) {
      if (entry) {
        this.remove(key, entry);
        this.counters.expiredEvictions += 1;
      }
      this.counters.misses += 1;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return entry.value;
  }

  set(key: string, value: ChatContext, encodedBytes?: number): void {
    this.write(key, value, this.now() + this.options.ttlMs, encodedBytes);
  }

  replace(key: string, value: ChatContext, encodedBytes?: number): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    if (previous.expiresAtMs <= this.now()) {
      this.remove(key, previous);
      this.counters.expiredEvictions += 1;
      return;
    }
    // FLAG: Title reconciliation changes presentation, never the freshness of settings.
    // A cache hit cannot renew the source deadline or resurrect an expired snapshot.
    this.write(key, value, previous.expiresAtMs, encodedBytes);
  }

  private write(key: string, value: ChatContext, expiresAtMs: number, encodedBytes?: number): void {
    const serializedBytes =
      encodedBytes ?? this.encodedSizes.get(value) ?? Buffer.byteLength(JSON.stringify(value));
    this.encodedSizes.set(value, serializedBytes);
    // FLAG: Serialized size estimates retained strings; the cap does not measure RSS.
    const estimatedBytes = 2 * serializedBytes + 512 + 2 * key.length;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.estimatedBytes -= previous.estimatedBytes;
    }
    if (estimatedBytes > Math.min(this.options.maxEntryBytes, this.options.maxBytes)) {
      this.sweepOrder.delete(key);
      this.counters.oversizedSkips += 1;
      return;
    }

    const now = this.now();
    while (
      this.entries.size >= this.options.maxEntries ||
      this.estimatedBytes + estimatedBytes > this.options.maxBytes
    ) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.remove(...oldest);
      if (oldest[1].expiresAtMs <= now) this.counters.expiredEvictions += 1;
      else this.counters.capacityEvictions += 1;
    }
    this.entries.set(key, { value, expiresAtMs, estimatedBytes });
    this.sweepOrder.set(key, true);
    this.estimatedBytes += estimatedBytes;
    this.counters.writes += 1;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.remove(key, entry);
    this.counters.invalidations += 1;
    return true;
  }

  sweepExpired(): void {
    const now = this.now();
    const batchSize = Math.min(this.options.sweepBatchSize, this.sweepOrder.size);
    for (let inspected = 0; inspected < batchSize; inspected += 1) {
      const key = this.sweepOrder.keys().next().value;
      if (key === undefined) break;
      const entry = this.entries.get(key)!;
      this.counters.sweepInspected += 1;
      if (entry.expiresAtMs <= now) {
        this.remove(key, entry);
        this.counters.expiredEvictions += 1;
      } else {
        // FLAG: LRU touches must not starve expiry cleanup of unrelated cold entries.
        this.sweepOrder.delete(key);
        this.sweepOrder.set(key, true);
      }
    }
  }

  snapshot(): ChatContextLocalCacheSnapshot {
    return {
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      maxEntries: this.options.maxEntries,
      maxBytes: this.options.maxBytes,
      maxEntryBytes: Math.min(this.options.maxEntryBytes, this.options.maxBytes),
      ...this.counters,
    };
  }

  clear(): void {
    this.entries.clear();
    this.sweepOrder.clear();
    this.estimatedBytes = 0;
  }

  private remove(key: string, entry: LocalEntry): void {
    this.entries.delete(key);
    this.sweepOrder.delete(key);
    this.estimatedBytes -= entry.estimatedBytes;
  }
}
