import type { GlobalSpammerReviewMetrics } from '@maxim/contracts';
import type { ApiTransport } from './transport';

type GlobalSpammerReviewMetricsQuery = Partial<{
  mode: 'mode' | 'summary' | 'full';
}>;

function hasRequestSignal(value: unknown): value is Pick<RequestInit, 'signal'> {
  return Boolean(value && typeof value === 'object' && 'signal' in value);
}

export async function getGlobalSpammerReviewMetrics(
  api: ApiTransport,
  chatId: string,
  queryOrRequest: GlobalSpammerReviewMetricsQuery | Pick<RequestInit, 'signal'> = {},
  request: Pick<RequestInit, 'signal'> = hasRequestSignal(queryOrRequest) ? queryOrRequest : {},
): Promise<GlobalSpammerReviewMetrics> {
  const query = hasRequestSignal(queryOrRequest) ? {} : queryOrRequest;
  const params = new URLSearchParams();
  if (query.mode === 'mode' || query.mode === 'summary' || query.mode === 'full') {
    params.set('mode', query.mode);
  }
  const queryString = params.toString();
  const path = `/chats/${chatId}/spammer-review/metrics${queryString ? `?${queryString}` : ''}`;
  const response = await api.request(path, request);
  return response as GlobalSpammerReviewMetrics;
}
