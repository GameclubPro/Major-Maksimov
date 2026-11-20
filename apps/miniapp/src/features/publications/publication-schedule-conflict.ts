import { ApiRequestError } from '../../lib/api-request-error';
import {
  getPublicationTargetTitle,
  isPublicationScheduleConflictError,
  type PublicationTarget,
} from './publication-model';

export type PublicationScheduleConflictReview = {
  rows: { target: string; time: string }[];
  count: number;
  confirmation: string | null;
  changed: boolean;
};

export function readPublicationScheduleConflict(
  error: unknown,
  targets: readonly PublicationTarget[],
  timezone: string,
  changed: boolean,
): PublicationScheduleConflictReview | null {
  const payload = error instanceof ApiRequestError ? error.payload : null;
  const manual = payload?.code === 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW';
  if (
    !isPublicationScheduleConflictError(error) &&
    !(manual && Array.isArray(payload?.conflicts))
  ) {
    return null;
  }
  const format = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const titles = new Map(targets.map((target) => [target.id, getPublicationTargetTitle(target)]));
  const rows = (Array.isArray(payload?.conflicts) ? payload.conflicts : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('chatId' in entry) || !('scheduledAt' in entry))
      return [];
    const title = typeof entry.chatId === 'string' ? titles.get(entry.chatId) : undefined;
    const at = typeof entry.scheduledAt === 'string' ? Date.parse(entry.scheduledAt) : NaN;
    return title && Number.isFinite(at) ? [{ target: title, time: format.format(at) }] : [];
  });
  const confirmation = payload?.conflictConfirmation;
  return {
    rows,
    count:
      typeof payload?.conflictCount === 'number'
        ? Math.max(rows.length, payload.conflictCount)
        : rows.length,
    confirmation:
      rows.length &&
      !manual &&
      typeof confirmation === 'string' &&
      /^[a-f0-9]{64}$/u.test(confirmation)
        ? confirmation
        : null,
    changed,
  };
}
