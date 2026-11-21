import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CommercialOcrBoundingBox } from './native-tesseract-ocr.types';
import { validateCommercialOcrVersion } from './commercial-ocr.queue';

export const COMMERCIAL_OCR_CACHE_SCHEMA_VERSION = 2 as const;
const MAX_TEXT_LENGTH = 8_000;
const MAX_WORDS = 1_024;
const MAX_WORD_LENGTH = 256;
const MAX_CACHE_TTL_SECONDS = 31 * 24 * 60 * 60;
const MAX_LOCAL_CACHE_ENTRIES = 512;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type CommercialOcrCacheValue = Readonly<{
  schemaVersion: typeof COMMERCIAL_OCR_CACHE_SCHEMA_VERSION;
  status: 'recognized' | 'no_text';
  text: string;
  confidencePermille: number;
  words: readonly CommercialOcrCachedWord[];
  rasterSize?: Readonly<{ width: number; height: number }>;
}>;

export type CommercialOcrCachedWord = Readonly<{
  text: string;
  start: number;
  end: number;
  confidencePermille: number;
  boundingBox?: CommercialOcrBoundingBox;
}>;

export type CommercialOcrCacheIdentity = Readonly<{
  contentSha256: string;
  ocrVersion: string;
  pass: 'primary' | 'confirmation';
  preprocessProfile: string;
  psm: 6 | 11;
}>;

export type CommercialOcrCacheLookup =
  | { kind: 'hit'; value: CommercialOcrCacheValue }
  | { kind: 'miss' };

type LocalCacheEntry = {
  expiresAtMs: number;
  value: CommercialOcrCacheValue;
};

type LocalInFlightEntry = {
  deadlineAtMs: number;
  promise: Promise<unknown>;
};

