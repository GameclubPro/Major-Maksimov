import type { Dispatch, SetStateAction } from 'react';
import type {
  NetworkSettingsChange,
  NetworkSettingsOperationResponse,
  NetworkSettingsPreviewResponse,
  NetworkSettingsReadResponse,
  NetworkNavigationAllowlistIntent,
} from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../../lib/api/transport';
import {
  applyNetworkSettings,
  previewNetworkSettings,
  readNetworkNavigationAllowlist,
} from '../../lib/api/network-settings-client';
import {
  mergeNetworkSettingsReceipt,
  removeNetworkSettingsOperationReceipt,
  type NetworkSettingsOperationReceipt,
} from '../../lib/network-settings-operation-storage';
import type { NetworkSettingsEditorScope } from '../../lib/network-settings-workspace-state';
import {
  NetworkSettingsPreviewConflict,
  assertOperationIdentity,
  assertNetworkSettingsOperationCurrent,
  canonicalNetworkValue,
} from './network-settings-operation-state';

export interface NetworkSettingsOperationPort {
  api: ApiTransport;
  scope: NetworkSettingsEditorScope;
  isCurrent: () => boolean;
  isGenerationCurrent: () => boolean;
  makeReceipt: (
    operationId: string,
    launchState: NetworkSettingsOperationReceipt['launchState'],
    extra?: Partial<NetworkSettingsOperationReceipt>,
  ) => NetworkSettingsOperationReceipt;
  persistNetworkSettingsOperationReceipt: (
    receipt: NetworkSettingsOperationReceipt,
  ) => Promise<void>;
  readVerifiedNetworkSettingsOperation: (
    api: ApiTransport,
    expected: Pick<NetworkSettingsOperationResponse, 'operationId' | 'entityType' | 'section'> & {
      recipientIds?: string[];
    },
  ) => Promise<NetworkSettingsOperationResponse>;
  mergeNetworkSettingsOperation: (
    previous: NetworkSettingsOperationResponse | null,
    next: NetworkSettingsOperationResponse,
  ) => NetworkSettingsOperationResponse;
  networkSettingsReceiptForStatus: (
    receipt: NetworkSettingsOperationReceipt,
    value: NetworkSettingsOperationResponse,
  ) => NetworkSettingsOperationReceipt;
  setReceipt: Dispatch<SetStateAction<NetworkSettingsOperationReceipt | null>>;
  setPreview: Dispatch<SetStateAction<NetworkSettingsPreviewResponse | null>>;
  setOperation: Dispatch<SetStateAction<NetworkSettingsOperationResponse | null>>;
  setStatusIssue: Dispatch<SetStateAction<boolean>>;
}

