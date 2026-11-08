import { createHash } from 'node:crypto';
import type { ChatSettings, Prisma } from '../prisma/prisma-client';
import type { ChatSettingsTemplate } from './chat-context-source';
import { CHAT_CONTEXT_MEDIA_FIELDS } from './chat-context-media-cache';

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
  segments: {
    compactBytes: number;
    maxCompactBytes: number;
    maxCompactEntryBytes: number;
    mediaBytes: number;
    maxMediaBytes: number;
    mediaEntries: number;
    sharedMediaReuses: number;
    mediaCapacityEvictions: number;
  };
};

type MediaField = (typeof CHAT_CONTEXT_MEDIA_FIELDS)[number];
type CompactSettings = Omit<ChatSettings, MediaField> & Partial<Pick<ChatSettings, MediaField>>;
type TemplateEntry = {
  value: { proof: ChatSettingsTemplate['proof']; settings: CompactSettings };
  media: Partial<Record<MediaField, string>>;
  estimatedBytes: number;
};
type PreparedMedia = { value: Prisma.JsonValue; estimatedBytes: number };
type RetainedMedia = PreparedMedia & { owners: Set<string> };

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_COMPACT_ENTRY_BYTES = 256 * 1024;
const MIN_SHARED_MEDIA_BYTES = 64 * 1024;

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

