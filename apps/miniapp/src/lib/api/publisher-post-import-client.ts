import {
  publisherPostImportCreateRequestSchema,
  publisherPostImportCurrentResponseSchema,
  publisherPostImportSessionSchema,
  type PublisherPostImportCreateRequest,
  type PublisherPostImportCurrentResponse,
  type PublisherPostImportSession,
} from '@maxim/contracts/publisher';
import type { ApiTransport } from './transport';

export async function createPublisherPostImport(
  api: ApiTransport,
  payload: PublisherPostImportCreateRequest,
): Promise<PublisherPostImportSession> {
  const body = JSON.stringify(publisherPostImportCreateRequestSchema.parse(payload));
  const response = await api.request('/publisher/post-imports?contractVersion=2', {
    method: 'POST',
    body,
  });
  return publisherPostImportSessionSchema.parse(response);
}

export async function getActivePublisherPostImport(
  api: ApiTransport,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherPostImportCurrentResponse> {
  const response = await api.request('/publisher/post-imports/active?contractVersion=2', {
    signal: options.signal,
  });
  return publisherPostImportCurrentResponseSchema.parse(response);
}

export async function getPublisherPostImportByToken(
  api: ApiTransport,
  startToken: string,
  options: { signal?: AbortSignal } = {},
): Promise<PublisherPostImportCurrentResponse> {
  const response = await api.request(
    `/publisher/post-imports/by-token/${encodeURIComponent(startToken)}?contractVersion=2`,
    { signal: options.signal },
  );
  return publisherPostImportCurrentResponseSchema.parse(response);
}

export async function cancelPublisherPostImport(
  api: ApiTransport,
): Promise<PublisherPostImportSession> {
  const response = await api.request('/publisher/post-imports?contractVersion=2', {
    method: 'DELETE',
  });
  return publisherPostImportSessionSchema.parse(response);
}

export async function getPublisherPostImportAsset(
  api: ApiTransport,
  sessionId: string,
  assetId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const response = await api.request(
    `/publisher/post-imports/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
    { signal: options.signal, responseType: 'blob' },
  );
  if (!(response instanceof Blob) || !response.type.toLowerCase().startsWith('image/')) {
    throw new Error('Сервер вернул неверный формат изображения.');
  }
  return response;
}