export async function prepareNetworkSettingsOperation(input: {
  port: NetworkSettingsOperationPort;
  initial: NetworkSettingsOperationReceipt;
  read: NetworkSettingsReadResponse;
  changes: NetworkSettingsChange[];
  navigationAllowlist?: NetworkNavigationAllowlistIntent;
}): Promise<void> {
  const { port, initial } = input;
  const {
    api,
    scope,
    isCurrent,
    makeReceipt,
    persistNetworkSettingsOperationReceipt,
    readVerifiedNetworkSettingsOperation,
    mergeNetworkSettingsOperation,
    setReceipt,
    setPreview,
    setOperation,
    setStatusIssue,
  } = port;
  const state = {
    read: input.read,
    changes: input.changes,
    navigationAllowlist: input.navigationAllowlist,
  };
  const operationId = initial.operationId;
  await persistNetworkSettingsOperationReceipt(initial);
  if (!isCurrent()) return;
  let recipients = state.read.recipients;
  if (state.navigationAllowlist) {
    const requestId = crypto.randomUUID();
    const observed: typeof recipients = [];
    for (const recipient of recipients) {
      const result = await readNetworkNavigationAllowlist(api, {
        entityType: scope.entityType,
        target: scope.target,
        section: scope.initialSection,
        compositionVersion: state.read.compositionVersion,
        requestId,
        entityId: recipient.entityId,
        includeEntries: false,
      });
      if (!isCurrent()) return;
      if (
        result.entityId !== recipient.entityId ||
        result.compositionVersion !== state.read.compositionVersion
      )
        throw new Error('Список другого получателя. Загрузите состав заново.');
      observed.push({ ...recipient, navigationAllowlistWitness: result.witness });
    }
    recipients = observed;
  }
  const result = await previewNetworkSettings(
    api,
    {
      entityType: scope.entityType,
      target: scope.target,
      section: scope.initialSection,
      operationId,
      compositionVersion: state.read.compositionVersion,
      recipients,
      changes: state.changes,
      ...(state.navigationAllowlist ? { navigationAllowlist: state.navigationAllowlist } : {}),
    },
    () => assertNetworkSettingsOperationCurrent(isCurrent),
  ).catch(async (error: unknown) => {
    const { ApiRequestError } = await import('../../lib/api-request-error');
    // FLAG: This rejection belongs only to preview. A dispatched apply always keeps its receipt.
    if (
      error instanceof ApiRequestError &&
      error.status === 409 &&
      error.code === 'NETWORK_SETTINGS_CHANGED'
    ) {
      await removeNetworkSettingsOperationReceipt(initial.userId, operationId, {
        unconfirmedOnly: true,
      });
      throw new NetworkSettingsPreviewConflict(error.message);
    }
    throw error;
  });
  if (!isCurrent()) return;
  if (
    result.operationId !== operationId ||
    result.entityType !== scope.entityType ||
    result.section !== scope.initialSection ||
    canonicalNetworkValue(result.changes) !== canonicalNetworkValue(state.changes) ||
    canonicalNetworkValue(result.recipients) !== canonicalNetworkValue(recipients) ||
    canonicalNetworkValue(result.navigationAllowlist) !==
      canonicalNetworkValue(state.navigationAllowlist)
  )
    throw new Error('Предпросмотр не совпадает с выбранными изменениями.');
  const saved = makeReceipt(operationId, 'unconfirmed', {
    recipientIds: recipients.map((row) => row.entityId),
    previewHash: result.previewHash,
    expiresAt: result.expiresAt,
    lastKnownStatus: result.status,
  });
  await persistNetworkSettingsOperationReceipt(saved);
  if (!isCurrent()) return;
  setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, saved));
  setPreview(result);
  const status = await readVerifiedNetworkSettingsOperation(api, {
    operationId,
    entityType: scope.entityType,
    section: scope.initialSection,
    recipientIds: recipients.map((row) => row.entityId),
  });
  if (!isCurrent()) return;
  setOperation((previous) => mergeNetworkSettingsOperation(previous, status));
  setStatusIssue(false);
}

export async function applyNetworkSettingsOperation(input: {
  port: NetworkSettingsOperationPort;
  reviewed: NetworkSettingsPreviewResponse;
  operation: NetworkSettingsOperationResponse;
}): Promise<void> {
  const { port, reviewed } = input;
  const {
    api,
    scope,
    isCurrent,
    isGenerationCurrent,
    makeReceipt,
    persistNetworkSettingsOperationReceipt,
    mergeNetworkSettingsOperation,
    networkSettingsReceiptForStatus,
    setReceipt,
    setOperation,
  } = port;
  const state = { operation: input.operation };
  // FLAG: An exact, durably readable launching receipt precedes the only apply request.
  const launching = makeReceipt(reviewed.operationId, 'launching', {
    recipientIds: reviewed.recipients.map((row) => row.entityId),
    previewHash: reviewed.previewHash,
    expiresAt: state.operation.expiresAt,
    lastKnownStatus: state.operation.status,
  });
  await persistNetworkSettingsOperationReceipt(launching);
  setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, launching));
  if (!isCurrent()) return;
  const result = await applyNetworkSettings(
    api,
    {
      operationId: reviewed.operationId,
      previewHash: reviewed.previewHash,
    },
    () => assertNetworkSettingsOperationCurrent(isCurrent),
  );
  if (!isGenerationCurrent()) return;
  assertOperationIdentity(
    result,
    reviewed.operationId,
    scope.entityType,
    scope.initialSection,
    reviewed.recipients.map((row) => row.entityId),
  );
  const submitted = networkSettingsReceiptForStatus(
    makeReceipt(reviewed.operationId, 'submitted', {
      recipientIds: reviewed.recipients.map((row) => row.entityId),
      previewHash: reviewed.previewHash,
      expiresAt: result.expiresAt,
    }),
    result,
  );
  setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, submitted));
  setOperation((previous) => mergeNetworkSettingsOperation(previous, result));
  await persistNetworkSettingsOperationReceipt(submitted);
}
