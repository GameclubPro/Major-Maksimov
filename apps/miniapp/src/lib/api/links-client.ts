import {
  linkRulesPreviewRequestSchema,
  linkRulesPreviewResponseSchema,
  type LinkRulesPolicy,
} from '@maxim/contracts/settings';
import type { ApiTransport } from './transport';

export async function previewLinks(
  api: ApiTransport,
  chatId: string,
  policy: LinkRulesPolicy,
  text: string,
) {
  return linkRulesPreviewResponseSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/links/preview`, {
      method: 'POST',
      body: JSON.stringify(linkRulesPreviewRequestSchema.parse({ policy, text })),
    }),
  );
}
