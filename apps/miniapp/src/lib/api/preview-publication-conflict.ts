import type {
  CreatePublicationRequest,
  PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { ApiRequestError } from '../api-request-error';
import type { PreviewState } from './preview-transport-state';

const previewConflictReviews = new WeakMap<PreviewState, { key: string; confirmation: string }>();

export function confirmPreviewCalendarReplacement(
  state: PreviewState,
  request: Pick<CreatePublicationRequest, 'audience' | 'schedule' | 'intent'>,
  excludedPublicationId: string | null,
  buildSlots: (schedule: PublicationScheduleInput, now: Date) => string[],
  readClock: () => Date,
  syncPublication: (id: string) => void,
): void {
  if (request.intent !== 'publish' || !request.schedule || request.schedule.mode === 'now') {
    return;
  }
  const incomingSlots = new Set(
    buildSlots(request.schedule, readClock()).map((slot) => Date.parse(slot)),
  );
  const incomingTargets = new Set(
    request.audience.targets.map((target) => `${target.entityType}:${target.chatId}`),
  );
  const conflicts = state.publications.flatMap((publication) => {
    if (
      publication.id === excludedPublicationId ||
      publication.lifecycle === 'COMPLETED' ||
      publication.lifecycle === 'CANCELED'
    ) {
      return [];
    }
    const targets = publication.targets.filter((target) =>
      incomingTargets.has(`${target.entityType}:${target.chatId}`),
    );
    if (!targets.length) return [];
    return publication.occurrences
      .filter(
        (occurrence) =>
          (occurrence.status === 'SCHEDULED' || occurrence.status === 'IN_PROGRESS') &&
          incomingSlots.has(Date.parse(occurrence.scheduledAt)),
      )
      .map((occurrence) => ({ publication, occurrence, targets }));
  });
  if (!conflicts.length) return;
  const key = JSON.stringify(
    conflicts.map(({ publication, occurrence }) => [
      publication.id,
      publication.version,
      occurrence.id,
      occurrence.scheduledAt,
      occurrence.status,
    ]),
  );
  let review = previewConflictReviews.get(state);
  if (!review || review.key !== key) {
    review = { key, confirmation: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '') };
    previewConflictReviews.set(state, review);
  }
  const requiresManualReview = conflicts.some(
    ({ publication, occurrence, targets }) =>
      occurrence.status === 'IN_PROGRESS' || targets.length !== publication.targets.length,
  );
  const details = [
    ...new Map(
      conflicts.flatMap(({ occurrence, targets }) =>
        targets.map(
          (target) =>
            [
              JSON.stringify([target.chatId, occurrence.scheduledAt]),
              { chatId: target.chatId, scheduledAt: occurrence.scheduledAt },
            ] as const,
        ),
      ),
    ).values(),
  ];
  if (
    requiresManualReview ||
    !request.schedule.replaceConflicts ||
    request.schedule.conflictConfirmation !== review.confirmation
  ) {
    const message = 'В выбранное время уже запланирована публикация.';
    throw new ApiRequestError(
      409,
      JSON.stringify({
        code: requiresManualReview
          ? 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW'
          : 'PUBLICATION_SCHEDULE_CONFLICT',
        message,
        conflicts: details.slice(0, 20),
        conflictCount: details.length,
        conflictConfirmation: requiresManualReview ? undefined : review.confirmation,
      }),
      message,
    );
  }
  const ids = new Set(conflicts.map(({ occurrence }) => occurrence.id));
  for (const { occurrence } of conflicts) occurrence.status = 'CANCELED';
  for (const delivery of state.publicationDeliveries) {
    if (ids.has(delivery.occurrenceId) && delivery.status === 'PENDING')
      delivery.status = 'CANCELED';
  }
  for (const publicationId of new Set(conflicts.map(({ publication }) => publication.id))) {
    syncPublication(publicationId);
  }
  previewConflictReviews.delete(state);
}
