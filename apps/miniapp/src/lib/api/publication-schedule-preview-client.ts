import {
  publicationSchedulePreviewRequestSchema,
  publicationSchedulePreviewResponseSchema,
  type PublicationSchedulePreviewRequest,
  type PublicationSchedulePreviewResponse,
} from '@maxim/contracts/publication';
import type { ApiTransport } from './transport';

export async function getPublicationSchedulePreview(
  api: ApiTransport,
  payload: PublicationSchedulePreviewRequest,
  signal: AbortSignal,
): Promise<PublicationSchedulePreviewResponse> {
  const request = publicationSchedulePreviewRequestSchema.parse(payload);
  const response = await api.request('/publications/schedule-preview', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
    timeoutMs: 5_000,
  });
  return publicationSchedulePreviewResponseSchema.parse(response);
}
