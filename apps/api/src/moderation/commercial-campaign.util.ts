import { createHash } from 'node:crypto';
import { extractUrlsFromText, stripUrlsFromText } from '../common/url-text.util';
import { parseCommercialPhones } from './commercial/commercial-phone';
import {
  buildCommercialCampaignSlidingSenderVelocityChatsKey,
  InMemoryCommercialCampaignSlidingWindow,
} from './commercial/commercial-campaign-sliding';

const COMMERCIAL_CAMPAIGN_KEY_PREFIX = 'commercial-campaign:v1';
const COMMERCIAL_CAMPAIGN_PHONE_PATTERN =
  /(?:\+?\d(?:\uFE0F?\u20E3)?(?:[\d\s().‐‑‒–—―•·|/:+-]|\uFE0F|\u20E3){8,}\d(?:\uFE0F?\u20E3)?)/gu;
const COMMERCIAL_CAMPAIGN_HANDLE_PATTERN =
  /(?:^|[^\p{L}\p{N}_])@([a-z0-9_]{4,32})(?=$|[^\p{L}\p{N}_])/giu;
const COMMERCIAL_CAMPAIGN_TEXT_MIN_LENGTH = 18;
const COMMERCIAL_CAMPAIGN_TEXT_MIN_TOKENS = 3;
const COMMERCIAL_CAMPAIGN_NEAR_TEXT_MIN_LENGTH = 24;
const COMMERCIAL_CAMPAIGN_NEAR_TEXT_MIN_TOKENS = 4;

export const COMMERCIAL_CAMPAIGN_WINDOW_SEC = 36 * 60 * 60;
export const COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC = [5 * 60, 30 * 60, 120 * 60] as const;
export const COMMERCIAL_CAMPAIGN_MAX_LINKS = 2;
export const COMMERCIAL_CAMPAIGN_MAX_PHONES = 2;
export const COMMERCIAL_CAMPAIGN_MAX_DOMAINS = 2;
export const COMMERCIAL_CAMPAIGN_MAX_HANDLES = 2;

export type CommercialCampaignFingerprint = {
  normalizedText: string;
  textHash: string | null;
  nearTextHash: string | null;
  links: string[];
  domains: string[];
  phones: string[];
  handles: string[];
};

export type CommercialCampaignContext = {
  senderDistinctChatCount: number;
  sameTextDistinctChatCount: number;
  repeatedPhoneDistinctChatCount: number;
  repeatedLinkDistinctChatCount: number;
  nearTextDistinctChatCount?: number;
  repeatedDomainDistinctChatCount?: number;
  repeatedHandleDistinctChatCount?: number;
  senderDistinctChatCount5m?: number;
  senderDistinctChatCount30m?: number;
  senderDistinctChatCount120m?: number;
  shadowSlidingSenderDistinctChatCount5m?: number;
  shadowSlidingSenderDistinctChatCount30m?: number;
  shadowSlidingSenderDistinctChatCount120m?: number;
};

type InMemoryExpiringSet = {
  expiresAtMs: number;
  members: Set<string>;
};

type InMemoryExpiryQueue = {
  entries: Array<{ key: string; expiresAtMs: number }>;
  head: number;
};

function hashCampaignKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizeCampaignText(value: string): string {
  let normalized = stripUrlsFromText(value.toLowerCase());
  normalized = normalized.replace(COMMERCIAL_CAMPAIGN_PHONE_PATTERN, ' ');
  normalized = normalized.replace(/ё/g, 'е');
  normalized = normalized.replace(/([a-zа-я0-9])\1{2,}/giu, '$1$1');
  normalized = normalized.replace(/[_*~`"'«»“”(){}[\]|]+/gu, ' ');
  normalized = normalized.replace(/[^\p{L}\p{N}\s%+-]+/gu, ' ');
  normalized = normalized.replace(/\s+/gu, ' ').trim();
  return normalized;
}

function normalizeNearCampaignText(value: string): string {
  let normalized = normalizeCampaignText(value);
  normalized = normalized.replace(/\d+/gu, '0');
  normalized = normalized.replace(/\b(?:р|руб|рублей|₽|usd|eur)\b/giu, ' ');
  normalized = normalized.replace(/\s+/gu, ' ').trim();
  return normalized;
}

export function normalizeCommercialCampaignSenderId(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCommercialCampaignPhone(value: string): string | null {
  const digits = value.replace(/\D+/gu, '');
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  if (digits.length === 11 && digits.startsWith('8')) {
    return `7${digits.slice(1)}`;
  }

  return digits;
}

export function extractCommercialCampaignPhones(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const phones: string[] = [];

  for (const contact of parseCommercialPhones(value)) {
    const normalized = normalizeCommercialCampaignPhone(contact.normalizedNumber);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    phones.push(normalized);
    if (phones.length >= COMMERCIAL_CAMPAIGN_MAX_PHONES) {
      break;
    }
  }

  return phones;
}

export function normalizeCommercialCampaignUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    const pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    return `${hostname}${pathname === '/' ? '' : pathname}`;
  } catch {
    return null;
  }
}

export function normalizeCommercialCampaignDomain(value: string): string | null {
  const normalized = normalizeCommercialCampaignUrl(value);
  if (!normalized) {
    return null;
  }

  return normalized.split('/')[0] ?? null;
}

export function extractCommercialCampaignLinks(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const links: string[] = [];

  for (const rawLink of extractUrlsFromText(value)) {
    const normalized = normalizeCommercialCampaignUrl(rawLink);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    links.push(normalized);
    if (links.length >= COMMERCIAL_CAMPAIGN_MAX_LINKS) {
      break;
    }
  }

  return links;
}

export function extractCommercialCampaignDomains(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const domains: string[] = [];

  for (const rawLink of extractUrlsFromText(value)) {
    const normalized = normalizeCommercialCampaignDomain(rawLink);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    domains.push(normalized);
    if (domains.length >= COMMERCIAL_CAMPAIGN_MAX_DOMAINS) {
      break;
    }
  }

  return domains;
}

export function normalizeCommercialCampaignHandle(value: string): string | null {
  const normalized = value.trim().replace(/^@/u, '').toLowerCase();
  return /^[a-z0-9_]{4,32}$/u.test(normalized) ? normalized : null;
}

export function extractCommercialCampaignHandles(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const handles: string[] = [];

  for (const match of value.matchAll(COMMERCIAL_CAMPAIGN_HANDLE_PATTERN)) {
    const normalized = normalizeCommercialCampaignHandle(match[1] ?? '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    handles.push(normalized);
    if (handles.length >= COMMERCIAL_CAMPAIGN_MAX_HANDLES) {
      break;
    }
  }

  return handles;
}

export function buildCommercialCampaignFingerprint(value: string): CommercialCampaignFingerprint {
  const normalizedText = normalizeCampaignText(value);
  const tokenCount = normalizedText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const normalizedNearText = normalizeNearCampaignText(value);
  const nearTokenCount = normalizedNearText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const textHash =
    normalizedText.length >= COMMERCIAL_CAMPAIGN_TEXT_MIN_LENGTH &&
    tokenCount >= COMMERCIAL_CAMPAIGN_TEXT_MIN_TOKENS
      ? createHash('sha256').update(normalizedText).digest('hex').slice(0, 20)
      : null;
  const nearTextHash =
    normalizedNearText.length >= COMMERCIAL_CAMPAIGN_NEAR_TEXT_MIN_LENGTH &&
    nearTokenCount >= COMMERCIAL_CAMPAIGN_NEAR_TEXT_MIN_TOKENS
      ? createHash('sha256').update(normalizedNearText).digest('hex').slice(0, 20)
      : null;

  return {
    normalizedText,
    textHash,
    nearTextHash,
    links: extractCommercialCampaignLinks(value),
    domains: extractCommercialCampaignDomains(value),
    phones: extractCommercialCampaignPhones(value),
    handles: extractCommercialCampaignHandles(value),
  };
}

export function hasCommercialCampaignEvidence(
  value: CommercialCampaignContext | null | undefined,
): value is CommercialCampaignContext {
  return Boolean(
    value &&
    (value.sameTextDistinctChatCount >= 2 ||
      (value.nearTextDistinctChatCount ?? 0) >= 2 ||
      value.repeatedPhoneDistinctChatCount >= 2 ||
      value.repeatedLinkDistinctChatCount >= 2 ||
      (value.repeatedDomainDistinctChatCount ?? 0) >= 3 ||
      (value.repeatedHandleDistinctChatCount ?? 0) >= 2 ||
      value.senderDistinctChatCount >= 3),
  );
}

export function buildCommercialCampaignSenderChatsKey(senderId: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:chats`;
}

export function buildCommercialCampaignSenderTextChatsKey(
  senderId: string,
  textHash: string,
): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:text:${textHash}:chats`;
}

export function buildCommercialCampaignSenderNearTextChatsKey(
  senderId: string,
  nearTextHash: string,
): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:near-text:${nearTextHash}:chats`;
}

export function buildCommercialCampaignPhoneChatsKey(phone: string): string {
  // FLAG: New phone evidence must not inherit old URL/identifier memberships (36h TTL).
  // Keep unrelated sender/link histories and let the old phone namespace expire naturally.
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:phone-v2:${hashCampaignKeyPart(phone)}:chats`;
}

export function buildCommercialCampaignLinkChatsKey(link: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:link:${hashCampaignKeyPart(link)}:chats`;
}

export function buildCommercialCampaignDomainChatsKey(domain: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:domain:${hashCampaignKeyPart(domain)}:chats`;
}

export function buildCommercialCampaignHandleChatsKey(handle: string): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:handle:${hashCampaignKeyPart(handle)}:chats`;
}

export function buildCommercialCampaignSenderVelocityChatsKey(
  senderId: string,
  windowSec: (typeof COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC)[number],
): string {
  return `${COMMERCIAL_CAMPAIGN_KEY_PREFIX}:sender:${hashCampaignKeyPart(senderId)}:velocity:${windowSec}:chats`;
}

export class InMemoryCommercialCampaignTracker {
  private readonly sets = new Map<string, InMemoryExpiringSet>();
  private readonly expiryQueues = new Map<number, InMemoryExpiryQueue>();
  private readonly slidingWindow = new InMemoryCommercialCampaignSlidingWindow();

  constructor(private readonly ttlSec = COMMERCIAL_CAMPAIGN_WINDOW_SEC) {}

  get retainedKeyCount(): number {
    return this.sets.size + this.slidingWindow.retainedKeyCount;
  }

  track(params: {
    createdAt: Date;
    chatId: string;
    senderId: string;
    text: string;
  }): CommercialCampaignContext | null {
    const normalizedSenderId = normalizeCommercialCampaignSenderId(params.senderId);
    if (!normalizedSenderId) {
      return null;
    }

    const createdAtMs = params.createdAt.getTime();
    this.pruneExpiredSets(createdAtMs);
    const fingerprint = buildCommercialCampaignFingerprint(params.text);
    const senderDistinctChatCount = this.addToSetWithTtl(
      buildCommercialCampaignSenderChatsKey(normalizedSenderId),
      params.chatId,
      createdAtMs,
    );
    const senderDistinctChatCount5m = this.addToSetWithTtl(
      buildCommercialCampaignSenderVelocityChatsKey(
        normalizedSenderId,
        COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
      ),
      params.chatId,
      createdAtMs,
      COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[0],
    );
    const senderDistinctChatCount30m = this.addToSetWithTtl(
      buildCommercialCampaignSenderVelocityChatsKey(
        normalizedSenderId,
        COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
      ),
      params.chatId,
      createdAtMs,
      COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[1],
    );
    const senderDistinctChatCount120m = this.addToSetWithTtl(
      buildCommercialCampaignSenderVelocityChatsKey(
        normalizedSenderId,
        COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
      ),
      params.chatId,
      createdAtMs,
      COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC[2],
    );
    const slidingVelocityCounts = COMMERCIAL_CAMPAIGN_VELOCITY_WINDOWS_SEC.map(
      (windowSeconds) =>
        this.slidingWindow.observe({
          key: buildCommercialCampaignSlidingSenderVelocityChatsKey(
            normalizedSenderId,
            windowSeconds,
          ),
          chatId: params.chatId,
          eventTimestampMs: createdAtMs,
          nowMs: createdAtMs,
          windowSeconds,
        }).size,
    );
    const sameTextDistinctChatCount = fingerprint.textHash
      ? this.addToSetWithTtl(
          buildCommercialCampaignSenderTextChatsKey(normalizedSenderId, fingerprint.textHash),
          params.chatId,
          createdAtMs,
        )
      : 0;
    const nearTextDistinctChatCount = fingerprint.nearTextHash
      ? this.addToSetWithTtl(
          buildCommercialCampaignSenderNearTextChatsKey(
            normalizedSenderId,
            fingerprint.nearTextHash,
          ),
          params.chatId,
          createdAtMs,
        )
      : 0;

    let repeatedPhoneDistinctChatCount = 0;
    for (const phone of fingerprint.phones) {
      repeatedPhoneDistinctChatCount = Math.max(
        repeatedPhoneDistinctChatCount,
        this.addToSetWithTtl(
          buildCommercialCampaignPhoneChatsKey(phone),
          params.chatId,
          createdAtMs,
        ),
      );
    }

    let repeatedLinkDistinctChatCount = 0;
    for (const link of fingerprint.links) {
      repeatedLinkDistinctChatCount = Math.max(
        repeatedLinkDistinctChatCount,
        this.addToSetWithTtl(buildCommercialCampaignLinkChatsKey(link), params.chatId, createdAtMs),
      );
    }

    let repeatedDomainDistinctChatCount = 0;
    for (const domain of fingerprint.domains) {
      repeatedDomainDistinctChatCount = Math.max(
        repeatedDomainDistinctChatCount,
        this.addToSetWithTtl(
          buildCommercialCampaignDomainChatsKey(domain),
          params.chatId,
          createdAtMs,
        ),
      );
    }

    let repeatedHandleDistinctChatCount = 0;
    for (const handle of fingerprint.handles) {
      repeatedHandleDistinctChatCount = Math.max(
        repeatedHandleDistinctChatCount,
        this.addToSetWithTtl(
          buildCommercialCampaignHandleChatsKey(handle),
          params.chatId,
          createdAtMs,
        ),
      );
    }

    return {
      senderDistinctChatCount,
      sameTextDistinctChatCount,
      repeatedPhoneDistinctChatCount,
      repeatedLinkDistinctChatCount,
      nearTextDistinctChatCount,
      repeatedDomainDistinctChatCount,
      repeatedHandleDistinctChatCount,
      senderDistinctChatCount5m,
      senderDistinctChatCount30m,
      senderDistinctChatCount120m,
      shadowSlidingSenderDistinctChatCount5m: slidingVelocityCounts[0],
      shadowSlidingSenderDistinctChatCount30m: slidingVelocityCounts[1],
      shadowSlidingSenderDistinctChatCount120m: slidingVelocityCounts[2],
    };
  }

  private addToSetWithTtl(
    key: string,
    member: string,
    createdAtMs: number,
    ttlSec = this.ttlSec,
  ): number {
    const existing = this.sets.get(key);
    if (!existing || existing.expiresAtMs <= createdAtMs) {
      const next: InMemoryExpiringSet = {
        expiresAtMs: createdAtMs + ttlSec * 1000,
        members: new Set([member]),
      };
      this.sets.set(key, next);
      this.enqueueExpiry(key, next.expiresAtMs, ttlSec);
      return next.members.size;
    }

    existing.members.add(member);
    return existing.members.size;
  }

  private enqueueExpiry(key: string, expiresAtMs: number, ttlSec: number): void {
    const queue = this.expiryQueues.get(ttlSec) ?? { entries: [], head: 0 };
    queue.entries.push({ key, expiresAtMs });
    this.expiryQueues.set(ttlSec, queue);
  }

  private pruneExpiredSets(createdAtMs: number): void {
    for (const queue of this.expiryQueues.values()) {
      while (queue.head < queue.entries.length) {
        const entry = queue.entries[queue.head];
        if (entry.expiresAtMs > createdAtMs) {
          break;
        }
        queue.head += 1;
        if (this.sets.get(entry.key)?.expiresAtMs === entry.expiresAtMs) {
          this.sets.delete(entry.key);
        }
      }

      if (queue.head >= 1_024 && queue.head * 2 >= queue.entries.length) {
        queue.entries.splice(0, queue.head);
        queue.head = 0;
      }
    }
  }
}
