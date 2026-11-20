import { useQuery } from '@tanstack/react-query';
import type { PublicationSchedulePreviewRequest } from '@maxim/contracts/publication';
import { getPublicationSchedulePreview } from '../../lib/api/publication-schedule-preview-client';
import type { ApiTransport } from '../../lib/api/transport';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { sortAndUniqueBroadcastSlots } from '../../lib/broadcast-schedule';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import {
  buildPublicationSchedule,
  getPublicationOnceSlot,
  type PublicationDraft,
} from './publication-model';
import { formatDraftTiming, formatPublicationReviewDate } from './publication-page-formatters';
import type { PublicationSaveRequestContext } from './publication-save-request';
import './publication-review-timing.css';

function PublicationRecurrenceReview({
  api,
  draft,
  context,
}: {
  api: ApiTransport;
  draft: PublicationDraft;
  context: PublicationSaveRequestContext;
}) {
  const schedule = buildPublicationSchedule(draft);
  const editing =
    'publicationId' in context
      ? { publicationId: context.publicationId, expectedRevision: context.expectedRevision }
      : undefined;
  const contentOnly = context.kind === 'edit' && context.contentOnly;
  const request: PublicationSchedulePreviewRequest = {
    editing,
    ...(contentOnly
      ? {}
      : {
          schedule: schedule.mode === 'recurrence' ? schedule : null,
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: draft.targets.map(({ id, entityType }) => ({ chatId: id, entityType })),
          },
        }),
  };
  const preview = useQuery({
    queryKey: ['publications', 'schedule-preview', request],
    queryFn: ({ signal }) => getPublicationSchedulePreview(api, request, signal),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const dates = !preview.isFetching && !preview.isError ? preview.data : null;
  const timezone = dates?.timezone ?? draft.scheduleTimezone;
  const first = dates?.firstOccurrenceAt;
  const last = dates?.lastOccurrenceAt;
  return (
    <div className="publication-review-timing" aria-live="polite">
      {first ? (
        <>
          <span>
            Первый выпуск ·{' '}
            <time dateTime={first}>{formatPublicationReviewDate(first, timezone)}</time>
          </span>
          {last ? (
            <span>
              Последний выпуск ·{' '}
              <time dateTime={last}>{formatPublicationReviewDate(last, timezone)}</time>
            </span>
          ) : null}
        </>
      ) : draft.recurrence.startsAt ? (
        <strong>С {formatPublicationReviewDate(draft.recurrence.startsAt, timezone, false)}</strong>
      ) : null}
      <span>{formatDraftTiming(draft, !editing || dates?.state === 'unbounded')}</span>
      <span>{formatTimezoneLabel(timezone)}</span>
      {dates?.state === 'empty' ? (
        <span>Будущих выпусков нет</span>
      ) : !first ? (
        <span>{preview.isFetching ? 'Рассчитываем даты…' : 'Даты выпусков не рассчитаны'}</span>
      ) : null}
    </div>
  );
}

export function PublicationReviewTiming({
  api,
  draft,
  context,
}: {
  api: ApiTransport;
  draft: PublicationDraft;
  context: PublicationSaveRequestContext;
}) {
  const timezone = draft.scheduleTimezone;
  const formatDate = (instant: string) => formatPublicationReviewDate(instant, timezone);
  if (draft.timingMode === 'now') return <p className="publication-review-timing">Сейчас</p>;
  if (draft.timingMode === 'once') {
    const instant = getPublicationOnceSlot(draft);
    if (!instant) return null;
    return (
      <p className="publication-review-timing">
        <time dateTime={instant}>{formatDate(instant)}</time>
        <span>{formatTimezoneLabel(timezone)}</span>
      </p>
    );
  }
  if (draft.scheduleKind === 'recurrence') {
    return <PublicationRecurrenceReview api={api} draft={draft} context={context} />;
  }
  const [first, ...rest] = sortAndUniqueBroadcastSlots(draft.scheduledSlots);
  if (!first) return null;
  return (
    <div className="publication-review-timing">
      <time dateTime={first}>{formatDate(first)}</time>
      <span>{formatTimezoneLabel(timezone)}</span>
      {rest.length > 0 ? (
        <details>
          <summary>Ещё {formatRussianCountLabel(rest.length, 'дата', 'даты', 'дат')}</summary>
          <ol>
            {rest.map((instant) => (
              <li key={instant}>
                <time dateTime={instant}>{formatDate(instant)}</time>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
