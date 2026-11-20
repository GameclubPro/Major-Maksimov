import { useRef } from 'react';
import type { PublicationDraft } from './publication-model';
import {
  buildPublicationCreateIdentityStorageKey,
  clearPublicationCreateIdentity,
  readPublicationCreateIdentity,
  writePublicationCreateIdentity,
} from './publication-create-request-storage';
import {
  buildPublicationActionRequestKey,
  buildPublicationAmbiguousRequestKey,
  buildPublicationRetryRequestKey,
  buildPublicationSaveRequestKey,
  buildPublicationTestRequestKey,
  resolvePublicationCreateRequestIdentity,
  resolvePublicationRequestIdentity,
  type PublicationAmbiguousRequestKeyInput,
  type PublicationRequestIdentity,
  type PublicationRequestKey,
  type PublicationRetryRequestKeyInput,
  type PublicationSaveRequestContext,
} from './publication-request-identity';

type PublicationRequestSlot = 'save' | 'test' | 'action' | 'retry' | 'resolve';

export function usePublicationRequestIds() {
  const identitiesRef = useRef<Partial<Record<PublicationRequestSlot, PublicationRequestIdentity>>>(
    {},
  );
  const saveKindRef = useRef<PublicationSaveRequestContext['kind'] | null>(null);
  const createStorageKeyRef = useRef<string | null>(null);

  const resolveRequestId = (slot: PublicationRequestSlot, key: PublicationRequestKey): string => {
    const identity = resolvePublicationRequestIdentity(identitiesRef.current[slot] ?? null, key);
    identitiesRef.current[slot] = identity;
    return identity.requestId;
  };
  const confirmSuccess = (slot: PublicationRequestSlot): void => {
    delete identitiesRef.current[slot];
  };

  return {
    resolveSaveRequestId(
      draft: PublicationDraft,
      context: PublicationSaveRequestContext,
      replaceConflicts: boolean,
      conflictConfirmation?: string,
    ): string {
      const key = buildPublicationSaveRequestKey(
        draft,
        context,
        replaceConflicts,
        conflictConfirmation,
      );
      saveKindRef.current = context.kind;
      if (context.kind !== 'create') {
        return resolveRequestId('save', key);
      }

      const storageKey = buildPublicationCreateIdentityStorageKey();
      const resolved = resolvePublicationCreateRequestIdentity(
        identitiesRef.current.save ?? null,
        key,
        readPublicationCreateIdentity(storageKey),
      );
      identitiesRef.current.save = resolved.identity;
      createStorageKeyRef.current = storageKey;
      writePublicationCreateIdentity(storageKey, resolved.record);
      return resolved.identity.requestId;
    },
    resolveTestRequestId(draft: PublicationDraft): string {
      return resolveRequestId('test', buildPublicationTestRequestKey(draft));
    },
    resolveActionRequestId(
      publicationId: string,
      action: 'cancel' | 'pause' | 'resume',
      expectedRevision: number,
    ): string {
      return resolveRequestId(
        'action',
        buildPublicationActionRequestKey(publicationId, action, expectedRevision),
      );
    },
    resolveRetryRequestId(input: PublicationRetryRequestKeyInput): string {
      return resolveRequestId('retry', buildPublicationRetryRequestKey(input));
    },
    resolveAmbiguousRequestId(input: PublicationAmbiguousRequestKeyInput): string {
      return resolveRequestId('resolve', buildPublicationAmbiguousRequestKey(input));
    },
    confirmSaveSuccess(): void {
      if (saveKindRef.current === 'create' && createStorageKeyRef.current) {
        clearPublicationCreateIdentity(createStorageKeyRef.current);
        createStorageKeyRef.current = null;
      }
      confirmSuccess('save');
      saveKindRef.current = null;
    },
    confirmTestSuccess(): void {
      confirmSuccess('test');
    },
    confirmActionSuccess(): void {
      confirmSuccess('action');
    },
    confirmRetrySuccess(): void {
      confirmSuccess('retry');
    },
    confirmAmbiguousSuccess(): void {
      confirmSuccess('resolve');
    },
  };
}
