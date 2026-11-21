import { isRetiredSuperBanCommandText } from '@maxim/contracts';
import type { WebhookEvent } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import {
  parseAdminForwardedModerationCommand,
  type AdminForwardedCommandSettings,
} from '../moderation/admin-forwarded-command.util';
import { parseWebhookEventTimestampMs } from './webhook-event-timestamp';
import {
  isLegacyOpaqueSequence,
  legacyParsedTextMatches,
  inspectSourceAbandonmentForwardText,
} from './webhook-legacy-forward-source';
import {
  inspectSourceAbandonmentSource,
  inspectSourceAbandonmentPostSealSource,
  legacySnapshotDigest,
} from './webhook-legacy-source';
import {
  isSourceAbandonmentDirectMedia,
  inspectSourceAbandonmentReplyText,
} from './webhook-source-abandonment-content';
import {
  isSourceAbandonmentMarkup,
  isSourceAbandonmentOuterMarkup,
  sourceAbandonmentHttpsUrl,
} from './webhook-source-abandonment-markup';
import { isLegacyDirectMedia } from './webhook-legacy-direct-source';
import {
  SOURCE_ABANDONMENT_CHANNEL_PROFILE,
  type SourceAbandonmentSource,
} from './webhook-source-abandonment.contract';

type SourceOwner = Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const identity = (value: unknown): string | null =>
  typeof value === 'number'
    ? Number.isSafeInteger(value)
      ? String(value)
      : null
    : typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 512 &&
        value === value.trim() &&
        !Array.from(value).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ? value
      : null;

// FLAG: Scheme-less channel links are passive original formatting only. They
// never become URLs to fetch, source identities or child targets. The separate
// channel branch admits only direct text and preserves the original UTF-16 bounds.
function isChannelOuterMarkup(body: Record<string, unknown>, link: unknown): boolean {
  if (isSourceAbandonmentOuterMarkup(body, link)) return true;
  const text = body.text;
  if (
    link !== undefined ||
    typeof text !== 'string' ||
    !Array.isArray(body.markup) ||
    body.markup.length > 64
  )
    return false;
  return body.markup.every((entry) => {
    if (isSourceAbandonmentMarkup([entry], text)) return true;
    const item = record(entry);
    return Boolean(
      item &&
      item.type === 'link' &&
      keys(item, ['type', 'from', 'length', 'url']) &&
      typeof item.from === 'number' &&
      Number.isSafeInteger(item.from) &&
      item.from >= 0 &&
      typeof item.length === 'number' &&
      Number.isSafeInteger(item.length) &&
      item.length > 0 &&
      item.from + item.length <= text.length &&
      typeof item.url === 'string' &&
      item.url.length > 0 &&
      item.url.length <= 2048 &&
      item.url === item.url.trim() &&
      !/[\s\\:]/u.test(item.url) &&
      !item.url.startsWith('//') &&
      !Array.from(item.url).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    );
  });
}

// FLAG: A retained channel keyboard is passive original metadata. Its URLs,
// contact IDs and start payload never become source/child identities or execution
// authority. Only finite official link/open_app buttons are admitted; no callbacks.
export function isSourceAbandonmentChannelMedia(value: unknown, link: unknown): boolean {
  if (isSourceAbandonmentDirectMedia(value, link)) return true;
  if (link !== undefined || !Array.isArray(value) || value.length > 11) return false;
  const keyboards = value.filter((item) => record(item)?.type === 'inline_keyboard');
  const media = value.filter((item) => record(item)?.type !== 'inline_keyboard');
  if (keyboards.length !== 1 || !isLegacyDirectMedia(media)) return false;
  const keyboard = record(keyboards[0])!,
    payload = record(keyboard.payload);
  if (!keys(keyboard, ['type', 'payload']) || !payload || !keys(payload, ['buttons'])) return false;
  const rows = payload.buttons;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 30) return false;
  return rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length > 0 &&
      row.length <= 10 &&
      row.every((value) => {
        const button = record(value);
        if (
          !button ||
          typeof button.text !== 'string' ||
          button.text.trim().length === 0 ||
          button.text.length > 256
        )
          return false;
        if (button.type === 'link')
          return keys(button, ['type', 'text', 'url']) && sourceAbandonmentHttpsUrl(button.url);
        if (
          button.type !== 'open_app' ||
          !keys(button, ['type', 'text', 'web_app', 'contact_id', 'url', 'payload'])
        )
          return false;
        // FLAG: MAX also retains the original public bot shortname in web_app.
        // Its finite ASCII form remains passive metadata: do not normalize it,
        // resolve a bot, call MAX or turn it into source/child authority.
        return (
          (button.web_app === undefined ||
            sourceAbandonmentHttpsUrl(button.web_app) ||
            (typeof button.web_app === 'string' &&
              /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(button.web_app))) &&
          (button.url === undefined || sourceAbandonmentHttpsUrl(button.url)) &&
          (button.contact_id === undefined || identity(button.contact_id) !== null) &&
          (button.payload === undefined ||
            (typeof button.payload === 'string' && button.payload.length <= 4096)) &&
          (button.web_app !== undefined ||
            button.url !== undefined ||
            button.contact_id !== undefined)
        );
      }),
  );
}

