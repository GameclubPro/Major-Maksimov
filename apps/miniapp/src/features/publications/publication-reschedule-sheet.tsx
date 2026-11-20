import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PublicationDetails,
  PublicationOccurrenceRescheduleRequest,
  PublicationOccurrenceSummary,
} from '@maxim/contracts/publication';
import { publicationOccurrenceRescheduleRequestSchema } from '@maxim/contracts/publication';
import { Suspense, lazy, useRef, useState } from 'react';
import { DateField } from '../../components/ui/date-field';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { ApiRequestError } from '../../lib/api-request-error';
import { reschedulePublicationOccurrence } from '../../lib/api/publication-client';
import type { ApiTransport } from '../../lib/api/transport';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  PUBLICATION_MIN_SCHEDULE_DELAY_MS,
  buildPublicationSchedule,
  createPublicationDraftFromDetails,
  type PublicationDraft,
} from './publication-model';
import { formatPublicationReviewDate, getRecurrenceError } from './publication-page-formatters';
import { createPublicationRequestId } from './publication-request-identity';
import { parsePublicationScheduleField } from './publication-schedule-fields';
import { formatPublicationScheduleField } from './publication-time-presentation';
import { PublicationOnceFields } from './publication-zoned-fields';
import './publication-reschedule-sheet.css';

const LazyRecurrenceFields = lazy(() =>
  import('./publication-recurrence-fields').then((module) => ({
    default: module.PublicationRecurrenceFields,
  })),
);

function canMoveOccurrence(details: PublicationDetails, occurrence: PublicationOccurrenceSummary) {
  return (
    details.access?.canManageAllTargets !== false &&
    details.lifecycle === 'ACTIVE' &&
    details.schedule?.mode === 'recurrence' &&
    details.schedule.status === 'ACTIVE' &&
    occurrence.status === 'SCHEDULED' &&
    occurrence.delivery.total === 0 &&
    Date.parse(occurrence.scheduledAt) > Date.now()
  );
}

