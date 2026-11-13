import { PRIVATE_CONTROL_CALLBACK_PREFIX } from './admin.service.support';
import { buildPublisherSuggestionAdminReviewCallbackPayload } from '../publisher/publisher-suggestion-admin.queue';
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
  links: MaxBotLinkService | undefined,
  profile: MiniappProfile,
  id: string,
  publish: MaxMessageButton,
): MaxMessageButton[][] {
  const fallbackReject: MaxMessageButton = {
    type: 'callback',
    text: '✖️ Отклонить',
    intent: 'negative',
    payload:
      profile === 'publisher'
        ? buildPublisherSuggestionAdminReviewCallbackPayload('cancel', id)
        : `${PRIVATE_CONTROL_CALLBACK_PREFIX}|suggestion_review_cancel|${id}`,
  };
  if (!links) return [[publish, fallbackReject]];
  const edit = suggestionReviewUrl(links, profile, id, 'edit');
  const reject = suggestionReviewUrl(links, profile, id, 'reject');
  return [
    ...(edit ? [[{ type: 'link' as const, text: '✏️ Редактировать', url: edit }]] : []),
    [
      publish,
      reject ? { type: 'link' as const, text: '✖️ Отклонить', url: reject } : fallbackReject,
    ],
  ];
}
