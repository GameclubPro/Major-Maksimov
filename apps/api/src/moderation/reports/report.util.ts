import { createHash } from 'node:crypto';
import {
  isRetiredSuperBanCommandText,
  REPORT_DEFAULT_TRIGGERS,
  type MaxUpdate,
  type ReportSettings,
} from '@maxim/contracts';
import { extractRawMessageNode } from '../moderation-update-extractors';

export const REPORT_DAY_MS = 86_400_000;
export const REPORT_RULE = 'PARTICIPANT_REPORT';
export const REPORT_DELETE_RULE = 'PARTICIPANT_REPORT_DELETE';
export const REPORT_COMMAND_RULE = 'PARTICIPANT_REPORT_COMMAND_CLEANUP';
export const REPORT_COUNTER_RULE = 'PARTICIPANT_REPORT_COUNTER_CLEANUP';
export const REPORT_GUARDED_RULES = new Set([
  REPORT_DELETE_RULE,
  REPORT_COMMAND_RULE,
  REPORT_COUNTER_RULE,
]);
export const REPORT_TERMINAL = [
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'DISMISSED',
  'EXPIRED',
  'CANCELLED',
];

export class ReportRejectedError extends Error {
  readonly code = 'participant_report_no_longer_authorized';
  constructor(
    message: string,
    readonly reason:
      | 'source'
      | 'membership'
      | 'sanction'
      | 'protected'
      | 'policy'
      | 'closed'
      | 'rateLimit' = 'policy',
  ) {
    super(message);
  }
}

export class ReportStaleStateError extends Error {
  readonly code = 'participant_report_state_changed';
}

export function reportLinkedMessageId(
  node: Record<string, unknown>,
  chatId: string,
): string | null {
  const link = record(node.link);
  if (link.type !== 'reply') return null;
  const linked = record(link.message);
  const linkedChatId = record(linked.recipient).chat_id ?? link.chat_id;
  if (linkedChatId !== undefined && String(linkedChatId) !== chatId) return null;
  const mid = record(linked.body).mid ?? linked.mid;
  return typeof mid === 'string' && mid.length > 0 ? mid : null;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function matchesReportTrigger(text: string, aliases: readonly string[]): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    !isRetiredSuperBanCommandText(normalized) &&
    [...REPORT_DEFAULT_TRIGGERS, ...aliases].includes(normalized)
  );
}

export function reportReplyTarget(
  update: MaxUpdate,
  settings: Pick<ReportSettings, 'reportsEnabled' | 'reportsAliases'>,
): string | null {
  if (update.type !== 'message_created' || !update.message || !settings.reportsEnabled) return null;
  if (!matchesReportTrigger(update.message.text, settings.reportsAliases)) return null;
  const node = extractRawMessageNode(record(update.raw));
  const body = record(node?.body);
  if (
    !node ||
    (Array.isArray(body.attachments) && body.attachments.length > 0) ||
    (Array.isArray(node.attachments) && node.attachments.length > 0)
  )
    return null;
  const mid = reportLinkedMessageId(node, update.message.chatId);
  return mid && mid !== update.message.messageId ? mid : null;
}

export function reportContentHash(row: Record<string, unknown>): string {
  const body = record(row.body);
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          text: body.text ?? '',
          markup: body.markup ?? [],
          attachments: Array.isArray(body.attachments)
            ? body.attachments.map(attachmentIdentity)
            : [],
          link: stableLinkedPhotos(row.link ?? null, 0),
        }),
      ),
    )
    .digest('hex');
}

function attachmentIdentity(value: unknown): unknown {
  const attachment = record(value);
  const photoId = record(attachment.payload).photo_id ?? attachment.photo_id;
  // FLAG: MAX's immutable photo ID survives signed download URL refreshes; unknown media stays exact-bound.
  if (
    attachment.type === 'image' &&
    (typeof photoId === 'string' || typeof photoId === 'number') &&
    String(photoId).length > 0
  )
    return { type: 'image', photoId: String(photoId) };
  return value;
}

function stableLinkedPhotos(value: unknown, depth: number): unknown {
  if (depth >= 4) return value;
  const link = record(value);
  const message = record(link.message);
  if (!Object.keys(message).length) return value;
  const body = record(message.body);
  // FLAG: Signed photo URLs in a linked message are transport metadata just like top-level photos.
  return {
    ...link,
    message: {
      ...message,
      ...(Array.isArray(body.attachments)
        ? {
            body: {
              ...body,
              attachments: body.attachments.map(attachmentIdentity),
            },
          }
        : {}),
      ...(message.link !== undefined ? { link: stableLinkedPhotos(message.link, depth + 1) } : {}),
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function isEligibleReporter(
  access:
    | {
        userId: string | null;
        isBot?: boolean | null;
        joinedAtMs?: number | null;
      }
    | null
    | undefined,
  userId: string,
  atMs: number,
): boolean {
  return (
    access?.userId === userId &&
    access.isBot === false &&
    typeof access.joinedAtMs === 'number' &&
    access.joinedAtMs > 0 &&
    access.joinedAtMs <= atMs - REPORT_DAY_MS
  );
}
