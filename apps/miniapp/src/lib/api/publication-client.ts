import {
  createPublicationRequestSchema,
  listLegacyPublicationsQuerySchema,
  listLegacyPublicationsResponseSchema,
  listPublicationDeliveriesQuerySchema,
  listPublicationDeliveriesResponseSchema,
  listPublicationsQuerySchema,
  listPublicationsResponseSchema,
  publicationActionRequestSchema,
  publicationCalendarAvailabilityRequestSchema,
  publicationCalendarAvailabilityResponseSchema,
  publicationDetailsSchema,
  publicationTargetsRefreshResponseSchema,
  retryPublicationOccurrenceRequestSchema,
  resolvePublicationAmbiguousDeliveryRequestSchema,
  testPublicationRequestSchema,
  updatePublicationRequestSchema,
  type CreatePublicationRequest,
  type ListLegacyPublicationsQuery,
  type ListLegacyPublicationsResponse,
  type ListPublicationDeliveriesQuery,
  type ListPublicationDeliveriesResponse,
  type ListPublicationsQuery,
  type ListPublicationsResponse,
  type PublicationActionRequest,
  type PublicationCalendarAvailabilityRequest,
  type PublicationCalendarAvailabilityResponse,
  type PublicationDetails,
  type PublicationTargetsRefreshResponse,
  type RetryPublicationOccurrenceRequest,
  type ResolvePublicationAmbiguousDeliveryRequest,
  type TestPublicationRequest,
  type UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import {
  resolvePublisherEntitiesRequestSchema,
  type ResolvePublisherEntitiesRequest,
} from '@maxim/contracts/publisher';
import { tracePublicationApi, type PublicationApiOperation } from '../publication-api-trace';
import type { ApiTransport } from './transport';

export const PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS = 5 * 60_000;

export async function refreshSelectedPublicationTargets(
  api: ApiTransport,
  targets: ResolvePublisherEntitiesRequest['targets'],
): Promise<PublicationTargetsRefreshResponse> {
  const body = JSON.stringify(resolvePublisherEntitiesRequestSchema.parse({ targets }));
  const response = await api.request('/publisher/entities/refresh-selected', {
    method: 'POST',
    body,
  });
  return publicationTargetsRefreshResponseSchema.parse(response);
}

function resolvePublicationMediaMutationTimeout(content: {
  media: ReadonlyArray<{ type: string; base64?: string }>;
}): number | undefined {
  const hasInlineMedia = content.media.some(
    (item) => item.type === 'image' || (item.type === 'video' && Boolean(item.base64)),
  );
  return hasInlineMedia ? PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS : undefined;
}

async function runPublicationApiRequest<T>(
  operation: PublicationApiOperation,
  request: () => Promise<unknown>,
  parseResponse: (response: unknown) => T,
): Promise<T> {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const response = await request();
    const result = parseResponse(response);
    const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    tracePublicationApi(operation, 'ok', finishedAt - startedAt);
    return result;
  } catch (error: unknown) {
    const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    tracePublicationApi(operation, 'error', finishedAt - startedAt);
    throw error;
  }
}

