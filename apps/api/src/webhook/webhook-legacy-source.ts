import { createHash } from 'node:crypto';
import type { WebhookEvent } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  parseAdminForwardedModerationCommand,
  type AdminForwardedCommandSettings,
} from '../moderation/admin-forwarded-command.util';
import { isSourceAbandonmentOuterMarkup } from './webhook-source-abandonment-markup';
import type { SourceAbandonmentContentPurpose } from './webhook-source-abandonment-media';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import { isLegacyDirectMedia, isLegacyPassiveMarkup } from './webhook-legacy-direct-source';
import {
  inspectSourceAbandonmentReplyText,
  isSourceAbandonmentDirectMedia,
  type SourceAbandonmentReplyRefusal,
} from './webhook-source-abandonment-content';
import {
  inspectLegacyForwardText,
  inspectLegacyPostSealForwardText,
  inspectSourceAbandonmentForwardText,
  isLegacyOpaqueSequence,
  isLegacyPostSealOuterMarkup,
  legacyParsedTextMatches,
  type LegacyForwardRefusal,
} from './webhook-legacy-forward-source';
export type LegacyRecoverySource = {
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
};
export type LegacyRecoverySourceRefusal =
  | LegacyForwardRefusal
  | SourceAbandonmentReplyRefusal
  | 'source_objects_missing'
  | 'source_receiver_unproved'
  | 'source_event_kind'
  | 'source_membership_present'
  | 'source_ingress_clock'
  | 'source_chat_type'
  | 'source_human_unproved'
  | 'source_raw_keys'
  | 'source_message_keys'
  | 'source_sender_keys'
  | 'source_recipient_keys'
  | 'source_body_keys'
  | 'source_sender_metadata'
  | 'source_sequence'
  | 'source_update_identity'
  | 'source_attachments'
  | 'source_markup'
  | 'source_text_mismatch'
  | 'source_clock_type'
  | 'source_identity_mismatch'
  | 'source_clock_order'
  | 'source_normalized_clock'
  | 'source_command'
  | 'source_raw_mismatch'
  | 'source_command_parse_failed';
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && value.trim() && value === value.trim() ? value : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  const row = record(value);
  return row
    ? Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, canonical(row[key])]),
      )
    : value;
}
export function legacySnapshotDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

// FLAG: Positively known original MAX text shapes only. Never infer CHAT, non-command,
// author, original time or secondary targets from defaults/current settings/text heuristics.
export function inspectLegacyRecoverySource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  onRefusal?: (reason: LegacyRecoverySourceRefusal) => void,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, false, onRefusal, settings);
}

// FLAG: Only the already-held POST_SEAL receipt path may use edit/future-clock
// provenance. Strict forward links/shares are created-only; this grants no
// recovery/cutoff authority and preserves the existing edit content profile.
export function inspectLegacyPostSealTextSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, true, undefined, settings);
}

// FLAG: Modern started-source exclusion has its own closed content profile.
// Legacy entry points retain their original default; no payload is rewritten to
// pass a different validator, and this inspection alone grants no replay authority.
export function inspectSourceAbandonmentSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  onRefusal?: (reason: LegacyRecoverySourceRefusal) => void,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, false, onRefusal, settings, 'source-abandonment');
}

// FLAG: Only an already-held modern receipt uses edit/future-clock provenance.
// The same modern content profile is required before releasing receipt ordering.
export function inspectSourceAbandonmentPostSealSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(owner, true, undefined, settings, 'source-abandonment');
}

// FLAG: Automatic pristine settlement retains the v6 human content policy even
// when explicit source abandonment gains a new passive reply shape. The same
// original parser, command, clock and identity checks remain mandatory.
export function inspectPristineOperatorDiscardSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  settings?: AdminForwardedCommandSettings,
): LegacyRecoverySource | null {
  return inspectLegacyTextSource(
    owner,
    false,
    undefined,
    settings,
    'source-abandonment',
    'PRISTINE_OPERATOR_DISCARD_V1',
  );
}

