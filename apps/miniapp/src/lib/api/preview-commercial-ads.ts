import {
  commercialAdsPreviewRequestSchema,
  commercialAdsPreviewResponseSchema,
  resolveCommercialAdsPolicy,
  type CommercialAdCategory,
} from '@maxim/contracts/settings';
import type { PreviewState } from './preview-transport-state';
import { parseJsonBody } from './preview-transport-shared';
import { readPreviewClock } from './preview-transport-runtime';

export function handlePreviewCommercialAds(
  state: PreviewState,
  tail: string[],
  method: string,
  init?: RequestInit,
) {
  if (tail[1] === 'feedback' && method === 'POST') {
    const payload = parseJsonBody(init) as { feedItemId?: string };
    const item = state.chatViolations.find(
      (entry) =>
        entry.id === payload.feedItemId &&
        (entry.ruleCode === 'COMMERCIAL_AD' || entry.ruleCode === 'COMMERCIAL_LLM_DELETE'),
    );
    if (!item) throw new Error('Запись не найдена.');
    item.metadata = { ...item.metadata, commercialFeedbackReported: true };
    return { ok: true };
  }
  if (tail[1] !== 'preview' || method !== 'POST') throw new Error('Действие недоступно.');
  const input = commercialAdsPreviewRequestSchema.parse(parseJsonBody(init));
  if (!input.enabled)
    return commercialAdsPreviewResponseSchema.parse({
      decision: 'KEEP',
      categories: [],
      reason: 'FILTER_DISABLED',
    });
  // This local fixture only drives the emulator. Production always calls the server classifier.
  const categories: CommercialAdCategory[] = [];
  const text = input.text.toLocaleLowerCase('ru-RU');
  if (text.trim() === 'можно заказать?')
    return commercialAdsPreviewResponseSchema.parse({
      decision: 'UNSURE',
      categories: [],
      reason: 'INSUFFICIENT_CONTEXT',
    });
  if (/продам\s+(?:сво[йюеи]|личн)|отдам\s+даром/u.test(text)) categories.push('PERSONAL_SALE');
  if (/предлагаю\s+услуги|выполняю\s+ремонт|ремонт\s+под\s+ключ/u.test(text))
    categories.push('SERVICES');
  if (/наш(?:ем|его)?\s+магазин|скидк[аиу]|товары?\s+в\s+наличии|принимаем\s+заказы/u.test(text))
    categories.push('BUSINESS');
  if (/подписывайтесь|вступайте\s+в|мой\s+канал/u.test(text)) categories.push('COMMUNITIES');
  if (!categories.length)
    return commercialAdsPreviewResponseSchema.parse({
      decision: 'KEEP',
      categories,
      reason: 'NOT_ADVERTISING',
    });
  const resolution = resolveCommercialAdsPolicy({
    policy: input.policy,
    categories,
    userId: input.userId,
    nowMs: readPreviewClock(state.clock).getTime(),
  });
  return commercialAdsPreviewResponseSchema.parse({
    decision:
      resolution.decision === 'BLOCK' ||
      (resolution.decision === 'LEGACY' && !categories.includes('PERSONAL_SALE'))
        ? 'DELETE'
        : resolution.decision === 'UNSURE'
          ? 'UNSURE'
          : 'KEEP',
    categories,
    reason: resolution.reason,
    ...(resolution.matchedExceptionIds[0]
      ? { matchedExceptionId: resolution.matchedExceptionIds[0] }
      : {}),
  });
}
