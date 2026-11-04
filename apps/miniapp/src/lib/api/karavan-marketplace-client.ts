import { z } from 'zod';
import {
  karavanPublicationChoiceSchema,
  karavanPublicationChoiceSavedSchema,
  karavanMarketplaceAvailableSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceModuleSchema,
  karavanMarketplaceOperationSchema,
  karavanMarketplaceSetupOptionsSchema,
  karavanMarketplacePreviewSchema,
  karavanMarketplacePreviewInputSchema,
  type KaravanMarketplaceSetup,
  type KaravanMarketplaceHandoffDestination,
} from '@maxim/contracts/karavan-marketplace';
import {
  karavanConnectionBindingInputSchema,
  karavanConnectionBindingOperationSchema,
  karavanConnectionSnapshotSchema,
  type KaravanConnectionBindingInput,
} from '@maxim/contracts/karavan-marketplace-connection';
import type { ApiTransport } from './transport';
const moduleSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  karavanMarketplaceModuleSchema.extend({
    enabled: z.literal(true),
    actorMaxUserId: z.string(),
    sellerBotUrl: z.string().url(),
    setupOperation: karavanMarketplaceOperationSchema.nullable(),
    connection: karavanConnectionSnapshotSchema.optional(),
    publicationChoices: z.array(karavanPublicationChoiceSchema).max(20).optional().default([]),
  }),
]);
const path = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/karavan-marketplace`;
export async function getKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  signal?: AbortSignal,
) {
  return moduleSchema.parse(await api.request(path(chatId), { signal }));
}
export async function setupKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  input: KaravanMarketplaceSetup,
) {
  return karavanMarketplaceOperationSchema.parse(
    await api.request(`${path(chatId)}/setup`, {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs: 180_000,
      retryMutationOnTransportError: false,
    }),
  );
}
export async function getKaravanMarketplaceSetupOptions(
  api: ApiTransport,
  chatId: string,
  signal?: AbortSignal,
) {
  return karavanMarketplaceSetupOptionsSchema.parse(
    await api.request(`${path(chatId)}/setup-options`, { signal }),
  );
}
export async function previewKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  input: z.infer<typeof karavanMarketplacePreviewInputSchema>,
) {
  return karavanMarketplacePreviewSchema.parse(
    await api.request(`${path(chatId)}/preview`, {
      method: 'POST',
      body: JSON.stringify(karavanMarketplacePreviewInputSchema.parse(input)),
      retryMutationOnTransportError: false,
      timeoutMs: 180_000,
    }),
  );
}
export async function getKaravanMarketplaceOperation(
  api: ApiTransport,
  chatId: string,
  operationId: string,
) {
  return karavanMarketplaceOperationSchema.parse(
    await api.request(`${path(chatId)}/operations/${encodeURIComponent(operationId)}`),
  );
}
export async function openKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  marketplaceId: string,
  destination: KaravanMarketplaceHandoffDestination,
) {
  return z.object({ url: z.string().url(), expiresAt: z.string().datetime() }).parse(
    await api.request(`${path(chatId)}/handoffs`, {
      method: 'POST',
      body: JSON.stringify({ commandId: crypto.randomUUID(), marketplaceId, destination }),
      retryMutationOnTransportError: false,
    }),
  );
}

export async function getAvailableKaravanMarketplaces(
  api: ApiTransport,
  chatId: string,
  cursor: string | null,
) {
  return karavanMarketplaceAvailableSchema.parse(
    await api.request(
      `${path(chatId)}/available${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  );
}
export const karavanChatBindingInputSchema = z
  .object({
    marketplaceId: z.string().uuid(),
    commandId: z.string().uuid(),
    expectedBindingGeneration: z.number().int().positive().nullable(),
    action: z.enum(['bind_chat', 'unbind_chat', 'recover_chat', 'transfer_chat']),
  })
  .strict();
export type KaravanChatBindingInput = z.infer<typeof karavanChatBindingInputSchema>;
export async function changeKaravanChatBinding(
  api: ApiTransport,
  chatId: string,
  input: KaravanChatBindingInput,
) {
  const { marketplaceId, ...payload } = karavanChatBindingInputSchema.parse(input);
  return karavanMarketplaceBindingResultSchema.parse(
    await api.request(`${path(chatId)}/bindings/${encodeURIComponent(marketplaceId)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      retryMutationOnTransportError: false,
    }),
  );
}

export async function getKaravanConnection(
  api: ApiTransport,
  chatId: string,
  signal?: AbortSignal,
) {
  return karavanConnectionSnapshotSchema.parse(
    await api.request(`${path(chatId)}/connection`, { signal }),
  );
}

function bindingOperation(
  value: unknown,
  commandId: string,
  input?: KaravanConnectionBindingInput,
) {
  const operation = karavanConnectionBindingOperationSchema.parse(value);
  if (
    operation.operationId !== commandId ||
    operation.request.commandId !== commandId ||
    (input && JSON.stringify(operation.request) !== JSON.stringify(input))
  )
    throw new Error('Сохранённое подключение изменилось. Обновите состояние магазина.');
  return operation;
}

async function admitKaravanBinding(
  api: ApiTransport,
  chatId: string,
  input: KaravanConnectionBindingInput,
  action: 'binding' | 'import-binding',
) {
  const request = karavanConnectionBindingInputSchema.parse(input);
  return bindingOperation(
    await api.request(`${path(chatId)}/connection/${action}`, {
      method: 'POST',
      body: JSON.stringify(request),
      retryMutationOnTransportError: false,
      timeoutMs: 180_000,
    }),
    request.commandId,
    request,
  );
}

export function startKaravanBinding(
  api: ApiTransport,
  chatId: string,
  input: KaravanConnectionBindingInput,
) {
  return admitKaravanBinding(api, chatId, input, 'binding');
}

export function importKaravanBinding(
  api: ApiTransport,
  chatId: string,
  input: KaravanConnectionBindingInput,
) {
  return admitKaravanBinding(api, chatId, input, 'import-binding');
}

export async function getKaravanBindingOperation(
  api: ApiTransport,
  chatId: string,
  operationId: string,
) {
  return bindingOperation(
    await api.request(`${path(chatId)}/connection/operations/${encodeURIComponent(operationId)}`),
    operationId,
  );
}

export async function resumeKaravanBinding(api: ApiTransport, chatId: string, operationId: string) {
  return bindingOperation(
    await api.request(
      `${path(chatId)}/connection/operations/${encodeURIComponent(operationId)}/resume`,
      { method: 'POST', retryMutationOnTransportError: false, timeoutMs: 180_000 },
    ),
    operationId,
  );
}

export async function saveKaravanPublicationChoice(
  api: ApiTransport,
  chatId: string,
  input: { choiceId: string; storeId: string },
) {
  return karavanPublicationChoiceSavedSchema.parse(
    await api.request(`${path(chatId)}/publication-choice`, {
      method: 'POST',
      body: JSON.stringify(input),
      retryMutationOnTransportError: false,
    }),
  );
}

export async function cancelKaravanMarketplaceSetup(
  api: ApiTransport,
  chatId: string,
  operationId: string,
) {
  return karavanMarketplaceOperationSchema.parse(
    await api.request(`${path(chatId)}/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: 'POST',
      body: '{}',
      retryMutationOnTransportError: false,
    }),
  );
}
