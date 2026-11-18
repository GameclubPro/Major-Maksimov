import type { z } from 'zod';
import {
  networkSettingsReadResponseSchema,
  networkSettingsReadRequestSchema,
  networkNavigationAllowlistReadRequestSchema,
  networkNavigationAllowlistReadResponseSchema,
} from '@maxim/contracts/network-settings-read';
import type {
  networkSettingsRequiredSubscriptionResolveRequestSchema,
  networkSettingsAdminContactsReadRequestSchema,
  networkSettingsAdminContactsResolveRequestSchema,
} from '@maxim/contracts/network-settings-metadata';
import type {
  NetworkSettingsReadRequest,
  NetworkSettingsPreviewRequest,
  NetworkSettingsApplyRequest,
} from '@maxim/contracts/network-settings';
import type { ApiTransport } from './transport';
const post = (api: ApiTransport, path: string, body: unknown, signal?: AbortSignal) =>
  api.request('/networks/settings/' + path, {
    method: 'POST',
    body: JSON.stringify(body),
    retryMutationOnTransportError: false,
    signal,
  });
export async function readNetworkSettingsPage(
  api: ApiTransport,
  input: NetworkSettingsReadRequest,
  signal?: AbortSignal,
) {
  return networkSettingsReadResponseSchema.parse(
    await post(api, 'read?paging=adaptive', networkSettingsReadRequestSchema.parse(input), signal),
  );
}
export async function previewNetworkSettings(
  api: ApiTransport,
  input: NetworkSettingsPreviewRequest,
  assertDispatchCurrent?: () => void,
) {
  const { networkSettingsPreviewRequestSchema, networkSettingsPreviewResponseSchema } =
    await import('@maxim/contracts/network-settings-actions');
  assertDispatchCurrent?.();
  return networkSettingsPreviewResponseSchema.parse(
    await post(api, 'preview', networkSettingsPreviewRequestSchema.parse(input)),
  );
}
export async function applyNetworkSettings(
  api: ApiTransport,
  input: NetworkSettingsApplyRequest,
  assertDispatchCurrent?: () => void,
) {
  const { networkSettingsApplyRequestSchema, networkSettingsOperationResponseSchema } =
    await import('@maxim/contracts/network-settings-actions');
  assertDispatchCurrent?.();
  return networkSettingsOperationResponseSchema.parse(
    await post(api, 'apply', networkSettingsApplyRequestSchema.parse(input)),
  );
}
export async function getNetworkSettingsOperation(api: ApiTransport, operationId: string) {
  const { networkSettingsOperationResponseSchema } =
    await import('@maxim/contracts/network-settings-actions');
  return networkSettingsOperationResponseSchema.parse(
    await api.request('/networks/settings/operations/' + encodeURIComponent(operationId)),
  );
}

export async function resolveNetworkRequiredSubscription(
  api: ApiTransport,
  input: z.input<typeof networkSettingsRequiredSubscriptionResolveRequestSchema>,
) {
  const {
    networkSettingsRequiredSubscriptionResolveRequestSchema,
    networkSettingsRequiredSubscriptionResolveResponseSchema,
  } = await import('@maxim/contracts/network-settings-metadata');
  return networkSettingsRequiredSubscriptionResolveResponseSchema.parse(
    await post(
      api,
      'required-subscription/resolve',
      networkSettingsRequiredSubscriptionResolveRequestSchema.parse(input),
    ),
  );
}
export async function readNetworkAdminContacts(
  api: ApiTransport,
  input: z.input<typeof networkSettingsAdminContactsReadRequestSchema>,
) {
  const {
    networkSettingsAdminContactsReadRequestSchema,
    networkSettingsAdminContactsResponseSchema,
  } = await import('@maxim/contracts/network-settings-metadata');
  return networkSettingsAdminContactsResponseSchema.parse(
    await post(
      api,
      'admin-contacts/read',
      networkSettingsAdminContactsReadRequestSchema.parse(input),
    ),
  );
}
export async function resolveNetworkAdminContact(
  api: ApiTransport,
  input: z.input<typeof networkSettingsAdminContactsResolveRequestSchema>,
) {
  const {
    networkSettingsAdminContactsResolveRequestSchema,
    networkSettingsAdminContactResolveResponseSchema,
  } = await import('@maxim/contracts/network-settings-metadata');
  return networkSettingsAdminContactResolveResponseSchema.parse(
    await post(
      api,
      'admin-contacts/resolve',
      networkSettingsAdminContactsResolveRequestSchema.parse(input),
    ),
  );
}
export async function readNetworkNavigationAllowlist(
  api: ApiTransport,
  input: z.input<typeof networkNavigationAllowlistReadRequestSchema>,
) {
  return networkNavigationAllowlistReadResponseSchema.parse(
    await post(
      api,
      'navigation-allowlist/read',
      networkNavigationAllowlistReadRequestSchema.parse(input),
    ),
  );
}
