import type { ManagedEntityType } from '@maxim/contracts';
import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollListResponseSchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type CreateManagedPollRequest,
  type ManagedPollDetails,
  type ManagedPollListScope,
  type ManagedPollListResponse,
  type ManagedPollVotersResponse,
  type UpdateManagedPollRequest,
} from '@maxim/contracts/poll';
import type { ApiTransport } from './transport';

export const MANAGED_POLL_MUTATION_TIMEOUT_MS = 10 * 60_000;

function resolveManagedPollsBase(entityType: ManagedEntityType, entityId: string): string {
  const collection = entityType === 'channel' ? 'channels' : 'chats';
  return `/${collection}/${encodeURIComponent(entityId)}/polls`;
}

export async function getManagedPolls(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  options: {
    scope?: ManagedPollListScope;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ManagedPollListResponse> {
  const params = new URLSearchParams();
  if (options.scope) {
    params.set('scope', options.scope);
  }
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await api.request(`${resolveManagedPollsBase(entityType, entityId)}${query}`, {
    signal: options.signal,
  });
  return managedPollListResponseSchema.parse(response);
}

export async function createManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  payload: CreateManagedPollRequest,
): Promise<ManagedPollDetails> {
  const requestBody = createManagedPollRequestSchema.parse(payload);
  const response = await api.request(resolveManagedPollsBase(entityType, entityId), {
    method: 'POST',
    body: JSON.stringify(requestBody),
    timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS,
    retryMutationOnTransportError: false,
  });
  return managedPollDetailsSchema.parse(response);
}

export async function getManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}`,
    { signal: options.signal },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function updateManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
  payload: UpdateManagedPollRequest,
): Promise<ManagedPollDetails> {
  const requestBody = updateManagedPollRequestSchema.parse(payload);
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(requestBody),
      timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS,
    },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function publishManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}/publish`,
    { method: 'POST', timeoutMs: MANAGED_POLL_MUTATION_TIMEOUT_MS },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function closeManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}/close`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function refreshManagedPollPublication(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}/refresh`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function resetManagedPollPublication(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
): Promise<ManagedPollDetails> {
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(
      pollId,
    )}/reset-publication`,
    { method: 'POST' },
  );
  return managedPollDetailsSchema.parse(response);
}

export async function deleteManagedPoll(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
): Promise<void> {
  await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}`,
    { method: 'DELETE' },
  );
}

export async function getManagedPollVoters(
  api: ApiTransport,
  entityType: ManagedEntityType,
  entityId: string,
  pollId: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<ManagedPollVotersResponse> {
  const params = new URLSearchParams();
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await api.request(
    `${resolveManagedPollsBase(entityType, entityId)}/${encodeURIComponent(pollId)}/voters${query}`,
    { signal: options.signal },
  );
  return managedPollVotersResponseSchema.parse(response);
}
