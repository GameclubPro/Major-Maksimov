import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { Suspense, lazy, type Dispatch, type SetStateAction } from 'react';

import { TimeField } from '../../components/ui/time-field';
import { cn } from '../../lib/cn';
import { PUBLICATION_WEEKDAYS as WEEKDAYS } from './publication-page-options';
import { PublicationRecurrenceIntervalField } from './publication-recurrence-interval-field';
import { getNextPublicationRecurrenceTime } from './publication-time-presentation';
import type { PublicationDraft } from './publication-model';

const LazyPublicationRecurrenceLimit = lazy(() =>
  import('./publication-recurrence-limit').then((module) => ({
    default: module.PublicationRecurrenceLimit,
  })),
);
const LazyPublicationZonedDateField = lazy(() =>
  import('./publication-zoned-fields').then((module) => ({
    default: module.PublicationZonedDateField,
  })),
);

export function PublicationRecurrenceFields({
  draft,
  setDraft,
  isBusy,
  setFieldError,
  showBoundaries = true,
}: {
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  isBusy: boolean;
  setFieldError: (value: string) => void;
  showBoundaries?: boolean;
}) {
  function updateRecurrenceTime(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      recurrence: {
        ...current.recurrence,
        times: current.recurrence.times.map((time, timeIndex) =>
          timeIndex === index ? value : time,
        ),
      },
    }));
    setFieldError('');
  }
  return (
    <div className="publication-recurrence">
      <div className="publication-recurrence__frequency" role="group" aria-label="Частота">
        {(['daily', 'weekly'] as const).map((frequency) => (
          <button
            key={frequency}
            type="button"
            aria-pressed={draft.recurrence.frequency === frequency}
            className={cn(draft.recurrence.frequency === frequency && 'is-active')}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                recurrence: { ...current.recurrence, frequency },
              }))
            }
            disabled={isBusy}
          >
            {frequency === 'daily' ? 'Ежедневно' : 'По неделям'}
          </button>
        ))}
      </div>

      <PublicationRecurrenceIntervalField
        frequency={draft.recurrence.frequency}
        interval={draft.recurrence.interval}
        disabled={isBusy}
        onChange={(interval) =>
          setDraft((current) => ({
            ...current,
            recurrence: { ...current.recurrence, interval },
          }))
        }
      />

      {draft.recurrence.frequency === 'weekly' ? (
        <div className="publication-weekdays" aria-label="Дни недели">
          {WEEKDAYS.map((weekday) => {
            const selected = draft.recurrence.weekdays.includes(weekday.value);
            return (
              <button
                key={weekday.value}
                type="button"
                className={cn(selected && 'is-active')}
                aria-pressed={selected}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    recurrence: {
                      ...current.recurrence,
                      weekdays: selected
                        ? current.recurrence.weekdays.filter((value) => value !== weekday.value)
                        : [...current.recurrence.weekdays, weekday.value].sort(),
                    },
                  }))
                }
                disabled={isBusy}
              >
                {weekday.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="publication-recurrence__times">
        {draft.recurrence.times.map((time, index) => (
          <div key={index}>
            <TimeField
              label={`Время ${index + 1}`}
              value={time}
              precise
              onChange={(value) => updateRecurrenceTime(index, value)}
              disabled={isBusy}
            />
            {draft.recurrence.times.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    recurrence: {
                      ...current.recurrence,
                      times: current.recurrence.times.filter((_, timeIndex) => timeIndex !== index),
                    },
                  }))
                }
                aria-label={`Удалить время ${index + 1}`}
                disabled={isBusy}
              >
                <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
              </button>
            ) : null}
          </div>
        ))}
        {draft.recurrence.times.length < 12 ? (
          <button
            type="button"
            className="publication-recurrence__add-time"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                recurrence: {
                  ...current.recurrence,
                  times: [
                    ...current.recurrence.times,
                    getNextPublicationRecurrenceTime(current.recurrence.times),
                  ],
                },
              }))
            }
            disabled={isBusy}
          >
            <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
            <span>Добавить время</span>
          </button>
        ) : null}
      </div>

      {showBoundaries ? (
        <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
          <LazyPublicationZonedDateField
            label="Начать с"
            value={draft.recurrence.startsAt}
            timezone={draft.scheduleTimezone}
            onChange={(startsAt) => {
              setDraft((current) => ({
                ...current,
                recurrence: { ...current.recurrence, startsAt },
              }));
              setFieldError('');
            }}
            disabled={isBusy}
          />
        </Suspense>
      ) : null}

      {showBoundaries ? (
        <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
          <LazyPublicationRecurrenceLimit
            recurrence={draft.recurrence}
            timezone={draft.scheduleTimezone}
            disabled={isBusy}
            onChange={(patch) =>
              setDraft((current) => ({
                ...current,
                recurrence: { ...current.recurrence, ...patch },
              }))
            }
          />
        </Suspense>
      ) : null}
    </div>
  );
}
