import { isRetiredSuperBanCommandText } from '@maxim/contracts';
import {
  parseAdminForwardedModerationCommand,
  type AdminForwardedCommandSettings,
} from '../moderation/admin-forwarded-command.util';
import { isSourceAbandonmentMarkup } from './webhook-source-abandonment-markup';
import {
  isSourceAbandonmentLinkedMedia,
  type SourceAbandonmentContentPurpose,
} from './webhook-source-abandonment-media';
export {
  isSourceAbandonmentLinkedMedia,
  isSourceAbandonmentDirectMedia,
} from './webhook-source-abandonment-media';
export { isSourceAbandonmentMarkup } from './webhook-source-abandonment-markup';
import { isLegacyOpaqueSequence } from './webhook-legacy-content-primitives';
import { legacyParsedTextMatches } from './webhook-legacy-forward-source';

export type SourceAbandonmentReplyRefusal =
  | 'source_reply_shape'
  | 'source_reply_text'
  | 'source_reply_command';

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
    : typeof value === 'string' && value.length > 0 && value === value.trim();
}

function body(
  value: unknown,
  linked: boolean,
  purpose: SourceAbandonmentContentPurpose,
): Record<string, unknown> | null {
  const item = record(value);
  return item &&
    onlyKeys(item, ['mid', 'seq', 'text', 'attachments', 'markup']) &&
    identity(item.mid) &&
    isLegacyOpaqueSequence(item.seq) &&
    typeof item.text === 'string' &&
    isSourceAbandonmentMarkup(item.markup, item.text) &&
    (linked
      ? isSourceAbandonmentLinkedMedia(item.attachments, 'reply', purpose)
      : item.attachments === undefined ||
        (Array.isArray(item.attachments) && item.attachments.length === 0))
    ? item
    : null;
}

// FLAG: Reply metadata belongs only to the modern source profile. The original
// outer chat/mid/author remain the sole excluded source. Quoted images are not
// visible source photos, and a linked sender/message never gains hold authority.
export function inspectSourceAbandonmentReplyText(
  update: Record<string, unknown>,
  purpose: SourceAbandonmentContentPurpose,
  settings?: AdminForwardedCommandSettings,
): SourceAbandonmentReplyRefusal | null {
  const raw = record(update.raw);
  const message = record(raw?.message);
  const normalized = record(update.message);
  const direct = body(message?.body, false, purpose);
  const link = record(message?.link);
  const linked = body(link?.message, true, purpose);
  const sender = record(link?.sender);
  if (
    !message ||
    !normalized ||
    !direct ||
    !link ||
    !linked ||
    !sender ||
    !onlyKeys(message, ['sender', 'recipient', 'timestamp', 'body', 'link']) ||
    !onlyKeys(link, ['type', 'sender', 'chat_id', 'message']) ||
    link.type !== 'reply' ||
    !identity(link.chat_id) ||
    !identity(sender.user_id) ||
    !onlyKeys(sender, [
      'user_id',
      'name',
      'first_name',
      'last_name',
      'username',
      'is_bot',
      'avatar_url',
      'last_activity_time',
    ]) ||
    typeof sender.is_bot !== 'boolean' ||
    ['name', 'first_name', 'last_name', 'username', 'avatar_url'].some(
      (key) => sender[key] !== undefined && sender[key] !== null && typeof sender[key] !== 'string',
    ) ||
    (sender.last_activity_time !== undefined &&
      sender.last_activity_time !== null &&
      (typeof sender.last_activity_time !== 'number' ||
        !Number.isSafeInteger(sender.last_activity_time))) ||
    typeof normalized.text !== 'string'
  )
    return 'source_reply_shape';

  // FLAG: Reparse the untouched original MAX payload; a reply's quoted text is
  // not composed into its normalized text. Never manufacture a forward or trim
  // independently to establish equivalence.
  if (!legacyParsedTextMatches(update)) return 'source_reply_text';
  for (const text of [direct.text, linked.text, normalized.text] as string[]) {
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        isRetiredSuperBanCommandText(text) ||
        parseAdminForwardedModerationCommand(text) ||
        (settings && parseAdminForwardedModerationCommand(text, settings))
      )
        return 'source_reply_command';
    } catch {
      return 'source_reply_command';
    }
  }
  return null;
}
