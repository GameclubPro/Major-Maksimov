import { suggestionNativeButtons } from './suggestion-native-protocol';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { MaxMessageButton } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';

export function buildPublishedSuggestionButton(
  profile: MiniappProfile,
  payload: Record<string, unknown>,
): MaxMessageButton | null {
  // FLAG: Publik's published review status is a queued handoff, not a confirmed MAX post.
  if (
    profile !== 'moderation' ||
    payload.reviewStatus !== 'published' ||
    typeof payload.publishedMessageId !== 'string' ||
    !payload.publishedMessageId.trim() ||
    typeof payload.publishedUrl !== 'string'
  )
    return null;
  try {
    const url = new URL(payload.publishedUrl.trim());
    if (
      url.protocol !== 'https:' ||
      !['max.ru', 'www.max.ru'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname === '/' ||
      url.href.length > 2048
    )
      return null;
    return { type: 'link', text: 'Опубликовано', url: url.href };
  } catch {
    return null;
  }
}

export function suggestionReviewUrl(
  links: MaxBotLinkService,
  profile: MiniappProfile,
  id: string,
  mode: 'edit' | 'reject' | 'publish' = 'edit',
): string | null {
  const route = `/suggestions/${encodeURIComponent(id)}/${mode}`;
  const start = `mr-${Buffer.from(JSON.stringify({ v: 1, k: 'route', r: route })).toString('base64url')}`;
  return profile === 'publisher'
    ? links.buildPublisherMiniappStartUrlSync(start)
    : links.buildEntryMiniappStartUrlSync(start);
}

export function buildSuggestionReviewButtons(
  _links: MaxBotLinkService | undefined,
  _profile: MiniappProfile,
  id: string,
  _publish?: MaxMessageButton,
  revision = 0,
): MaxMessageButton[][] {
  return suggestionNativeButtons(id, revision);
}
