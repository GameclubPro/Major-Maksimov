import type { AdminForwardedCommandSettings } from '../moderation/admin-forwarded-command.util';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import {
  inspectSourceAbandonmentLinkedMediaRefusal,
  isSourceAbandonmentDirectMedia,
  isSourceAbandonmentLinkedMedia,
  type SourceAbandonmentLinkedMediaRefusal,
} from './webhook-source-abandonment-media';
import {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
} from './webhook-legacy-content-primitives';
export {
  isLegacyImageAttachment,
  isLegacyOpaqueSequence,
} from './webhook-legacy-content-primitives';
import {
  isSourceAbandonmentMarkup,
  isSourceAbandonmentOuterMarkup,
} from './webhook-source-abandonment-markup';
import { WebhookParser } from './webhook.parser';
import { isLegacyPassiveMarkup } from './webhook-legacy-direct-source';
import { extractVisiblePhotoMessageContent } from '../moderation/photo-duplicate/photo-attachment-extractor';

type ForwardBodyRefusal =
  | 'object'
  | 'keys'
  | 'mid'
  | 'seq'
  | 'text_absent'
  | 'text_null'
  | 'text_invalid'
  | 'markup'
  | 'media';
export type SourceAbandonmentForwardShapeRefusal =
  | `source_forward_${'direct' | 'linked'}_${ForwardBodyRefusal}`
  | `source_forward_linked_media_${SourceAbandonmentLinkedMediaRefusal}`
  | 'source_forward_objects'
  | 'source_forward_link_object'
  | 'source_forward_sender_null'
  | 'source_forward_sender_shape'
  | 'source_forward_message_keys'
  | 'source_forward_link_keys'
  | 'source_forward_link_type'
  | 'source_forward_chat_absent'
  | 'source_forward_chat_null'
  | 'source_forward_chat_identity'
  | 'source_forward_sender_identity'
  | 'source_forward_sender_keys'
  | 'source_forward_sender_bot'
  | 'source_forward_sender_metadata'
  | 'source_forward_sender_activity'
  | 'source_forward_normalized_text'
  | 'source_forward_bot_type';
export type LegacyForwardRefusal =
  | 'source_forward_shape'
  | 'source_forward_text'
  | 'source_forward_command'
  | 'source_forward_media'
  | SourceAbandonmentForwardShapeRefusal;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function identity(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isSafeInteger(value)
    : typeof value === 'string' && value.length > 0 && value.trim() === value;
}
function body(
  value: unknown,
  allowImages = false,
  markup?: (body: Record<string, unknown>) => boolean,
  media?: (attachments: unknown) => boolean,
  onRefusal?: (reason: ForwardBodyRefusal) => void,
): Record<string, unknown> | null {
  const refuse = (reason: ForwardBodyRefusal): null => {
    onRefusal?.(reason);
    return null;
  };
  const item = record(value);
  if (!item) return refuse('object');
  if (!onlyKeys(item, ['mid', 'seq', 'text', 'attachments', ...(markup ? ['markup'] : [])]))
    return refuse('keys');
  if (!identity(item.mid)) return refuse('mid');
  if (!isLegacyOpaqueSequence(item.seq)) return refuse('seq');
  if (typeof item.text !== 'string')
    return refuse(
      item.text === undefined ? 'text_absent' : item.text === null ? 'text_null' : 'text_invalid',
    );
  if (markup && !markup(item)) return refuse('markup');
  if (
    !(media
      ? media(item.attachments)
      : item.attachments === undefined ||
        (Array.isArray(item.attachments) &&
          (item.attachments.length === 0 ||
            (allowImages &&
              item.attachments.length <= 10 &&
              item.attachments.every(isLegacyImageAttachment)))))
  )
    return refuse('media');
  return item;
}

// FLAG: Forward metadata is content provenance, never an additional held person
// or mutation target. One official flat LinkedMessage with text/strict images; no recursion,
// reply, markup, arbitrary metadata objects or inferred missing source bodies.
export function inspectLegacyForwardText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): LegacyForwardRefusal | null {
  return inspectForwardText(update, settings, 'legacy');
}