// FLAG: This versioned profile proves an anonymous channel source, never a human
// identity. The original payload remains untouched; linked authors never fill its
// absent sender. Membership/private/group/unknown envelopes cannot use this path.
export function inspectChannelAuthorlessSource(
  owner: SourceOwner,
  onRefusal?: (code: string) => void,
  settings?: AdminForwardedCommandSettings,
  postSeal = false,
): SourceAbandonmentSource | null {
  const refuse = (code: string): null => {
    onRefusal?.(code);
    return null;
  };
  const update = record(owner.normalizedPayload),
    storedRaw = record(owner.rawPayload),
    raw = record(update?.raw);
  const message = record(raw?.message),
    recipient = record(message?.recipient),
    body = record(message?.body),
    normalized = record(update?.message);
  if (!update || !storedRaw || !raw || !message || !recipient || !body || !normalized)
    return refuse('channel_source_objects_missing');
  if (!owner.botId || update.botId !== owner.botId || !identity(owner.botId))
    return refuse('channel_source_receiver_unproved');
  if (
    !['message_created', 'message_edited'].includes(String(update.type)) ||
    raw.update_type !== update.type ||
    update.membership ||
    update.eventTimestampSource === 'ingress'
  )
    return refuse('channel_source_event_unproved');
  if (recipient.chat_type !== 'channel' || normalized.entityType !== 'channel')
    return refuse('channel_source_entity_unproved');
  if (message.sender !== undefined || normalized.senderId !== '')
    return refuse('channel_source_sender_present');
  if (
    !keys(raw, ['update_type', 'timestamp', 'message', 'update_id']) ||
    !keys(message, ['recipient', 'timestamp', 'body', 'link', 'url']) ||
    !keys(recipient, ['chat_id', 'chat_type']) ||
    !keys(body, ['mid', 'seq', 'text', 'attachments', 'markup']) ||
    (message.url !== undefined && !sourceAbandonmentHttpsUrl(message.url))
  )
    return refuse('channel_source_shape_unproved');
  if (
    !isLegacyOpaqueSequence(body.seq) ||
    (raw.update_id !== undefined && !identity(raw.update_id))
  )
    return refuse('channel_source_identity_unproved');
  if (
    typeof body.text !== 'string' ||
    !isSourceAbandonmentChannelMedia(body.attachments, message.link) ||
    !isChannelOuterMarkup(body, message.link) ||
    !legacyParsedTextMatches(update)
  )
    return refuse('channel_source_content_unproved');
  if (message.link !== undefined) {
    // FLAG: The original URL is separately validated passive channel metadata.
    // Only the strict linked-content view omits it; original parser equivalence,
    // source identity and the retained raw digest continue to use untouched data.
    const linkedMessage = { ...message };
    delete linkedMessage.url;
    const linkedUpdate = { ...update, raw: { ...raw, message: linkedMessage } };
    const error =
      record(message.link)?.type === 'reply'
        ? inspectSourceAbandonmentReplyText(linkedUpdate, 'SOURCE_ABANDONMENT', settings)
        : inspectSourceAbandonmentForwardText(linkedUpdate, settings);
    if (error) return refuse('channel_source_link_unproved');
  }
  const chatId = identity(recipient.chat_id),
    messageId = identity(body.mid);
  if (
    !chatId?.startsWith('-') ||
    !messageId ||
    normalized.chatId !== chatId ||
    normalized.messageId !== messageId
  )
    return refuse('channel_source_identity_unproved');
  if (typeof raw.timestamp !== 'number' || typeof message.timestamp !== 'number')
    return refuse('channel_source_clock_unproved');
  const eventAt = parseWebhookEventTimestampMs(raw.timestamp),
    sourceAt = parseWebhookEventTimestampMs(message.timestamp);
  if (
    eventAt === null ||
    sourceAt === null ||
    sourceAt > eventAt ||
    (!postSeal && eventAt > owner.createdAt.getTime()) ||
    typeof normalized.createdAt !== 'string' ||
    Date.parse(normalized.createdAt) !== eventAt
  )
    return refuse('channel_source_clock_unproved');
  // FLAG: A receipt may carry ingress's empty raw sampling sentinel; its original
  // remains in normalizedPayload.raw and passes every strict check above. Initial
  // channel owners still require the retained original, matching the SQL seal guard.
  if (
    (!postSeal || Object.keys(storedRaw).length) &&
    legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw)
  )
    return refuse('channel_source_raw_mismatch');
  try {
    if (
      isManagedEntityHandshakeStartCommand(update) ||
      /^старт$/iu.test(body.text.trim()) ||
      /^[/$]/u.test(body.text.trim()) ||
      isRetiredSuperBanCommandText(body.text) ||
      parseAdminForwardedModerationCommand(body.text) ||
      (settings && parseAdminForwardedModerationCommand(body.text, settings))
    )
      return refuse('channel_source_command');
  } catch {
    return refuse('channel_source_command');
  }
  return {
    sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE,
    chatId,
    messageId,
    userId: null,
    sourceAt: new Date(sourceAt),
  };
}

// FLAG: Only positively channel-typed envelopes enter the separate nullable-author
// validator. Ordinary sources keep the original strict human criteria unchanged.
export function inspectSourceAbandonmentAnySource(
  owner: SourceOwner,
  onRefusal?: (code: string) => void,
  settings?: AdminForwardedCommandSettings,
  postSeal = false,
): SourceAbandonmentSource | null {
  const update = record(owner.normalizedPayload),
    raw = record(update?.raw),
    message = record(raw?.message);
  if (
    record(update?.message)?.entityType === 'channel' ||
    record(message?.recipient)?.chat_type === 'channel'
  )
    return inspectChannelAuthorlessSource(owner, onRefusal, settings, postSeal);
  return postSeal
    ? inspectSourceAbandonmentPostSealSource(owner, settings)
    : inspectSourceAbandonmentSource(owner, onRefusal, settings);
}