export class ChatSettingsTemplateCache {
  private readonly entries = new Map<string, TemplateEntry>();
  private readonly media = new Map<string, RetainedMedia>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxCompactBytes: number;
  private readonly maxMediaBytes: number;
  private readonly maxCompactEntryBytes: number;
  private compactBytes = 0;
  private mediaBytes = 0;
  private sharedMediaReuses = 0;
  private mediaCapacityEvictions = 0;
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
      positiveLimit(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
      this.maxBytes,
    );
    this.maxMediaBytes =
      this.maxBytes >= 4 * MIN_SHARED_MEDIA_BYTES ? Math.floor(this.maxBytes / 2) : 0;
    this.maxCompactBytes = this.maxBytes - this.maxMediaBytes;
    this.maxCompactEntryBytes = Math.min(MAX_COMPACT_ENTRY_BYTES, this.maxCompactBytes);
  }

  get(chatId: string): ChatSettingsTemplate | null {
    const entry = this.entries.get(chatId);
    if (!entry) {
      this.counters.misses += 1;
      return null;
    }
    const captured: Partial<Record<MediaField, Prisma.JsonValue>> = {};
    for (const field of CHAT_CONTEXT_MEDIA_FIELDS) {
      const key = entry.media[field];
      if (!key) continue;
      const blob = this.media.get(key);
      if (!blob) {
        this.delete(chatId);
        this.counters.misses += 1;
        return null;
      }
      this.media.delete(key);
      this.media.set(key, blob);
      captured[field] = blob.value;
    }
    this.entries.delete(chatId);
    this.entries.set(chatId, entry);
    this.counters.hits += 1;
    // FLAG: A template is private content, not freshness proof. Its caller must verify SQL
    // identity/version, and must never be able to mutate the retained settings or proof.
    // Capture immutable media before the SQL await: eviction cannot truncate an in-flight read.
    return {
      proof: { ...entry.value.proof },
      get settings(): ChatSettings {
        // FLAG: Defer materialization until SQL accepts the proof. JSON containers are private
        // copies; immutable base64 strings can be shared without copying their large contents.
        const settings = structuredClone(entry.value.settings) as ChatSettings;
        for (const field of CHAT_CONTEXT_MEDIA_FIELDS) {
          if (captured[field] !== undefined) settings[field] = cloneJson(captured[field]);
        }
        return settings;
      },
    };
  }

  set(chatId: string, template: ChatSettingsTemplate): void {
    const settings: CompactSettings = { ...template.settings };
    const media: TemplateEntry['media'] = {};
    const prepared = new Map<string, PreparedMedia>();
    let logicalMediaBytes = 0;
    for (const field of CHAT_CONTEXT_MEDIA_FIELDS) {
      const value = settings[field];
      if (value === undefined || this.maxMediaBytes === 0) continue;
      const raw = JSON.stringify(value);
      const bytes = Buffer.byteLength(raw);
      if (bytes < MIN_SHARED_MEDIA_BYTES) continue;
      const key = createHash('sha256').update(raw).digest('hex');
      const estimatedBytes = 2 * bytes + 256;
      prepared.set(key, { value, estimatedBytes });
      media[field] = key;
      logicalMediaBytes += estimatedBytes;
      delete settings[field];
    }
    const value = { proof: template.proof, settings };
    // FLAG: Both segments share the original total budget. Reject an exceptional entry before
    // evicting unrelated settings or cloning media; SQL still returns the complete source.
    const estimatedBytes =
      2 * Buffer.byteLength(JSON.stringify(value)) +
      512 +
      2 * chatId.length +
      256 * Object.keys(media).length;
    this.delete(chatId);
    if (
      estimatedBytes + logicalMediaBytes > this.maxEntryBytes ||
      estimatedBytes > this.maxCompactEntryBytes ||
      [...prepared.values()].reduce((sum, blob) => sum + blob.estimatedBytes, 0) >
        this.maxMediaBytes
    ) {
      this.counters.oversizedSkips += 1;
      return;
    }
    while (
      this.entries.size >= this.maxEntries ||
      this.compactBytes + estimatedBytes > this.maxCompactBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
      this.counters.capacityEvictions += 1;
    }
    const missingMediaBytes = () =>
      [...prepared].reduce(
        (sum, [key, blob]) => sum + (this.media.has(key) ? 0 : blob.estimatedBytes),
        0,
      );
    while (this.mediaBytes + missingMediaBytes() > this.maxMediaBytes) {
      const oldest = [...this.media.keys()].find((key) => !prepared.has(key));
      if (oldest === undefined) throw new Error('Settings media admission invariant failed');
      const blob = this.media.get(oldest)!;
      this.media.delete(oldest);
      this.mediaBytes -= blob.estimatedBytes;
      this.mediaCapacityEvictions += 1;
      // FLAG: Media pressure can evict its dependent templates, never ordinary small settings.
      for (const owner of blob.owners) {
        this.delete(owner);
        this.counters.capacityEvictions += 1;
      }
    }
    for (const [key, blob] of prepared) {
      const existing = this.media.get(key);
      if (existing) {
        existing.owners.add(chatId);
        this.media.delete(key);
        this.media.set(key, existing);
        this.sharedMediaReuses += 1;
      } else {
        this.media.set(key, { ...blob, value: cloneJson(blob.value), owners: new Set([chatId]) });
        this.mediaBytes += blob.estimatedBytes;
      }
    }
    this.entries.set(chatId, { value: structuredClone(value), media, estimatedBytes });
    this.compactBytes += estimatedBytes;
    this.counters.writes += 1;
  }

  delete(chatId: string): void {
    const entry = this.entries.get(chatId);
    if (!entry) return;
    this.entries.delete(chatId);
    this.compactBytes -= entry.estimatedBytes;
    for (const key of new Set(Object.values(entry.media))) {
      const blob = this.media.get(key);
      if (!blob) continue;
      blob.owners.delete(chatId);
      if (blob.owners.size === 0) {
        this.media.delete(key);
        this.mediaBytes -= blob.estimatedBytes;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.media.clear();
    this.compactBytes = 0;
    this.mediaBytes = 0;
  }

  snapshot(): ChatSettingsTemplateCacheSnapshot {
    return {
      entries: this.entries.size,
      estimatedBytes: this.compactBytes + this.mediaBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      maxEntryBytes: this.maxEntryBytes,
      ...this.counters,
      segments: {
        compactBytes: this.compactBytes,
        maxCompactBytes: this.maxCompactBytes,
        maxCompactEntryBytes: this.maxCompactEntryBytes,
        mediaBytes: this.mediaBytes,
        maxMediaBytes: this.maxMediaBytes,
        mediaEntries: this.media.size,
        sharedMediaReuses: this.sharedMediaReuses,
        mediaCapacityEvictions: this.mediaCapacityEvictions,
      },
    };
  }
}

function cloneJson(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item === undefined ? undefined : cloneJson(item),
      ]),
    );
  }
  return value;
}
