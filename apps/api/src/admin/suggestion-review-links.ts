import { suggestionNativeButtons } from './suggestion-native-protocol';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { MaxMessageButton } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';

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
