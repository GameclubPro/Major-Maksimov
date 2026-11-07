import type { ChatSettingsTemplate } from './chat-context-source';

type CacheOptions = {
  maxBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
};

export type ChatSettingsTemplateCacheSnapshot = {
  entries: number;
  estimatedBytes: number;
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  hits: number;
  misses: number;
  writes: number;
  oversizedSkips: number;
  capacityEvictions: number;
};

type TemplateEntry = { value: ChatSettingsTemplate; estimatedBytes: number };

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

export class ChatSettingsTemplateCache {
  private readonly entries = new Map<string, TemplateEntry>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private estimatedBytes = 0;
  private readonly counters = {
    hits: 0,
    misses: 0,
    writes: 0,
    oversizedSkips: 0,
    capacityEvictions: 0,
  };

  constructor(options: CacheOptions = {}) {
    this.maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntries = positiveLimit(options.maxEntries, 2048);
    this.maxEntryBytes = Math.min(
      positiveLimit(options.maxEntryBytes, DEFAULT_MAX_BYTES),
      this.maxBytes,
    );
  }

  get(chatId: string): ChatSettingsTemplate | null {
    const entry = this.entries.get(chatId);
    if (!entry) {
      this.counters.misses += 1;
      return null;
    }
    this.entries.delete(chatId);
    this.entries.set(chatId, entry);
    this.counters.hits += 1;
    // FLAG: A template is private content, not freshness proof. Its caller must verify SQL
    // identity/version, and must never be able to mutate the retained settings or proof.
    return structuredClone(entry.value);
  }

  set(chatId: string, template: ChatSettingsTemplate): void {
    // FLAG: Account for retained UTF-16 content and entry overhead; this is not an RSS limit.
    // Measure only on writes, before cloning an oversized media object.
    const estimatedBytes =
      2 * Buffer.byteLength(JSON.stringify(template)) + 512 + 2 * chatId.length;
    this.delete(chatId);
    if (estimatedBytes > this.maxEntryBytes) {
      this.counters.oversizedSkips += 1;
      return;
    }
    while (
      this.entries.size >= this.maxEntries ||
      this.estimatedBytes + estimatedBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.counters.capacityEvictions += 1;
    }
    this.entries.set(chatId, { value: structuredClone(template), estimatedBytes });
    this.estimatedBytes += estimatedBytes;
    this.counters.writes += 1;
  }

  delete(chatId: string): void {
    const entry = this.entries.get(chatId);
    if (!entry) return;
    this.entries.delete(chatId);
    this.estimatedBytes -= entry.estimatedBytes;
  }

  clear(): void {
    this.entries.clear();
    this.estimatedBytes = 0;
  }

  snapshot(): ChatSettingsTemplateCacheSnapshot {
    return {
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxEntryBytes: this.maxEntryBytes,
      ...this.counters,
    };
  }
}