@Injectable()
export class CommercialOcrCacheStore implements OnModuleDestroy {
  // OCR output can contain personal data. Keep exact results process-local and bounded so Redis
  // persistence never retains recognized text; a restart may lose only this optimization.
  private readonly localEntries = new Map<string, LocalCacheEntry>();
  private readonly inFlight = new Map<string, LocalInFlightEntry>();
  private expiryTimer: NodeJS.Timeout | null = null;
  private expiryTimerDueAtMs: number | null = null;
  private destroyed = false;

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearExpiryTimer();
    this.localEntries.clear();
    this.inFlight.clear();
  }

  async read(identity: CommercialOcrCacheIdentity): Promise<CommercialOcrCacheLookup> {
    const key = buildCacheKey(validateIdentity(identity));
    const entry = this.localEntries.get(key);
    if (!entry) {
      return { kind: 'miss' };
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.localEntries.delete(key);
      this.scheduleExpiryPurge();
      return { kind: 'miss' };
    }
    this.localEntries.delete(key);
    this.localEntries.set(key, entry);
    return { kind: 'hit', value: entry.value };
  }

  async write(
    identity: CommercialOcrCacheIdentity,
    value: CommercialOcrCacheValue,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }
    const key = buildCacheKey(validateIdentity(identity));
    const normalizedValue = validateCommercialOcrCacheValue(value);
    const normalizedTtlSeconds = validateCacheTtl(ttlSeconds);
    this.writeLocal(key, normalizedValue, normalizedTtlSeconds);
    return true;
  }

  async coalesceLocal<T>(
    identity: CommercialOcrCacheIdentity,
    deadlineAtMs: number,
    operation: () => Promise<T>,
    options: Readonly<{ onCoalesced?: () => void }> = {},
  ): Promise<T> {
    const key = buildCacheKey(validateIdentity(identity));
    const normalizedDeadlineAtMs = validateDeadline(deadlineAtMs);
    const existing = this.inFlight.get(key);
    if (existing && existing.deadlineAtMs >= normalizedDeadlineAtMs) {
      try {
        options.onCoalesced?.();
      } catch {
        // Telemetry observers must not change cache or moderation behavior.
      }
      return existing.promise as Promise<T>;
    }

    const pending = Promise.resolve().then(operation);
    const entry: LocalInFlightEntry = { deadlineAtMs: normalizedDeadlineAtMs, promise: pending };
    this.inFlight.set(key, entry);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === entry) {
        this.inFlight.delete(key);
      }
    }
  }

  private writeLocal(key: string, value: CommercialOcrCacheValue, ttlSeconds: number): void {
    const nowMs = Date.now();
    this.purgeExpiredLocalEntries(nowMs);
    this.localEntries.delete(key);
    this.localEntries.set(key, {
      expiresAtMs: nowMs + ttlSeconds * 1_000,
      value,
    });
    while (this.localEntries.size > MAX_LOCAL_CACHE_ENTRIES) {
      const oldestKey = this.localEntries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.localEntries.delete(oldestKey);
    }
    this.scheduleExpiryPurge(nowMs);
  }

  private purgeExpiredLocalEntries(nowMs = Date.now()): void {
    for (const [key, entry] of this.localEntries) {
      if (entry.expiresAtMs <= nowMs) {
        this.localEntries.delete(key);
      }
    }
  }

  private scheduleExpiryPurge(nowMs = Date.now()): void {
    if (this.destroyed || this.localEntries.size === 0) {
      this.clearExpiryTimer();
      return;
    }

    let earliestExpiryAtMs = Number.POSITIVE_INFINITY;
    for (const entry of this.localEntries.values()) {
      earliestExpiryAtMs = Math.min(earliestExpiryAtMs, entry.expiresAtMs);
    }
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestExpiryAtMs - nowMs));
    const dueAtMs = nowMs + delayMs;
    if (
      this.expiryTimer &&
      this.expiryTimerDueAtMs !== null &&
      this.expiryTimerDueAtMs <= dueAtMs
    ) {
      return;
    }

    this.clearExpiryTimer();
    this.expiryTimerDueAtMs = dueAtMs;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryTimerDueAtMs = null;
      this.purgeExpiredLocalEntries();
      this.scheduleExpiryPurge();
    }, delayMs);
    this.expiryTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
    }
    this.expiryTimer = null;
    this.expiryTimerDueAtMs = null;
  }
}

function validateIdentity(identity: CommercialOcrCacheIdentity): CommercialOcrCacheIdentity {
  const contentSha256 = identity.contentSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw new Error('contentSha256 is invalid');
  }
  return {
    contentSha256,
    ocrVersion: validateCommercialOcrVersion(identity.ocrVersion),
    pass: validatePass(identity.pass),
    preprocessProfile: validateProfile(identity.preprocessProfile),
    psm: validatePsm(identity.psm),
  };
}

function buildCacheKey(identity: CommercialOcrCacheIdentity): string {
  return createHash('sha256')
    .update(identity.ocrVersion)
    .update('\0')
    .update(identity.pass)
    .update('\0')
    .update(identity.preprocessProfile)
    .update('\0')
    .update(String(identity.psm))
    .update('\0')
    .update(identity.contentSha256)
    .digest('hex');
}