export function PublicationRescheduleSheet({
  api,
  details,
  occurrence,
  onClose,
  onOpenPublication,
}: {
  api: ApiTransport;
  details: PublicationDetails;
  occurrence: PublicationOccurrenceSummary;
  onClose: () => void;
  onOpenPublication: (publication: PublicationDetails) => void;
}) {
  const client = useQueryClient();
  const timezone = details.schedule?.timezone ?? 'Europe/Moscow';
  const [originalDate = '', originalTime = ''] = formatPublicationScheduleField(
    occurrence.scheduledAt,
    timezone,
  ).split('T');
  const [scope, setScope] = useState<PublicationOccurrenceRescheduleRequest['scope']>('occurrence');
  const [once, setOnce] = useState<{ date: string; time: string; at: string | null }>({
    date: originalDate,
    time: originalTime,
    at: occurrence.scheduledAt,
  });
  const [draft, setDraft] = useState<PublicationDraft>(() => {
    const initial = createPublicationDraftFromDetails(details);
    return {
      ...initial,
      recurrence: {
        ...initial.recurrence,
        startsAt:
          parsePublicationScheduleField(`${originalDate}T00:00`, timezone) ??
          occurrence.scheduledAt,
      },
    };
  });
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<PublicationDetails | null>(null);
  const sending = useRef(false);
  const [uncertain, setUncertain] = useState<PublicationOccurrenceRescheduleRequest | null>(null);
  const refreshDetails = () =>
    client.invalidateQueries({ queryKey: ['publications', 'details', details.id] });
  const mutation = useMutation({
    mutationFn: (request: PublicationOccurrenceRescheduleRequest) =>
      reschedulePublicationOccurrence(api, details.id, occurrence.id, request),
    onSuccess: async ({ source, publication }) => {
      setUncertain(null);
      const sourceKey = ['publications', 'details', source.id];
      await client.cancelQueries({ queryKey: sourceKey });
      client.setQueryData<PublicationDetails>(sourceKey, (current) =>
        current && current.version > source.version ? current : source,
      );
      client.setQueryData(['publications', 'details', publication.id], publication);
      void client.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'publications' && (queryKey[1] === 'list' || queryKey[1] === 'calendar'),
      });
      setCompleted(publication);
    },
    onError: async (reason: unknown, request) => {
      if (!(reason instanceof ApiRequestError) || reason.status >= 500 || reason.status < 400) {
        setUncertain(request);
        setError('Ответ не получен. Проверьте результат.');
      } else {
        setUncertain(null);
        if (reason.status === 409) await refreshDetails();
        setError(
          reason.code === 'PUBLICATION_REVISION_CONFLICT'
            ? 'Расписание обновилось. Проверьте выбранное время и подтвердите снова.'
            : describeUserFacingError(reason, 'Не удалось изменить расписание'),
        );
      }
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const current = details.occurrences.find((item) => item.id === occurrence.id);
  const available = Boolean(current && canMoveOccurrence(details, current));
  const busy = mutation.isPending;
  const fieldsDisabled = busy || uncertain !== null;
  const following = scope === 'following';
  const startDate = formatPublicationScheduleField(draft.recurrence.startsAt, timezone).slice(
    0,
    10,
  );

  function submit() {
    if (sending.current) return;
    if (uncertain) {
      sending.current = true;
      mutation.mutate(uncertain);
      return;
    }
    if (!available) return;
    const minimumAt = Date.now() + PUBLICATION_MIN_SCHEDULE_DELAY_MS;
    const next = following ? buildPublicationSchedule(draft) : null;
    let request: PublicationOccurrenceRescheduleRequest;
    const common = { expectedRevision: details.version, requestId: createPublicationRequestId() };
    if (following) {
      const message = getRecurrenceError(draft);
      if (message) {
        setError(message);
        return;
      }
      if (next?.mode !== 'recurrence') {
        setError('Проверьте расписание.');
        return;
      }
      request = { ...common, scope: 'following', schedule: next };
    } else {
      if (!once.at || Date.parse(once.at) < minimumAt) {
        setError('Выберите время минимум на 2 минуты позже текущего.');
        return;
      }
      if (Date.parse(once.at) === Date.parse(occurrence.scheduledAt)) {
        setError('Выберите другое время.');
        return;
      }
      request = { ...common, scope: 'occurrence', at: once.at };
    }
    const normalized = publicationOccurrenceRescheduleRequestSchema.safeParse(request);
    if (!normalized.success) {
      setError('Проверьте расписание.');
      return;
    }
    setError('');
    sending.current = true;
    mutation.mutate(normalized.data);
  }

  const completionTitle = following ? 'Продолжение запланировано' : 'Выпуск перенесён';
  return (
    <ActionConfirmSheet
      id="publication-reschedule"
      className="publication-reschedule"
      open
      title={completed ? completionTitle : 'Перенос выпуска'}
      summary={
        completed ? undefined : formatPublicationReviewDate(occurrence.scheduledAt, timezone)
      }
      tone="accent"
      isBusy={busy}
      confirmBusyLabel="Сохраняем…"
      confirmDisabled={!completed && !available && !uncertain}
      confirmLabel={
        completed
          ? following
            ? 'Открыть продолжение'
            : 'Открыть выпуск'
          : uncertain
            ? 'Проверить результат'
            : following
              ? 'Сохранить продолжение'
              : 'Перенести выпуск'
      }
      cancelLabel={completed ? 'Закрыть' : 'Отмена'}
      onClose={onClose}
      onConfirm={completed ? () => onOpenPublication(completed) : submit}
      previewTitle={
        <div className="publication-reschedule__body">
          {completed ? (
            completed.schedule?.nextOccurrenceAt ? (
              <p className="publication-reschedule__result">
                {formatPublicationReviewDate(completed.schedule.nextOccurrenceAt, timezone)}
                {' · '}
                {formatTimezoneLabel(timezone)}
              </p>
            ) : null
          ) : (
            <>
              <div
                className="publication-timing-tabs publication-reschedule__options"
                role="group"
                aria-label="Что перенести"
              >
                <button
                  type="button"
                  aria-pressed={!following}
                  className={!following ? 'is-active' : undefined}
                  disabled={fieldsDisabled}
                  onClick={() => {
                    setScope('occurrence');
                    setError('');
                  }}
                >
                  Только этот
                </button>
                <button
                  type="button"
                  aria-pressed={following}
                  className={following ? 'is-active' : undefined}
                  disabled={fieldsDisabled}
                  onClick={() => {
                    setScope('following');
                    setError('');
                  }}
                >
                  Этот и следующие
                </button>
              </div>
              <p className="publication-reschedule__context">
                {following
                  ? 'Продолжение появится отдельной серией. Получатели и оставшийся лимит выпусков сохранятся.'
                  : 'Выпуск появится отдельным постом для тех же получателей.'}
              </p>
              <p className="publication-reschedule__zone">{formatTimezoneLabel(timezone)}</p>
              {following ? (
                <>
                  <DateField
                    label="Начать с"
                    value={startDate}
                    min={originalDate}
                    disabled={fieldsDisabled}
                    onChange={(day) => {
                      const startsAt = parsePublicationScheduleField(`${day}T00:00`, timezone);
                      setDraft((current) => ({
                        ...current,
                        recurrence: { ...current.recurrence, startsAt },
                      }));
                      setError('');
                    }}
                  />
                  <Suspense fallback={null}>
                    <LazyRecurrenceFields
                      draft={draft}
                      setDraft={setDraft}
                      setFieldError={setError}
                      isBusy={fieldsDisabled}
                      showBoundaries={false}
                    />
                  </Suspense>
                </>
              ) : (
                <PublicationOnceFields
                  date={once.date}
                  time={once.time}
                  timezone={timezone}
                  disabled={fieldsDisabled}
                  onChange={(date, time, at) => {
                    setOnce({ date, time, at });
                    setError('');
                  }}
                />
              )}
              {(!available || error) && (
                <p className="publication-reschedule__error" role="alert">
                  {available || uncertain ? error : 'Выпуск уже изменился или начал отправляться.'}
                </p>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
