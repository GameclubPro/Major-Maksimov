import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { sortAndUniqueBroadcastSlots } from '../../lib/broadcast-schedule';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import { getPublicationOnceSlot, type PublicationDraft } from './publication-model';
import { formatDraftTiming, formatPublicationReviewDate } from './publication-page-formatters';
import './publication-review-timing.css';

export function PublicationReviewTiming({ draft }: { draft: PublicationDraft }) {
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
    return (
      <div className="publication-review-timing">
        {draft.recurrence.startsAt ? (
          <strong>
            С {formatPublicationReviewDate(draft.recurrence.startsAt, timezone, false)}
          </strong>
        ) : null}
        <span>{formatDraftTiming(draft)}</span>
        <span>{formatTimezoneLabel(timezone)}</span>
      </div>
    );
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
