import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';

export class NetworkSettingsPreviewConflict extends Error {}

export function canonicalNetworkValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalNetworkValue).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonicalNetworkValue(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function assertOperationIdentity(
  value: NetworkSettingsOperationResponse,
  operationId: string,
  entityType: string,
  section: string,
  recipients?: string[],
): void {
  if (
    value.operationId !== operationId ||
    value.entityType !== entityType ||
    value.section !== section
  )
    throw new Error('Операция относится к другому разделу.');
  const ids = value.outcomes.map((row) => row.entityId);
  if (
    new Set(ids).size !== ids.length ||
    (recipients && (ids.length !== recipients.length || ids.some((id) => !recipients.includes(id))))
  )
    throw new Error('Получатели операции не совпадают с проверенными.');
}

export function assertNetworkSettingsOperationCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new DOMException('Operation editor changed', 'AbortError');
}
