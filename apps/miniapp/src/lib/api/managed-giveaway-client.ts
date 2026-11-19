import { broadcastHandoffResponseSchema } from '@maxim/contracts/broadcast';
import {
  managedGiveawayDetailsSchema,
  managedGiveawayHandoffRequestSchema,
  managedGiveawaySummarySchema,
  markManagedGiveawayWinnerDeliveredRequestSchema,
  rerollManagedGiveawayWinnerRequestSchema,
  updateManagedGiveawayRequestSchema,
  type ManagedGiveawayDetails,
  type ManagedGiveawaySummary,
} from '@maxim/contracts/giveaway';
import {
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ResolveRequiredSubscriptionChannelResponse,
} from '@maxim/contracts/settings';
import type { ManagedGiveawayHandoffPayload, UpdateManagedGiveawayPayload } from './shared-types';
import type { ApiTransport } from './transport';

function resolveEntityBase(entityType: 'chat' | 'channel', entityId: string): string {
  return `/${entityType === 'channel' ? 'channels' : 'chats'}/${entityId}`;
}

export async function getManagedGiveaways(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
): Promise<ManagedGiveawaySummary[]> {
  const response = await api.request(`${resolveEntityBase(entityType, entityId)}/giveaways`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid managed giveaways response');
  }

  return response.map((item: unknown) => managedGiveawaySummarySchema.parse(item));
}

export async function createManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  payload: UpdateManagedGiveawayPayload,
): Promise<ManagedGiveawayDetails> {
  const requestBody = updateManagedGiveawayRequestSchema.parse(payload);
  const response = await api.request(`${resolveEntityBase(entityType, entityId)}/giveaways`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedGiveawayDetailsSchema.parse(response);
}

export async function getManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
): Promise<ManagedGiveawayDetails> {
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}`,
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function updateManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
  payload: UpdateManagedGiveawayPayload,
  expectedRevision: number,
): Promise<ManagedGiveawayDetails> {
  const requestBody = updateManagedGiveawayRequestSchema.parse(payload);
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ ...requestBody, expectedRevision }),
    },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function publishManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
  expectedRevision: number,
): Promise<ManagedGiveawayDetails> {
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/publish`,
    { method: 'POST', body: JSON.stringify({ expectedRevision }) },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function refreshManagedGiveawayPublication(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
): Promise<ManagedGiveawayDetails> {
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/refresh-publication`,
    { method: 'POST' },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function closeManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
): Promise<ManagedGiveawayDetails> {
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/close`,
    { method: 'POST' },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function cancelManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
): Promise<ManagedGiveawayDetails> {
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/cancel`,
    { method: 'POST' },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function deleteManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
): Promise<void> {
  await api.request(`${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}`, {
    method: 'DELETE',
  });
}

export async function resolveManagedGiveawayRequiredChannel(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  value: string,
): Promise<ResolveRequiredSubscriptionChannelResponse> {
  const requestBody = resolveRequiredSubscriptionChannelRequestSchema.parse({ value });
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/required-channels/resolve`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return resolveRequiredSubscriptionChannelResponseSchema.parse(response);
}

export async function handoffManagedGiveaway(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  payload: ManagedGiveawayHandoffPayload,
) {
  const requestBody = managedGiveawayHandoffRequestSchema.parse(payload);
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaway/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return broadcastHandoffResponseSchema.parse(response);
}

export async function rerollManagedGiveawayWinner(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
  winnerId: string,
): Promise<ManagedGiveawayDetails> {
  const requestBody = rerollManagedGiveawayWinnerRequestSchema.parse({ winnerId });
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/reroll`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return managedGiveawayDetailsSchema.parse(response);
}

export async function markManagedGiveawayWinnerDelivered(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
  giveawayId: string,
  winnerId: string,
): Promise<ManagedGiveawayDetails> {
  const requestBody = markManagedGiveawayWinnerDeliveredRequestSchema.parse({ winnerId });
  const response = await api.request(
    `${resolveEntityBase(entityType, entityId)}/giveaways/${giveawayId}/deliver`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return managedGiveawayDetailsSchema.parse(response);
}
