import type { ApiTransport } from '../../lib/api/transport';
import { createPublication, updatePublication } from '../../lib/api/publication-client';
import {
  buildCreatePublicationRequest,
  buildUpdatePublicationRequest,
  type PublicationDraft,
  type PublicationEditorContext,
  type PublicationEditScope,
} from './publication-model';

export type PublicationSaveRequestContext =
  | { kind: 'create' | 'duplicate' }
  | {
      kind: 'edit' | 'import' | 'draft';
      publicationId: string;
      expectedRevision: number;
      sessionId?: string | null;
      editScope?: PublicationEditScope | null;
      contentOnly?: boolean;
    };

export function resolvePublicationSaveRequestContext(
  draft: PublicationDraft,
  editorContext: PublicationEditorContext | null,
  preserveSavedSchedule: boolean,
): PublicationSaveRequestContext {
  if (draft.cloudDraft) {
    return {
      kind: 'draft',
      publicationId: draft.cloudDraft.id,
      expectedRevision: draft.cloudDraft.revision,
    };
  }
  return editorContext?.kind === 'edit'
    ? { ...editorContext, contentOnly: preserveSavedSchedule }
    : (editorContext ?? { kind: 'create' });
}

export function buildPublicationSaveRequest(
  draft: PublicationDraft,
  context: PublicationSaveRequestContext,
  requestId: string,
  replaceConflicts: boolean,
  conflictConfirmation?: string,
) {
  function includeConfirmation<
    T extends { schedule?: ReturnType<typeof buildCreatePublicationRequest>['schedule'] },
  >(payload: T): T {
    if (!conflictConfirmation || !payload.schedule || payload.schedule.mode === 'now')
      return payload;
    return { ...payload, schedule: { ...payload.schedule, conflictConfirmation } };
  }
  if (context.kind === 'edit' || context.kind === 'import' || context.kind === 'draft') {
    return {
      operation: 'update' as const,
      publicationId: context.publicationId,
      payload: includeConfirmation(
        buildUpdatePublicationRequest(
          draft,
          context.expectedRevision,
          requestId,
          replaceConflicts,
          context.kind === 'edit' &&
            (context.editScope === 'retry' || context.contentOnly === true),
        ),
      ),
    };
  }
  return {
    operation: 'create' as const,
    payload: includeConfirmation(
      buildCreatePublicationRequest(draft, requestId, { replaceConflicts }),
    ),
  };
}

export function preparePublicationSave(
  api: ApiTransport,
  draft: PublicationDraft,
  context: PublicationSaveRequestContext,
  requestId: string,
  replaceConflicts: boolean,
  conflictConfirmation?: string,
) {
  // FLAG: Access refresh retries must reuse the exact payload and request ID prepared here.
  const request = buildPublicationSaveRequest(
    draft,
    context,
    requestId,
    replaceConflicts,
    conflictConfirmation,
  );
  return () =>
    request.operation === 'update'
      ? updatePublication(api, request.publicationId, request.payload)
      : createPublication(api, request.payload);
}
