import type {
  PublicationDraftResponse,
  PublicationDraftState,
  SavePublicationDraftRequest,
} from '@maxim/contracts/publication-draft';
import {
  buildPublicationContent,
  createPublicationDraftFromDetails,
  type PublicationDraft,
  type PublicationRetainedAsset,
} from './publication-model';
import {
  hasBroadcastLinkButtonErrors,
  validateBroadcastLinkButtons,
} from '../../lib/broadcast-link-buttons';

export type PublicationCloudIdentity = { id: string; revision: number };

export function publicationDraftState(draft: PublicationDraft): PublicationDraftState {
  return {
    formatVersion: 1,
    timingMode: draft.timingMode,
    scheduleKind: draft.scheduleKind,
    scheduleTimezone: draft.scheduleTimezone,
    latePolicy: draft.latePolicy,
    scheduledSlots: draft.scheduledSlots,
    onceDate: draft.onceDate,
    onceTime: draft.onceTime,
    recurrence: draft.recurrence,
    buttons: draft.buttons,
    buttonEnabled: draft.buttonEnabled,
  };
}

export function serverDraftRequest(
  draft: PublicationDraft,
  requestId: string,
  revision?: number,
): SavePublicationDraftRequest {
  return {
    requestId,
    ...(revision ? { expectedRevision: revision } : {}),
    title: draft.title,
    content: {
      ...buildPublicationContent(draft),
      text: draft.text,
      ...(hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(draft.buttons))
        ? { buttons: [] }
        : {}),
    },
    targets: draft.targets.map((target) => ({ chatId: target.id, entityType: target.entityType })),
    state: publicationDraftState(draft),
  };
}

export function draftFromServer(response: PublicationDraftResponse): PublicationDraft {
  const draft = createPublicationDraftFromDetails(response.publication);
  return {
    ...draft,
    ...(response.state ?? {}),
    cloudDraft: { id: response.publication.id, revision: response.publication.version },
  };
}

export function samePublicationDraftMedia(
  left: PublicationDraft,
  right: PublicationDraft,
): boolean {
  return (
    (left.images === right.images || (!left.images.length && !right.images.length)) &&
    (left.retainedAssets === right.retainedAssets ||
      (!left.retainedAssets.length && !right.retainedAssets.length)) &&
    left.mediaType === right.mediaType &&
    left.mediaBase64 === right.mediaBase64 &&
    left.mediaPayload === right.mediaPayload &&
    left.mediaFileName === right.mediaFileName &&
    left.mediaMimeType === right.mediaMimeType
  );
}

export function withSavedPublicationMedia(
  draft: PublicationDraft,
  assets: PublicationRetainedAsset[],
): PublicationDraft {
  return {
    ...draft,
    images: [],
    mediaType: null,
    mediaBase64: '',
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    retainedAssets: assets,
  };
}

export function publicationDraftTextFingerprint(draft: PublicationDraft): string {
  return JSON.stringify({
    title: draft.title,
    text: draft.text,
    textFormat: draft.textFormat,
    buttons: draft.buttonEnabled ? draft.buttons : [],
    targets: draft.targets.map(({ id, entityType }) => ({ id, entityType })),
    postPublish: draft.postPublish,
    state: publicationDraftState(draft),
  });
}