// FLAG: Only projection of an existing post-seal hold admits passive formatting.
// A new flat message_created may also carry strict HTTPS links or one linked share;
// historical installation, edits, linked identities and command authority stay strict.
export function inspectLegacyPostSealForwardText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): LegacyForwardRefusal | null {
  return inspectForwardText(update, settings, 'legacy-post-seal');
}

// FLAG: The created-forward allowance adds only strict link spans. A modern
// mention or future markup family never silently enters the legacy hold profile.
function isLegacyPostSealMarkup(value: unknown, text: unknown, allowLinks: boolean): boolean {
  return (
    isLegacyPassiveMarkup(value, text) ||
    (allowLinks &&
      Array.isArray(value) &&
      value.length <= 64 &&
      value.every(
        (entry) => record(entry)?.type === 'link' || isLegacyPassiveMarkup([entry], text),
      ) &&
      isSourceAbandonmentMarkup(value, text))
  );
}

// FLAG: Share previews are passive source metadata, never downloads or new held
// targets. Preserve the original image profile; no other modern media is admitted.
function isLegacyPostSealLinkedMedia(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 10) return false;
  return (
    value.every(isLegacyImageAttachment) ||
    (value.length === 1 &&
      record(value[0])?.type === 'share' &&
      isSourceAbandonmentDirectMedia(value, undefined))
  );
}

// FLAG: An empty outer caption may carry an exact copy of independently bounded
// linked markup. Strict links require an actual created forward; direct messages
// and other relations retain passive-only bounds. Composed text supplies no offsets.
export function isLegacyPostSealOuterMarkup(
  body: Record<string, unknown>,
  linkValue: unknown,
  updateType?: unknown,
): boolean {
  const link = record(linkValue);
  const allowLinks = updateType === 'message_created' && link?.type === 'forward';
  if (isLegacyPostSealMarkup(body.markup, body.text, allowLinks)) return true;
  const linked = record(link?.message);
  return Boolean(
    body.text === '' &&
    link?.type === 'forward' &&
    linked &&
    Array.isArray(body.markup) &&
    body.markup.length <= 64 &&
    isLegacyPostSealMarkup(linked.markup, linked.text, allowLinks) &&
    JSON.stringify(body.markup) === JSON.stringify(linked.markup),
  );
}

// FLAG: Only modern exact-source holds may accept an omitted linked sender.
// The outer human remains mandatory; no quoted author is inferred or held, and
// an explicitly malformed/null sender never becomes missing metadata.
export function inspectSourceAbandonmentForwardText(
  update: Record<string, unknown>,
  settings?: AdminForwardedCommandSettings,
): LegacyForwardRefusal | null {
  return inspectForwardText(update, settings, 'source-abandonment');
}

