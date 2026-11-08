import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { ChatContext } from './chat-context-cache.service';

export const CHAT_CONTEXT_MEDIA_FIELDS = ['botSpeechMedia', 'stopWordsMedia'] as const;
const MEDIA_FIELDS = CHAT_CONTEXT_MEDIA_FIELDS;
const MIN_BLOB_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const CHAT_CONTEXT_MEDIA_TTL_SEC = 60;
const LOCAL_TTL_MS = 60_000;
const LOCAL_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_MAX_ENTRIES = 32;
type MediaField = (typeof MEDIA_FIELDS)[number];
type Reference = { sha256: string; bytes: number };
type LocalBlob = { raw: string; bytes: number; expiresAt: number };

export function chatContextMediaKey(sha256: string): string {
  return `chat:context:media:v1:${sha256}`;
}

// FLAG: These blobs are immutable cache content, never settings or execution authority.
// A missing or corrupt reference is a whole-context cache miss, never permission to omit media.
export class ChatContextMediaCache {
  private readonly local = new Map<string, LocalBlob>();
  private retainedBytes = 0;

  constructor(
    private readonly redis: Pick<Redis, 'get' | 'set' | 'expire'>,
    private readonly readBlob: (key: string) => Promise<string | null> = (key) => redis.get(key),
  ) {}

  clear(): void {
    this.local.clear();
    this.retainedBytes = 0;
  }

  async encode(value: ChatContext): Promise<{
    serialized: string;
    fullBytesEstimate: number;
    blobKeys: string[];
  }> {
    const settings = { ...value.settings };
    const fields: Partial<Record<MediaField, Reference>> = {};
    let mediaBytes = 0;
    for (const field of MEDIA_FIELDS) {
      if (settings[field] === undefined) continue;
      const raw = JSON.stringify(settings[field]);
      const bytes = Buffer.byteLength(raw);
      // FLAG: Keep exceptional legacy sizes inline; never discard configured media to fit a cache.
      if (bytes < MIN_BLOB_BYTES || bytes > MAX_BLOB_BYTES) continue;
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const key = chatContextMediaKey(sha256);
      // FLAG: A locally verified immutable blob needs only a small TTL renewal. A source read may
      // replace missing/corrupt cache bytes with the exact content from that source snapshot.
      if (!this.readLocal(sha256) || !(await this.redis.expire(key, CHAT_CONTEXT_MEDIA_TTL_SEC))) {
        await this.redis.set(key, raw, 'EX', CHAT_CONTEXT_MEDIA_TTL_SEC);
      }
      this.remember(sha256, raw, bytes);
      fields[field] = { sha256, bytes };
      mediaBytes += bytes;
      delete (settings as Partial<typeof settings>)[field];
    }
    const serialized = JSON.stringify({
      ...value,
      settings,
      ...(Object.keys(fields).length ? { __maximMedia: { version: 1, fields } } : {}),
    });
    return {
      serialized,
      fullBytesEstimate: Buffer.byteLength(serialized) + mediaBytes,
      blobKeys: Object.values(fields).map((ref) => chatContextMediaKey(ref.sha256)),
    };
  }

  async decode(serialized: string): Promise<{ value: ChatContext; fullBytesEstimate: number }> {
    const parsed = JSON.parse(serialized) as ChatContext & { __maximMedia?: unknown };
    if (!Object.hasOwn(parsed, '__maximMedia')) {
      return { value: parsed, fullBytesEstimate: Buffer.byteLength(serialized) };
    }
    const envelope = record(parsed.__maximMedia);
    const fields = record(envelope?.fields);
    if (
      !envelope ||
      envelope.version !== 1 ||
      Object.keys(envelope).some((key) => key !== 'version' && key !== 'fields') ||
      !fields ||
      Object.keys(fields).length < 1 ||
      Object.keys(fields).some((key) => !MEDIA_FIELDS.includes(key as MediaField)) ||
      !record(parsed.settings)
    ) {
      throw new Error('Invalid chat context media envelope');
    }
    const settings = { ...parsed.settings };
    let mediaBytes = 0;
    for (const field of MEDIA_FIELDS) {
      if (!Object.hasOwn(fields, field)) continue;
      const ref = record(fields[field]);
      if (
        !ref ||
        Object.keys(ref).some((key) => key !== 'sha256' && key !== 'bytes') ||
        typeof ref.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(ref.sha256) ||
        !Number.isSafeInteger(ref.bytes) ||
        Number(ref.bytes) < MIN_BLOB_BYTES ||
        Number(ref.bytes) > MAX_BLOB_BYTES ||
        Object.hasOwn(settings, field)
      ) {
        throw new Error('Invalid chat context media reference');
      }
      let raw = this.readLocal(ref.sha256);
      if (!raw) {
        raw = await this.readBlob(chatContextMediaKey(ref.sha256));
        if (
          raw === null ||
          Buffer.byteLength(raw) !== ref.bytes ||
          createHash('sha256').update(raw).digest('hex') !== ref.sha256
        ) {
          throw new Error('Chat context media cache miss');
        }
        this.remember(ref.sha256, raw, Number(ref.bytes));
      }
      if (Buffer.byteLength(raw) !== ref.bytes) throw new Error('Chat context media size mismatch');
      // FLAG: Parse a fresh object so a caller cannot mutate another context's cached media.
      settings[field] = JSON.parse(raw);
      mediaBytes += Number(ref.bytes);
    }
    delete parsed.__maximMedia;
    return {
      value: { ...parsed, settings },
      fullBytesEstimate: Buffer.byteLength(serialized) + mediaBytes,
    };
  }

  private readLocal(sha256: string): string | null {
    const value = this.local.get(sha256);
    if (!value) return null;
    this.local.delete(sha256);
    if (value.expiresAt <= Date.now()) {
      this.retainedBytes -= value.bytes;
      return null;
    }
    this.local.set(sha256, value);
    return value.raw;
  }

  private remember(sha256: string, raw: string, encodedBytes: number): void {
    const bytes = encodedBytes * 2 + 256;
    const previous = this.local.get(sha256);
    if (previous) {
      this.local.delete(sha256);
      this.retainedBytes -= previous.bytes;
    }
    if (bytes > LOCAL_MAX_BYTES) return;
    while (this.local.size >= LOCAL_MAX_ENTRIES || this.retainedBytes + bytes > LOCAL_MAX_BYTES) {
      const first = this.local.entries().next().value;
      if (!first) break;
      this.local.delete(first[0]);
      this.retainedBytes -= first[1].bytes;
    }
    this.local.set(sha256, { raw, bytes, expiresAt: Date.now() + LOCAL_TTL_MS });
    this.retainedBytes += bytes;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
