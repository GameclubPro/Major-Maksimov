import type { PublicationDraft } from './publication-model';
import { buildTestPublicationRequest } from './publication-model';
import {
  buildPublicationSaveRequest,
  type PublicationSaveRequestContext,
} from './publication-save-request';
export type { PublicationSaveRequestContext } from './publication-save-request';

export type PublicationRetryRequestKeyInput =
  | { publicationId: string; occurrenceId: string; contentMode: 'original' }
  | {
      publicationId: string;
      occurrenceId: string;
      contentMode: 'latest';
      expectedPublicationVersion: number;
      expectedContentRevision: number;
    };

export type PublicationAmbiguousRequestKeyInput = {
  publicationId: string;
  occurrenceId: string;
  deliveryId: string;
  resolution: 'mark_sent' | 'mark_failed';
};

export type PublicationRequestKey =
  | null
  | string
  | number
  | boolean
  | readonly PublicationRequestKey[]
  | { readonly [key: string]: PublicationRequestKey };

export type PublicationRequestIdentity = Readonly<{
  key: PublicationRequestKey;
  requestId: string;
}>;

export type PublicationCreateIdentityRecord = Readonly<{
  requestId: string;
  fingerprint: string;
}>;

export const PUBLICATION_TEST_RESULT_PENDING_FEEDBACK = Object.freeze({
  tone: 'info' as const,
  title: 'Тест мог быть отправлен',
  description: 'Проверьте личный диалог с ботом перед повтором.',
  durationMs: 6_000,
});

const PUBLICATION_TEST_RESULT_PENDING_CODE = 'BROADCAST_TEST_RESULT_PENDING';
const REQUEST_KEY_PLACEHOLDER = 'publication_request_key';

function snapshotRequestValue(value: unknown): PublicationRequestKey | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => snapshotRequestValue(item) ?? null));
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const snapshot: Record<string, PublicationRequestKey> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = snapshotRequestValue(item);
    if (next !== undefined) {
      snapshot[key] = next;
    }
  }
  return Object.freeze(snapshot);
}

function createRequestKey(value: Record<string, unknown>): PublicationRequestKey {
  return snapshotRequestValue(value) ?? Object.freeze({});
}

function withoutRequestId<T extends { requestId: string }>(request: T): Omit<T, 'requestId'> {
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'requestId')) as Omit<
    T,
    'requestId'
  >;
}

export function buildPublicationSaveRequestKey(
  draft: PublicationDraft,
  context: PublicationSaveRequestContext,
  replaceConflicts: boolean,
  conflictConfirmation?: string,
): PublicationRequestKey {
  const request = buildPublicationSaveRequest(
    draft,
    context,
    REQUEST_KEY_PLACEHOLDER,
    replaceConflicts,
    conflictConfirmation,
  );

  return createRequestKey({
    operation: request.operation,
    context,
    replaceConflicts,
    payload: withoutRequestId(request.payload),
  });
}

export function buildPublicationTestRequestKey(draft: PublicationDraft): PublicationRequestKey {
  return createRequestKey({
    operation: 'test',
    payload: withoutRequestId(buildTestPublicationRequest(draft, REQUEST_KEY_PLACEHOLDER)),
  });
}

export function buildPublicationActionRequestKey(
  publicationId: string,
  action: 'cancel' | 'pause' | 'resume',
  expectedRevision: number,
): PublicationRequestKey {
  return createRequestKey({
    operation: action,
    publicationId,
    payload: { expectedRevision },
  });
}

export function buildPublicationRetryRequestKey(
  input: PublicationRetryRequestKeyInput,
): PublicationRequestKey {
  return createRequestKey({
    operation: 'retry',
    publicationId: input.publicationId,
    occurrenceId: input.occurrenceId,
    payload:
      input.contentMode === 'latest'
        ? {
            contentMode: input.contentMode,
            expectedPublicationVersion: input.expectedPublicationVersion,
            expectedContentRevision: input.expectedContentRevision,
          }
        : { contentMode: input.contentMode },
  });
}