function inspectLegacyTextSource(
  owner: Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>,
  postSealForward: boolean,
  onRefusal?: (reason: LegacyRecoverySourceRefusal) => void,
  settings?: AdminForwardedCommandSettings,
  profile: 'legacy' | 'source-abandonment' = 'legacy',
  purpose: SourceAbandonmentContentPurpose = 'SOURCE_ABANDONMENT',
): LegacyRecoverySource | null {
  // FLAG: Emit one fixed code from the deciding guard. Never expose raw keys,
  // source text, identities or exception details through refusal diagnostics.
  const refuse = (reason: LegacyRecoverySourceRefusal): null => {
    onRefusal?.(reason);
    return null;
  };
  const update = record(owner.normalizedPayload);
  const raw = record(update?.raw);
  const message = record(raw?.message);
  const sender = record(message?.sender);
  const recipient = record(message?.recipient);
  const body = record(message?.body);
  const normalized = record(update?.message);
  // FLAG: The immutable ingress receiver must agree in both receipt representations.
  // A routed execution owner changes independently and cannot supply missing provenance.
  if (!update || !raw || !message || !sender || !recipient || !body || !normalized)
    return refuse('source_objects_missing');
  if (typeof owner.botId !== 'string' || !identity(owner.botId) || update.botId !== owner.botId)
    return refuse('source_receiver_unproved');
  // FLAG: A modern edit keeps its own semantic claim and original message clock.
  // Candidate admission still proves the actual started owner and rejects any
  // independent unfinished claim in the exact source family. This grants no
  // replay and does not relax the ingress/cutoff clocks for initial installation.
  if (
    (update.type !== 'message_created' &&
      !(
        (postSealForward || profile === 'source-abandonment') &&
        update.type === 'message_edited'
      )) ||
    raw.update_type !== update.type
  )
    return refuse('source_event_kind');
  if (update.membership) return refuse('source_membership_present');
  if (update.eventTimestampSource === 'ingress') return refuse('source_ingress_clock');
  if (normalized.entityType !== 'chat' || recipient.chat_type !== 'chat')
    return refuse('source_chat_type');
  if (sender.is_bot !== false) return refuse('source_human_unproved');
  if (!onlyKeys(raw, ['update_type', 'timestamp', 'message', 'update_id']))
    return refuse('source_raw_keys');
  if (!onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']))
    return refuse('source_message_keys');
  if (
    !onlyKeys(sender, [
      'user_id',
      'name',
      'first_name',
      'last_name',
      'username',
      'is_bot',
      'avatar_url',
      'last_activity_time',
    ])
  )
    return refuse('source_sender_keys');
  if (!onlyKeys(recipient, ['chat_id', 'chat_type'])) return refuse('source_recipient_keys');
  if (!onlyKeys(body, ['mid', 'seq', 'text', 'attachments', 'markup']))
    return refuse('source_body_keys');
  if (
    ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
      (key) => sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
    ) ||
    (sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time)))
  )
    return refuse('source_sender_metadata');
  if (!isLegacyOpaqueSequence(body.seq)) return refuse('source_sequence');
  if (raw.update_id !== undefined && identity(raw.update_id) === null)
    return refuse('source_update_identity');
  if (
    profile === 'source-abandonment'
      ? !isSourceAbandonmentDirectMedia(body.attachments, message.link)
      : !isLegacyDirectMedia(body.attachments)
  )
    return refuse('source_attachments');
  // FLAG: MAX may omit a direct image/video caption or persist JSON null. Only
  // an already-held post-seal legacy source may use the parser's empty text;
  // admission of historical sources and forwarded/unknown content stays strict.
  const emptyDirectCaption =
    profile === 'legacy' &&
    postSealForward &&
    message.link === undefined &&
    (body.text === undefined || body.text === null) &&
    Array.isArray(body.attachments) &&
    body.attachments.length > 0 &&
    normalized.text === '';
  const sourceText = emptyDirectCaption ? '' : body.text;
  if (
    profile === 'source-abandonment'
      ? !isSourceAbandonmentOuterMarkup(body, message.link)
      : postSealForward && message.link !== undefined
        ? !isLegacyPostSealOuterMarkup(body, message.link, update.type)
        : !isLegacyPassiveMarkup(body.markup, sourceText)
  )
    return refuse('source_markup');
  if (message.link !== undefined) {
    const forwardRefusal =
      profile === 'source-abandonment' && record(message.link)?.type === 'reply'
        ? inspectSourceAbandonmentReplyText(update, purpose, settings)
        : profile === 'source-abandonment'
          ? inspectSourceAbandonmentForwardText(update, settings)
          : postSealForward
            ? inspectLegacyPostSealForwardText(update, settings)
            : inspectLegacyForwardText(update, settings);
    if (forwardRefusal) return refuse(forwardRefusal);
  } else if (typeof sourceText !== 'string' || !legacyParsedTextMatches(update))
    return refuse('source_text_mismatch');
  if (typeof sourceText !== 'string') return refuse('source_text_mismatch');
  if (typeof raw.timestamp !== 'number' || typeof message.timestamp !== 'number')
    return refuse('source_clock_type');
  const chatId = identity(recipient.chat_id);
  const messageId = identity(body.mid);
  const userId = identity(sender.user_id);
  const eventAt = parseWebhookEventTimestampMs(raw.timestamp);
  const sourceAt = parseWebhookEventTimestampMs(message.timestamp);
  if (
    !chatId ||
    !messageId ||
    !userId ||
    !chatId.startsWith('-') ||
    normalized.chatId !== chatId ||
    normalized.messageId !== messageId ||
    normalized.senderId !== userId
  )
    return refuse('source_identity_mismatch');
  if (
    eventAt === null ||
    sourceAt === null ||
    sourceAt > eventAt ||
    (!postSealForward && eventAt > owner.createdAt.getTime())
  )
    return refuse('source_clock_order');
  if (typeof normalized.createdAt !== 'string' || Date.parse(normalized.createdAt) !== eventAt)
    return refuse('source_normalized_clock');
  if (isManagedEntityHandshakeStartCommand(update) || /^[/$]/u.test(sourceText.trim()))
    return refuse('source_command');
  const storedRaw = record(owner.rawPayload);
  if (
    !storedRaw ||
    (Object.keys(storedRaw).length && legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw))
  )
    return refuse('source_raw_mismatch');
  try {
    if (
      parseAdminForwardedModerationCommand(sourceText) ||
      (settings && parseAdminForwardedModerationCommand(sourceText, settings))
    )
      return refuse('source_command');
  } catch {
    return refuse('source_command_parse_failed');
  }
  return { chatId, messageId, userId, sourceAt: new Date(sourceAt) };
}