function appendQuery(path: string, values: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export async function listPublications(
  api: ApiTransport,
  query: Partial<ListPublicationsQuery> = {},
): Promise<ListPublicationsResponse> {
  const parsed = listPublicationsQuerySchema.parse(query);
  return runPublicationApiRequest(
    'list',
    () => api.request(appendQuery('/publications', parsed)),
    (response) => listPublicationsResponseSchema.parse(response),
  );
}

export async function listLegacyPublications(
  api: ApiTransport,
  query: Partial<ListLegacyPublicationsQuery> = {},
): Promise<ListLegacyPublicationsResponse> {
  const parsed = listLegacyPublicationsQuerySchema.parse(query);
  const response = await api.request(appendQuery('/publications/legacy', parsed));
  return listLegacyPublicationsResponseSchema.parse(response);
}

export async function getPublicationCalendarAvailability(
  api: ApiTransport,
  payload: PublicationCalendarAvailabilityRequest,
): Promise<PublicationCalendarAvailabilityResponse> {
  const body = JSON.stringify(publicationCalendarAvailabilityRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'calendar',
    () =>
      api.request('/publications/calendar-availability', {
        method: 'POST',
        body,
      }),
    (response) => publicationCalendarAvailabilityResponseSchema.parse(response),
  );
}

export async function getPublication(
  api: ApiTransport,
  publicationId: string,
): Promise<PublicationDetails> {
  return runPublicationApiRequest(
    'details',
    () => api.request(`/publications/${encodeURIComponent(publicationId)}`),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function skipPublicationOccurrence(
  api: ApiTransport,
  publicationId: string,
  occurrenceId: string,
  request: PublicationActionRequest,
): Promise<PublicationDetails> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/occurrences/${encodeURIComponent(occurrenceId)}/skip`,
    { method: 'POST', body: JSON.stringify(publicationActionRequestSchema.parse(request)) },
  );
  return publicationDetailsSchema.parse(response);
}

export async function refreshPublicationTargets(
  api: ApiTransport,
  publicationId: string,
): Promise<PublicationTargetsRefreshResponse> {
  const response = await api.request(
    `/publications/${encodeURIComponent(publicationId)}/targets/refresh`,
    { method: 'POST' },
  );
  return publicationTargetsRefreshResponseSchema.parse(response);
}

export async function createPublication(
  api: ApiTransport,
  payload: CreatePublicationRequest,
): Promise<PublicationDetails> {
  const request = createPublicationRequestSchema.parse({ ...payload, mediaVersion: 2 });
  const body = JSON.stringify(request);
  const timeoutMs = resolvePublicationMediaMutationTimeout(request.content);
  return runPublicationApiRequest(
    'publish',
    () =>
      api.request('/publications', {
        method: 'POST',
        body,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function updatePublication(
  api: ApiTransport,
  publicationId: string,
  payload: UpdatePublicationRequest,
): Promise<PublicationDetails> {
  const request = updatePublicationRequestSchema.parse({ ...payload, mediaVersion: 2 });
  const body = JSON.stringify(request);
  const timeoutMs = request.content
    ? resolvePublicationMediaMutationTimeout(request.content)
    : undefined;
  return runPublicationApiRequest(
    'update',
    () =>
      api.request(`/publications/${encodeURIComponent(publicationId)}`, {
        method: 'PUT',
        body,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function deletePublication(
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const body = JSON.stringify(publicationActionRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'action',
    () =>
      api.request(`/publications/${encodeURIComponent(publicationId)}`, {
        method: 'DELETE',
        body,
      }),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function cancelPublication(
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const body = JSON.stringify(publicationActionRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'action',
    () =>
      api.request(`/publications/${encodeURIComponent(publicationId)}/cancel`, {
        method: 'POST',
        body,
      }),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function testPublication(
  api: ApiTransport,
  payload: TestPublicationRequest,
): Promise<void> {
  const request = testPublicationRequestSchema.parse(payload);
  const body = JSON.stringify(request);
  const timeoutMs = resolvePublicationMediaMutationTimeout(request.content);
  await runPublicationApiRequest(
    'action',
    () =>
      api.request('/publications/test', {
        method: 'POST',
        body,
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    () => undefined,
  );
}

async function runPublicationAction(
  api: ApiTransport,
  publicationId: string,
  action: 'pause' | 'resume',
  payload: PublicationActionRequest,
): Promise<PublicationDetails> {
  const body = JSON.stringify(publicationActionRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'action',
    () =>
      api.request(`/publications/${encodeURIComponent(publicationId)}/${action}`, {
        method: 'POST',
        body,
      }),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export const pausePublication = (
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
) => runPublicationAction(api, publicationId, 'pause', payload);

export const resumePublication = (
  api: ApiTransport,
  publicationId: string,
  payload: PublicationActionRequest,
) => runPublicationAction(api, publicationId, 'resume', payload);

export async function listPublicationDeliveries(
  api: ApiTransport,
  publicationId: string,
  query: Partial<ListPublicationDeliveriesQuery> = {},
): Promise<ListPublicationDeliveriesResponse> {
  const parsed = listPublicationDeliveriesQuerySchema.parse(query);
  return runPublicationApiRequest(
    'deliveries',
    () =>
      api.request(
        appendQuery(`/publications/${encodeURIComponent(publicationId)}/deliveries`, parsed),
      ),
    (response) => listPublicationDeliveriesResponseSchema.parse(response),
  );
}

export async function retryPublicationOccurrence(
  api: ApiTransport,
  publicationId: string,
  occurrenceId: string,
  payload: RetryPublicationOccurrenceRequest,
): Promise<PublicationDetails> {
  const body = JSON.stringify(retryPublicationOccurrenceRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'action',
    () =>
      api.request(
        `/publications/${encodeURIComponent(publicationId)}/occurrences/${encodeURIComponent(
          occurrenceId,
        )}/retry`,
        {
          method: 'POST',
          body,
        },
      ),
    (response) => publicationDetailsSchema.parse(response),
  );
}

export async function resolvePublicationAmbiguousDelivery(
  api: ApiTransport,
  publicationId: string,
  occurrenceId: string,
  payload: ResolvePublicationAmbiguousDeliveryRequest,
): Promise<PublicationDetails> {
  const body = JSON.stringify(resolvePublicationAmbiguousDeliveryRequestSchema.parse(payload));
  return runPublicationApiRequest(
    'action',
    () =>
      api.request(
        `/publications/${encodeURIComponent(publicationId)}/occurrences/${encodeURIComponent(
          occurrenceId,
        )}/resolve-ambiguous`,
        {
          method: 'POST',
          body,
        },
      ),
    (response) => publicationDetailsSchema.parse(response),
  );
}