export function buildPublicationAmbiguousRequestKey(
  input: PublicationAmbiguousRequestKeyInput,
): PublicationRequestKey {
  return createRequestKey({
    operation: 'resolve_ambiguous',
    publicationId: input.publicationId,
    occurrenceId: input.occurrenceId,
    payload: {
      deliveryId: input.deliveryId,
      resolution: input.resolution,
    },
  });
}

export function arePublicationRequestKeysEqual(
  left: PublicationRequestKey,
  right: PublicationRequestKey,
): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => arePublicationRequestKeysEqual(item, right[index] ?? null))
    );
  }

  const leftRecord = left as { readonly [key: string]: PublicationRequestKey };
  const rightRecord = right as { readonly [key: string]: PublicationRequestKey };
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        arePublicationRequestKeysEqual(leftRecord[key] ?? null, rightRecord[key] ?? null),
    )
  );
}

function updateFingerprintHash(state: number[], value: string): void {
  const primes = [0x01000193, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < state.length; hashIndex += 1) {
      state[hashIndex] = Math.imul((state[hashIndex] ?? 0) ^ code, primes[hashIndex] ?? 1);
    }
  }
}

function visitRequestKeyForFingerprint(state: number[], value: PublicationRequestKey): void {
  if (value === null) {
    updateFingerprintHash(state, 'n;');
    return;
  }
  if (typeof value === 'string') {
    updateFingerprintHash(state, `s${value.length}:`);
    updateFingerprintHash(state, value);
    return;
  }
  if (typeof value === 'number') {
    updateFingerprintHash(state, `d${String(value)};`);
    return;
  }
  if (typeof value === 'boolean') {
    updateFingerprintHash(state, value ? 'b1;' : 'b0;');
    return;
  }
  if (Array.isArray(value)) {
    updateFingerprintHash(state, `a${value.length}[`);
    value.forEach((item) => visitRequestKeyForFingerprint(state, item));
    updateFingerprintHash(state, ']');
    return;
  }

  const record = value as { readonly [key: string]: PublicationRequestKey };
  const keys = Object.keys(record).sort();
  updateFingerprintHash(state, `o${keys.length}{`);
  keys.forEach((key) => {
    updateFingerprintHash(state, `k${key.length}:`);
    updateFingerprintHash(state, key);
    visitRequestKeyForFingerprint(state, record[key] ?? null);
  });
  updateFingerprintHash(state, '}');
}

function finalizeFingerprintHash(value: number): string {
  let hash = value;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function fingerprintPublicationRequestKey(key: PublicationRequestKey): string {
  const state = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  visitRequestKeyForFingerprint(state, key);
  return `v1:${state.map(finalizeFingerprintHash).join('')}`;
}

export function createPublicationRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/gu, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export function resolvePublicationRequestIdentity(
  current: PublicationRequestIdentity | null,
  key: PublicationRequestKey,
  createRequestId: () => string = createPublicationRequestId,
): PublicationRequestIdentity {
  if (current && arePublicationRequestKeysEqual(current.key, key)) {
    return current;
  }
  return Object.freeze({ key, requestId: createRequestId() });
}

export function resolvePublicationCreateRequestIdentity(
  current: PublicationRequestIdentity | null,
  key: PublicationRequestKey,
  persisted: PublicationCreateIdentityRecord | null,
  createRequestId: () => string = createPublicationRequestId,
): { identity: PublicationRequestIdentity; record: PublicationCreateIdentityRecord } {
  const fingerprint = fingerprintPublicationRequestKey(key);
  const identity =
    current && arePublicationRequestKeysEqual(current.key, key)
      ? current
      : persisted?.fingerprint === fingerprint
        ? Object.freeze({ key, requestId: persisted.requestId })
        : resolvePublicationRequestIdentity(null, key, createRequestId);
  return {
    identity,
    record: Object.freeze({ requestId: identity.requestId, fingerprint }),
  };
}

export function isPublicationTestResultPendingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === PUBLICATION_TEST_RESULT_PENDING_CODE,
  );
}
