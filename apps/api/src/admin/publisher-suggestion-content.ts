import { z } from 'zod';
import { MAX_TEXT_MARKUP_TYPES, normalizeMaxUserMentionLink } from '../common/max-text-markup.util';
import { readTrimmedString } from './admin-legacy-utils';
import { buildPublishedChannelSuggestionMarkdownPayload } from './admin-channel-suggestion-presentation';

const storedMarkupSchema = z.object({
  type: z.enum(MAX_TEXT_MARKUP_TYPES),
  from: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  url: z.string().nullable().optional(),
  userLink: z.string().nullable().optional(),
  user_link: z.string().nullable().optional(),
  userId: z.union([z.string(), z.number()]).nullable().optional(),
  user_id: z.union([z.string(), z.number()]).nullable().optional(),
});

export function buildPublisherSuggestionPublicationText(
  actorUserId: string,
  payload: Record<string, unknown>,
): string {
  if (typeof payload.actorUserId === 'string' && payload.actorUserId !== actorUserId)
    payload = {
      ...payload,
      authorDisplayName: null,
      authorMentionDisplayName: null,
      authorUsername: null,
      authorProfileUrl: null,
    };
  const markup = (Array.isArray(payload.textMarkup) ? payload.textMarkup : []).flatMap((item) => {
    const parsed = storedMarkupSchema.safeParse(item);
    if (!parsed.success) return [];
    const row = parsed.data;
    return [
      {
        type: row.type,
        from: row.from,
        length: row.length,
        url: readTrimmedString(row.url),
        userLink: normalizeMaxUserMentionLink(
          row.userLink ?? row.user_link,
          row.userId ?? row.user_id,
        ),
      },
    ];
  });
  return buildPublishedChannelSuggestionMarkdownPayload(
    {
      userId: actorUserId,
      displayName: readTrimmedString(payload.authorDisplayName),
      mentionDisplayName: readTrimmedString(payload.authorMentionDisplayName),
      username: readTrimmedString(payload.authorUsername),
      profileUrl: readTrimmedString(payload.authorProfileUrl),
    },
    typeof payload.text === 'string' ? payload.text : '',
    payload.textFormat === 'markdown' ? 'markdown' : 'plain',
    markup,
  ).text;
}