function inspectForwardText(
  update: Record<string, unknown>,
  settings: AdminForwardedCommandSettings | undefined,
  profile: 'legacy' | 'legacy-post-seal' | 'source-abandonment',
): LegacyForwardRefusal | null {
  const raw = record(update.raw);
  const message = record(raw?.message);
  const normalized = record(update.message);
  const modern = profile === 'source-abandonment';
  const createdLegacyForward =
    profile === 'legacy-post-seal' &&
    update.type === 'message_created' &&
    raw?.update_type === 'message_created' &&
    record(message?.link)?.type === 'forward';
  let directRefusal: ForwardBodyRefusal = 'object';
  let linkedRefusal: ForwardBodyRefusal = 'object';
  const direct = body(
    message?.body,
    false,
    modern
      ? (item) => isSourceAbandonmentOuterMarkup(item, message?.link)
      : profile === 'legacy-post-seal'
        ? (item) =>
            isLegacyPostSealOuterMarkup(
              item,
              message?.link,
              createdLegacyForward ? update.type : undefined,
            )
        : undefined,
    undefined,
    (reason) => {
      directRefusal = reason;
    },
  );
  const link = record(message?.link);
  const linked = body(
    link?.message,
    true,
    modern
      ? (item) => isSourceAbandonmentMarkup(item.markup, item.text)
      : profile === 'legacy-post-seal'
        ? (item) => isLegacyPostSealMarkup(item.markup, item.text, createdLegacyForward)
        : undefined,
    modern
      ? (attachments) =>
          isSourceAbandonmentLinkedMedia(attachments, 'forward', 'SOURCE_ABANDONMENT')
      : createdLegacyForward
        ? isLegacyPostSealLinkedMedia
        : undefined,
    (reason) => {
      linkedRefusal = reason;
    },
  );
  const sender = record(link?.sender);
  const omittedSender = profile === 'source-abandonment' && link?.sender === undefined;
  // FLAG: Refine only the deciding refusal, never the admitted source shapes.
  // Legacy keeps its coarse contract; modern diagnostics expose fixed codes only,
  // in the original guard order, without raw keys, values, identities or text.
  const shape = (reason: SourceAbandonmentForwardShapeRefusal): LegacyForwardRefusal =>
    modern ? reason : 'source_forward_shape';
  if (!raw || !message || !normalized) return shape('source_forward_objects');
  if (!direct) return shape(`source_forward_direct_${directRefusal}`);
  if (!link) return shape('source_forward_link_object');
  if (!linked) {
    const linkedShape = (reason: ForwardBodyRefusal): SourceAbandonmentForwardShapeRefusal =>
      modern && reason === 'media'
        ? `source_forward_linked_media_${inspectSourceAbandonmentLinkedMediaRefusal(
            record(link.message)?.attachments,
          )}`
        : `source_forward_linked_${reason}`;
    return shape(linkedShape(linkedRefusal));
  }
  if (!sender && !omittedSender)
    return shape(
      link.sender === null ? 'source_forward_sender_null' : 'source_forward_sender_shape',
    );
  if (!onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']))
    return shape('source_forward_message_keys');
  if (!onlyKeys(link, ['type', 'sender', 'chat_id', 'message']))
    return shape('source_forward_link_keys');
  if (link.type !== 'forward') return shape('source_forward_link_type');
  if (!identity(link.chat_id))
    return shape(
      link.chat_id === undefined
        ? 'source_forward_chat_absent'
        : link.chat_id === null
          ? 'source_forward_chat_null'
          : 'source_forward_chat_identity',
    );
  if (sender) {
    if (!identity(sender.user_id)) return shape('source_forward_sender_identity');
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
      return shape('source_forward_sender_keys');
    if (typeof sender.is_bot !== 'boolean') return shape('source_forward_sender_bot');
    if (
      ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
        (key) =>
          sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
      )
    )
      return shape('source_forward_sender_metadata');
    if (
      sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time))
    )
      return shape('source_forward_sender_activity');
  }
  if (typeof normalized.text !== 'string') return shape('source_forward_normalized_text');
  if (typeof update.botId !== 'string') return shape('source_forward_bot_type');

  if (
    Array.isArray(linked.attachments) &&
    linked.attachments.length > 0 &&
    linked.attachments.every(isLegacyImageAttachment)
  ) {
    const photos = extractVisiblePhotoMessageContent(message);
    if (photos.kind !== 'complete' || photos.content.images.length !== linked.attachments.length)
      return 'source_forward_media';
  }

  // FLAG: Reuse the actual parser, including whitespace collapse, case-insensitive
  // snippet deduplication and forward composition. Never equate arbitrary texts
  // by trimming or trust the submitted normalized text independently of raw MAX.
  if (!legacyParsedTextMatches(update)) return 'source_forward_text';

  // FLAG: A forward can name another moderation target or Karavan seller. Deny
  // commands in EVERY component as well as the composed text, before any claim,
  // lookup, audit or SEND; current settings alone cannot prove an old trigger absent.
  for (const text of [direct.text, linked.text, normalized.text] as string[]) {
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        (settings && parseAdminForwardedModerationCommand(text, settings))
      )
        return 'source_forward_command';
    } catch {
      return 'source_forward_command';
    }
  }
  return null;
}

export function legacyParsedTextMatches(update: Record<string, unknown>): boolean {
  const raw = record(update.raw);
  const normalized = record(update.message);
  if (
    !raw ||
    !normalized ||
    typeof normalized.text !== 'string' ||
    typeof update.botId !== 'string'
  )
    return false;
  try {
    return (
      new WebhookParser().parse(raw, { botId: update.botId }).message?.text === normalized.text
    );
  } catch {
    return false;
  }
}
