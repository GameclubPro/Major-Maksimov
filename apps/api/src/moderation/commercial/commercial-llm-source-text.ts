import type { MaxUpdate } from '@maxim/contracts';
import { selectMaxMessageCandidate } from '../../max/max-message-candidate.util';
import { extractMaxVisibleContentTextSegments } from '../../max/max-visible-content-text';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const flatten = (value: string) => value.replace(/\s+/gu, ' ').trim();

// FLAG: Restore whitespace only when the parser-selected visible content still matches exactly.
// Replies, hidden targets and preview URLs stripped by the parser never gain model authority.
export function commercialLlmSourceUpdate(update: MaxUpdate): MaxUpdate {
  const { message } = update;
  if (!message?.text || message.text.length > 2500 || !update.raw) return update;
  const selected = selectMaxMessageCandidate(update.raw, update.type)?.node;
  if (!selected) return update;
  const visible = (node: Record<string, unknown>) =>
    extractMaxVisibleContentTextSegments(node, { preferLineBreaks: true }).join(' ').trim();
  const direct = visible(selected);
  const link = asRecord(selected.link);
  const forward =
    typeof link?.type === 'string' && link.type.trim().toLowerCase() === 'forward'
      ? (asRecord(link.message) ?? asRecord(link.body))
      : undefined;
  const forwarded = forward ? visible(forward) : '';
  const restored =
    direct && forwarded && flatten(direct).toLowerCase() !== flatten(forwarded).toLowerCase()
      ? direct + ' ' + forwarded
      : direct || forwarded;
  if (restored === message.text || flatten(restored) !== message.text) return update;
  return { ...update, message: { ...message, text: restored } };
}
