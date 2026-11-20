import {
  publicationDraftResponseSchema,
  savePublicationDraftRequestSchema,
  type SavePublicationDraftRequest,
} from '@maxim/contracts/publication-draft';
import {
  publicationActionRequestSchema,
  type PublicationActionRequest,
} from '@maxim/contracts/publication';
import type { ApiTransport } from './transport';

export async function getServerPublicationDraft(api: ApiTransport, id: string) {
  return publicationDraftResponseSchema.parse(
    await api.request(`/publications/drafts/${encodeURIComponent(id)}`),
  );
}
export async function findServerPublicationDraft(api: ApiTransport, requestId: string) {
  return publicationDraftResponseSchema.parse(
    await api.request(`/publications/drafts/by-request/${encodeURIComponent(requestId)}`),
  );
}
export async function saveServerPublicationDraft(
  api: ApiTransport,
  id: string | null,
  payload: SavePublicationDraftRequest,
) {
  const parsed = savePublicationDraftRequestSchema.parse({ ...payload, mediaVersion: 2 });
  const response = await api.request(
    id ? `/publications/drafts/${encodeURIComponent(id)}` : '/publications/drafts',
    {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(parsed),
      ...(parsed.content.media.some(
        (media) => media.type === 'image' || (media.type === 'video' && media.base64),
      )
        ? { timeoutMs: 5 * 60_000 }
        : {}),
    },
  );
  return publicationDraftResponseSchema.parse(response);
}
export async function deleteServerPublicationDraft(
  api: ApiTransport,
  id: string,
  payload: PublicationActionRequest,
) {
  await api.request(`/publications/drafts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify(publicationActionRequestSchema.parse(payload)),
  });
}
export async function getPublicationAsset(
  api: ApiTransport,
  publicationId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const blob = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/assets/${encodeURIComponent(assetId)}`,
    { responseType: 'blob', signal },
  );
  if (!(blob instanceof Blob) || !/^(image|video)\//u.test(blob.type))
    throw new Error('Предпросмотр медиа недоступен.');
  return blob;
}
