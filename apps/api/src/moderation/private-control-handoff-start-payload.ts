import type { ManagedEntityType } from '@maxim/contracts';
import {
  buildCompactGiveawayHandoffStartPayload,
  buildCompactProfileMentionStartPayload,
  parseCompactGiveawayHandoffStartPayload,
  parseCompactProfileMentionStartPayload,
} from '../max/max-deep-link.util';
import {
  GIVEAWAY_HANDOFF_START_PAYLOAD,
  GIVEAWAY_HANDOFF_START_PREFIX,
  PROFILE_MENTION_START_PREFIX,
} from './private-control.constants';
import type {
  GiveawayHandoffStartPayload,
  ProfileMentionStartPayload,
} from './private-control.types';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { isValidMaxBotStartPayload } from '../max/max-deep-link.util';
import { KARAVAN_ALLOWLIST_START_PREFIX } from './private-control.constants';

export type PrivateKaravanAllowlistStart = {
  chatId: string;
  actorUserId: string;
  nonce: string;
};

const KARAVAN_ALLOWLIST_SCOPE = 'karavan-allowlist-v2';
const KARAVAN_ALLOWLIST_COMPACT_PREFIX = 'ka3-';
const KARAVAN_ALLOWLIST_COMPACT_SCOPE = 'karavan-allowlist-v3';
const KARAVAN_ALLOWLIST_COMPACT_COMPONENT = /^[A-Za-z0-9_-]+$/u;

function signKaravanPayload(
  encoded: string,
  botToken: string,
  scope = KARAVAN_ALLOWLIST_SCOPE,
): string {
  return createHmac('sha256', botToken.trim())
    .update(`${scope}:${encoded}`)
    .digest('hex')
    .slice(0, 16);
}

export function buildPrivateKaravanAllowlistStartPayload(
  params: Pick<PrivateKaravanAllowlistStart, 'chatId' | 'actorUserId'> & { nonce?: string },
  botToken: string,
): string {
  const nonce = params.nonce?.trim() || randomBytes(12).toString('base64url');
  const chatId = params.chatId.trim();
  const actorUserId = params.actorUserId.trim();
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, c: chatId, a: actorUserId, n: nonce }),
    'utf8',
  ).toString('base64url');
  const payload = `${KARAVAN_ALLOWLIST_START_PREFIX}${encoded}.${signKaravanPayload(encoded, botToken)}`;
  if (isValidMaxBotStartPayload(payload)) return payload;

  // Keep the existing links readable and the full nonce when long IDs exceed MAX's limit.
  const fields = [chatId, actorUserId, nonce];
  if (fields.every((field) => KARAVAN_ALLOWLIST_COMPACT_COMPONENT.test(field))) {
    const compact = fields.join('.');
    const signature = signKaravanPayload(compact, botToken, KARAVAN_ALLOWLIST_COMPACT_SCOPE);
    const compactPayload = `${KARAVAN_ALLOWLIST_COMPACT_PREFIX}${compact}.${signature}`;
    if (isValidMaxBotStartPayload(compactPayload)) return compactPayload;
  }
  throw new Error('Karavan allowlist start payload is too long or contains invalid characters');
}

