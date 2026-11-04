import {
  commercialAdsPreviewRequestSchema,
  commercialAdsPreviewResponseSchema,
  type CommercialAdsPreviewRequest,
} from '@maxim/contracts/settings';
import type { ApiTransport } from './transport';

export async function previewCommercialAds(
  api: ApiTransport,
  chatId: string,
  input: CommercialAdsPreviewRequest,
  signal?: AbortSignal,
) {
  return commercialAdsPreviewResponseSchema.parse(
    await api.request(`/chats/${encodeURIComponent(chatId)}/commercial-ads/preview`, {
      method: 'POST',
      signal,
      body: JSON.stringify(commercialAdsPreviewRequestSchema.parse(input)),
    }),
  );
}

export async function reportCommercialAdsMistake(
  api: ApiTransport,
  chatId: string,
  feedItemId: string,
) {
  const result = await api.request(`/chats/${encodeURIComponent(chatId)}/commercial-ads/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedItemId }),
  });
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true)
    throw new Error('Не удалось отправить отметку.');
  return { ok: true as const };
}
