import { BadRequestException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';

import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';
import { normalizeEditableContactPayload } from './max-editable-contact';
import {
  channelDialogButtonPresentationKey,
  channelSuggestionButtonKey,
  readInternalChannelDialogButtonIdentity,
} from '../common/channel-dialog-button-identity.util';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readStrictEditableAttachments(
  message: Record<string, unknown> | null,
  includeForwarded = true,
): unknown[] {
  if (!message) {
    throw new BadRequestException('Source message is unavailable; preserving the original post.');
  }
  const body = asRecord(message.body);
  const link = asRecord(message.link);
  const linked = includeForwarded && link?.type === 'forward' ? asRecord(link.message) : null;
  const linkedBody = asRecord(linked?.body);
  const direct = body?.attachments ?? message.attachments ?? [];
  const forwarded = linkedBody?.attachments ?? linked?.attachments ?? [];
  if (!Array.isArray(direct) || !Array.isArray(forwarded)) {
    throw new BadRequestException(
      'Source attachments are incomplete; preserving the original post.',
    );
  }
  if (direct.length > 0 && forwarded.length > 0 && !isDeepStrictEqual(direct, forwarded)) {
    throw new BadRequestException(
      'Forwarded attachments are ambiguous; preserving the original post.',
    );
  }
  return direct.length > 0 ? direct : forwarded;
}

export function assertEditableAttachmentsPreserved(
  source: unknown[],
  result: Record<string, unknown>[],
  requestedButtons: readonly unknown[],
  options: { replaceSourceKeyboard?: boolean } = {},
): void {
  const keyboards = result.filter((item) => item.type === 'inline_keyboard');
  const deliveredButtons = keyboards.flatMap((item) => {
    const rows = asRecord(item.payload)?.buttons;
    return Array.isArray(rows) ? rows.flat() : [];
  });
  const requiredButtons: unknown[] = [...requestedButtons];
  const survivingSourceComments = new Set<string>();
  for (const attachment of source) {
    const row = asRecord(attachment);
    if (row?.type === 'inline_keyboard') {
      const rows = asRecord(row.payload)?.buttons;
      if (!Array.isArray(rows)) {
        throw new BadRequestException(
          'Source keyboard is incomplete; preserving the original post.',
        );
      }
      // FLAG: Only an explicitly owned private-card keyboard may change; media stays exact.
      if (options.replaceSourceKeyboard) continue;
      requiredButtons.push(...rows);
      for (const button of rows.flat()) {
        const normalized = normalizeMaxInlineKeyboardButtons([[button]])?.[0]?.[0];
        const identity = readInternalChannelDialogButtonIdentity(normalized);
        if (
          identity?.kind === 'comments' &&
          deliveredButtons.some((item) => isDeepStrictEqual(item, normalized))
        ) {
          survivingSourceComments.add(channelDialogButtonPresentationKey(identity));
        }
      }
    } else if (
      !row ||
      !result.some(
        (item) =>
          item.type === row.type &&
          isDeepStrictEqual(
            item.payload,
            row.type === 'contact' ? normalizeEditableContactPayload(row.payload) : row.payload,
          ),
      )
    ) {
      throw new BadRequestException('An attachment would be lost; preserving the original post.');
    }
  }
  for (const row of requiredButtons) {
    if (!Array.isArray(row)) {
      throw new BadRequestException('Invalid keyboard row; preserving the original post.');
    }
    for (const button of row) {
      const normalized = normalizeMaxInlineKeyboardButtons([[button]])?.[0]?.[0];
      // FLAG: Comment aliases may collapse only onto an unchanged source button. Never
      // replace an existing discussion with a new profile/token, or drop custom actions.
      const suggestionKey = normalized ? channelSuggestionButtonKey(normalized) : null;
      const identity = readInternalChannelDialogButtonIdentity(normalized);
      const retainedComments =
        identity?.kind === 'comments' &&
        survivingSourceComments.has(channelDialogButtonPresentationKey(identity));
      if (
        !normalized ||
        !deliveredButtons.some(
          (item) =>
            isDeepStrictEqual(item, normalized) ||
            retainedComments ||
            (suggestionKey !== null && channelSuggestionButtonKey(item) === suggestionKey),
        )
      ) {
        throw new BadRequestException('A button would be lost; preserving the original post.');
      }
    }
  }
}