export function parsePrivateKaravanAllowlistStartPayload(
  payload: string | null,
  botTokens: readonly string[],
): PrivateKaravanAllowlistStart | null {
  if (!isValidMaxBotStartPayload(payload)) return null;
  const compact = payload.startsWith(KARAVAN_ALLOWLIST_COMPACT_PREFIX);
  if (!compact && !payload.startsWith(KARAVAN_ALLOWLIST_START_PREFIX)) {
    return null;
  }
  const prefix = compact ? KARAVAN_ALLOWLIST_COMPACT_PREFIX : KARAVAN_ALLOWLIST_START_PREFIX;
  const scope = compact ? KARAVAN_ALLOWLIST_COMPACT_SCOPE : KARAVAN_ALLOWLIST_SCOPE;
  const raw = payload.slice(prefix.length);
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = raw.slice(0, separator);
  const signature = raw.slice(separator + 1).toLowerCase();
  if (!/^[a-f0-9]{16}$/u.test(signature)) return null;
  const valid = botTokens.some((token) => {
    const expected = signKaravanPayload(encoded, token, scope);
    const left = Buffer.from(signature, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  });
  if (!valid) return null;
  if (compact) {
    const fields = encoded.split('.');
    const [chatId, actorUserId, nonce] = fields;
    if (
      fields.length !== 3 ||
      !chatId ||
      !actorUserId ||
      !nonce ||
      !fields.every((field) => KARAVAN_ALLOWLIST_COMPACT_COMPONENT.test(field))
    ) {
      return null;
    }
    return { chatId, actorUserId, nonce };
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
    const actorUserId = typeof parsed.a === 'string' ? parsed.a.trim() : '';
    const nonce = typeof parsed.n === 'string' ? parsed.n.trim() : '';
    if (parsed.v !== 1 || !chatId || !actorUserId || !nonce) return null;
    return { chatId, actorUserId, nonce };
  } catch {
    return null;
  }
}

export type PrivateGiveawayHandoffStart = {
  chatId: string;
  entityType: ManagedEntityType;
  giveawayId: string | null;
};

export type PrivateProfileMentionStart = {
  chatId: string;
  entityType: ManagedEntityType;
  userId: string;
  displayName: string;
};

export function buildPrivateGiveawayHandoffStartPayload(
  params: PrivateGiveawayHandoffStart,
  botToken: string,
): string {
  const compactPayload = buildCompactGiveawayHandoffStartPayload(params, botToken);
  if (compactPayload) {
    return compactPayload;
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'giveaway-handoff',
      c: params.chatId,
      e: params.entityType,
      g: params.giveawayId,
    } satisfies GiveawayHandoffStartPayload),
    'utf8',
  ).toString('base64url');

  return `${GIVEAWAY_HANDOFF_START_PREFIX}${payload}`;
}

export function buildPrivateProfileMentionStartPayload(
  params: PrivateProfileMentionStart,
  botToken: string,
): string {
  const compactPayload = buildCompactProfileMentionStartPayload(
    {
      chatId: params.chatId,
      entityType: params.entityType,
      userId: params.userId,
    },
    botToken,
  );
  if (compactPayload) {
    return compactPayload;
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'profile-mention',
      c: params.chatId,
      e: params.entityType,
      u: params.userId,
      n: params.displayName.trim() || 'Пользователь',
    } satisfies ProfileMentionStartPayload),
    'utf8',
  ).toString('base64url');

  return `${PROFILE_MENTION_START_PREFIX}${payload}`;
}

export function parsePrivateGiveawayHandoffStartPayload(
  startPayload: string | null,
  botTokens: readonly string[],
): PrivateGiveawayHandoffStart | null {
  const compactPayload = parseCompactGiveawayHandoffStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return compactPayload;
  }

  if (!startPayload || startPayload === GIVEAWAY_HANDOFF_START_PAYLOAD) {
    return null;
  }

  if (!startPayload.startsWith(GIVEAWAY_HANDOFF_START_PREFIX)) {
    return null;
  }

  const encodedPayload = startPayload.slice(GIVEAWAY_HANDOFF_START_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<GiveawayHandoffStartPayload>;
    const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    const giveawayId =
      typeof parsed.g === 'string' && parsed.g.trim().length > 0 ? parsed.g.trim() : null;

    if (parsed.v !== 1 || parsed.k !== 'giveaway-handoff' || !chatId || !entityType) {
      return null;
    }

    return {
      chatId,
      entityType,
      giveawayId,
    };
  } catch {
    return null;
  }
}

export function parsePrivateProfileMentionStartPayload(
  startPayload: string | null,
  botTokens: readonly string[],
): PrivateProfileMentionStart | null {
  const compactPayload = parseCompactProfileMentionStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return {
      ...compactPayload,
      displayName: 'Пользователь',
    };
  }

  if (!startPayload || !startPayload.startsWith(PROFILE_MENTION_START_PREFIX)) {
    return null;
  }

  const encodedPayload = startPayload.slice(PROFILE_MENTION_START_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<ProfileMentionStartPayload>;
    const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    const userId = typeof parsed.u === 'string' ? parsed.u.trim() : '';
    const displayName = typeof parsed.n === 'string' ? parsed.n.trim() : '';

    if (parsed.v !== 1 || parsed.k !== 'profile-mention' || !chatId || !entityType || !userId) {
      return null;
    }

    return {
      chatId,
      entityType,
      userId,
      displayName: displayName || 'Пользователь',
    };
  } catch {
    return null;
  }
}