export function validateCommercialOcrCacheValue(
  value: CommercialOcrCacheValue,
): CommercialOcrCacheValue {
  if (value.schemaVersion !== COMMERCIAL_OCR_CACHE_SCHEMA_VERSION) {
    throw new Error('Commercial OCR cache schema version is invalid');
  }
  if (value.status !== 'recognized' && value.status !== 'no_text') {
    throw new Error('Commercial OCR cache status is invalid');
  }
  if (typeof value.text !== 'string' || value.text.length > MAX_TEXT_LENGTH) {
    throw new Error('Commercial OCR cache text is invalid');
  }
  if (value.status === 'recognized' ? value.text.trim().length === 0 : value.text.length !== 0) {
    throw new Error('Commercial OCR cache text does not match its status');
  }
  if (
    !Number.isSafeInteger(value.confidencePermille) ||
    value.confidencePermille < 0 ||
    value.confidencePermille > 1_000
  ) {
    throw new Error('Commercial OCR cache confidence is invalid');
  }
  if (!Array.isArray(value.words) || value.words.length > MAX_WORDS) {
    throw new Error('Commercial OCR cache words are invalid');
  }
  const rasterSize = readRasterSize(value.rasterSize);
  let previousEnd = 0;
  const words = value.words.map((word) => {
    const normalizedWord = validateWord(word, value.text, rasterSize);
    if (normalizedWord.start < previousEnd) {
      throw new Error('Commercial OCR cache word ordering is invalid');
    }
    previousEnd = normalizedWord.end;
    return normalizedWord;
  });
  if (value.status === 'no_text' ? words.length !== 0 : words.length === 0) {
    throw new Error('Commercial OCR cache words do not match its status');
  }
  return Object.freeze({
    ...value,
    words: Object.freeze(words),
    ...(rasterSize ? { rasterSize } : {}),
  });
}

function readRasterSize(value: CommercialOcrCacheValue['rasterSize']) {
  if (value === undefined) return undefined;
  if (
    value &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 4_000 &&
    value.height <= 4_000
  ) {
    return Object.freeze({ width: value.width, height: value.height });
  }
  throw new Error('Commercial OCR cache raster size is invalid');
}

function validateWord(
  word: CommercialOcrCachedWord,
  text: string,
  rasterSize: CommercialOcrCacheValue['rasterSize'],
): CommercialOcrCachedWord {
  if (
    !word ||
    typeof word.text !== 'string' ||
    word.text.length === 0 ||
    word.text.length > MAX_WORD_LENGTH ||
    !Number.isSafeInteger(word.start) ||
    !Number.isSafeInteger(word.end) ||
    word.start < 0 ||
    word.end <= word.start ||
    word.end > text.length ||
    text.slice(word.start, word.end) !== word.text ||
    !Number.isSafeInteger(word.confidencePermille) ||
    word.confidencePermille < 0 ||
    word.confidencePermille > 1_000
  ) {
    throw new Error('Commercial OCR cache word is invalid');
  }
  const { boundingBox, ...basic } = word;
  const validBox =
    boundingBox &&
    rasterSize &&
    Number.isSafeInteger(boundingBox.left) &&
    boundingBox.left >= 0 &&
    Number.isSafeInteger(boundingBox.top) &&
    boundingBox.top >= 0 &&
    Number.isSafeInteger(boundingBox.width) &&
    boundingBox.width > 0 &&
    Number.isSafeInteger(boundingBox.height) &&
    boundingBox.height > 0 &&
    boundingBox.left + boundingBox.width <= rasterSize.width &&
    boundingBox.top + boundingBox.height <= rasterSize.height;
  // Geometry is optional evidence for the crop optimization. Invalid geometry cannot
  // start a crop and does not suppress otherwise well-formed full-page text.
  return Object.freeze({
    ...basic,
    ...(validBox ? { boundingBox: Object.freeze({ ...boundingBox }) } : {}),
  });
}

function validateCacheTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CACHE_TTL_SECONDS) {
    throw new Error('Commercial OCR cache TTL is invalid');
  }
  return value;
}

function validateDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Commercial OCR coalescing deadline is invalid');
  }
  return value;
}

function validatePass(value: string): 'primary' | 'confirmation' {
  if (value !== 'primary' && value !== 'confirmation') {
    throw new Error('Commercial OCR cache pass is invalid');
  }
  return value;
}

function validateProfile(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error('Commercial OCR cache preprocess profile is invalid');
  }
  return normalized;
}

function validatePsm(value: number): 6 | 11 {
  if (value !== 6 && value !== 11) {
    throw new Error('Commercial OCR cache PSM is invalid');
  }
  return value;
}
