import {
  lazy,
  Suspense,
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { PublicationLatePolicy } from '@maxim/contracts/publication';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { resolveBroadcastScheduleTimezone } from '../../lib/broadcast-schedule';
import { cn } from '../../lib/cn';
import type { ApiTransport } from '../../lib/api/transport';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import { PublicationLatePolicyFields } from './publication-late-policy-fields';
import {
  getPublicationOnceSlot,
  PUBLICATION_MIN_SCHEDULE_DELAY_MS,
  type getPublicationTimingIssue,
  type PublicationDraft,
  type PublicationEditorContext,
  type PublicationTimingMode,
} from './publication-model';
import { formatDraftTiming, formatTargetSummary } from './publication-page-formatters';
import { usePublicationCalendar } from './use-publication-calendar';

const LazyPublicationRecurrenceFields = lazy(() =>
  import('./publication-recurrence-fields').then((module) => ({
    default: module.PublicationRecurrenceFields,
  })),
);
const LazyPublicationOnceFields = lazy(() =>
  import('./publication-zoned-fields').then((module) => ({
    default: module.PublicationOnceFields,
  })),
);
const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);

export function PublicationTimingSection({
  api,
  context,
  draft,
  setDraft,
  setFieldError,
  timingSectionRef,
  validationStarted,
  timingIssue,
  latePolicy,
  isBusy,
}: {
  api: ApiTransport;
  context: PublicationEditorContext | null;
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  setFieldError: (message: string) => void;
  timingSectionRef: RefObject<HTMLElement | null>;
  validationStarted: boolean;
  timingIssue: ReturnType<typeof getPublicationTimingIssue>;
  latePolicy?: PublicationLatePolicy;
  isBusy: boolean;
}) {
  const calendarAvailabilityQuery = usePublicationCalendar(api, true, draft, context);
  // FLAG: Older drafts may retain the one-time wall fields without the corresponding instant.
  useEffect(() => {
    const { onceAt, onceDate, onceTime, scheduleTimezone, timingMode } = draft;
    if (timingMode !== 'once' || onceAt || !onceDate || !onceTime) return;
    let alive = true;
    void import('./publication-schedule-fields')
      .then(({ parsePublicationScheduleField }) => {
        const recovered = parsePublicationScheduleField(
          `${onceDate}T${onceTime}`,
          scheduleTimezone,
        );
        if (!alive || !recovered) return;
        setDraft((current) =>
          current.timingMode === 'once' &&
          current.onceDate === onceDate &&
          current.onceTime === onceTime &&
          current.scheduleTimezone === scheduleTimezone &&
          !current.onceAt
            ? { ...current, onceAt: recovered }
            : current,
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [
    draft.onceAt,
    draft.onceDate,
    draft.onceTime,
    draft.scheduleTimezone,
    draft.timingMode,
    setDraft,
  ]);

  function updateOnceSlot(onceDate: string, onceTime: string, scheduledAt: string | null) {
    setDraft((current) => {
      const preservedAt =
        current.onceDate === onceDate && current.onceTime === onceTime
          ? getPublicationOnceSlot(current)
          : null;
      return {
        ...current,
        onceDate,
        onceTime,
        onceAt: preservedAt ?? scheduledAt,
      };
    });
    setFieldError('');
  }

  const onceDate = draft.onceDate;
  const onceTime = draft.onceTime;
  return (
    <section
      ref={timingSectionRef}
      className="publication-editor-section publication-editor-section--timing"
    >
      <div className="publication-editor-section__head">
        <strong>Когда</strong>
        {draft.timingMode === 'now' ? null : <small>{formatDraftTiming(draft)}</small>}
      </div>
      <div className="publication-timing-tabs" role="group" aria-label="Время публикации">
        {(
          [
            { value: 'now', label: 'Сейчас' },
            { value: 'once', label: 'Отложить' },
            { value: 'schedule', label: 'Расписание' },
          ] as Array<{ value: PublicationTimingMode; label: string }>
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={draft.timingMode === option.value}
            className={cn(draft.timingMode === option.value && 'is-active')}
            onClick={() => {
              setDraft((current) => ({ ...current, timingMode: option.value }));
              setFieldError('');
            }}
            disabled={isBusy}
          >
            {option.label}
          </button>
        ))}
      </div>

      {draft.timingMode !== 'now' ? (
        <div className="publication-schedule-timezone">
          <IconoirSprite variant="iconoir" icon="Clock" aria-hidden />
          <span>
            {formatTimezoneLabel(
              draft.timingMode === 'schedule' && draft.scheduleKind === 'slots'
                ? resolveBroadcastScheduleTimezone()
                : draft.scheduleTimezone,
            )}
          </span>
        </div>
      ) : null}

      {draft.timingMode !== 'now' ? (
        <PublicationLatePolicyFields
          value={latePolicy}
          recurring={draft.timingMode === 'schedule' && draft.scheduleKind === 'recurrence'}
          disabled={isBusy}
          onChange={(latePolicy) => setDraft((current) => ({ ...current, latePolicy }))}
        />
      ) : null}

      {draft.timingMode === 'once' ? (
        <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
          <LazyPublicationOnceFields
            date={onceDate}
            time={onceTime}
            timezone={draft.scheduleTimezone}
            disabled={isBusy}
            dateError={
              validationStarted && timingIssue?.field === 'date' ? timingIssue.message : undefined
            }
            timeError={
              validationStarted && timingIssue?.field === 'time' ? timingIssue.message : undefined
            }
            onChange={updateOnceSlot}
          />
        </Suspense>
      ) : draft.timingMode === 'schedule' ? (
        <>
          <div className="publication-schedule-kind" role="group" aria-label="Тип расписания">
            {(
              [
                { value: 'slots', label: 'Даты' },
                { value: 'recurrence', label: 'Повтор' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={draft.scheduleKind === option.value}
                className={cn(draft.scheduleKind === option.value && 'is-active')}
                onClick={() => {
                  setDraft((current) => ({ ...current, scheduleKind: option.value }));
                  setFieldError('');
                }}
                disabled={isBusy}
              >
                {option.label}
              </button>
            ))}
          </div>
          {draft.scheduleKind === 'recurrence' ? (
            <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
              <LazyPublicationRecurrenceFields
                draft={draft}
                setDraft={setDraft}
                isBusy={isBusy}
                setFieldError={setFieldError}
              />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <LazyBroadcastSchedulePlanner
                preciseTime
                minimumLeadMs={PUBLICATION_MIN_SCHEDULE_DELAY_MS}
                value={draft.scheduledSlots}
                error={validationStarted ? timingIssue?.message : undefined}
                occupiedSlots={
                  calendarAvailabilityQuery.data?.slots.map((slot) => slot.scheduledAt) ?? []
                }
                onChange={(scheduledSlots) => {
                  setDraft((current) => ({ ...current, scheduledSlots }));
                  setFieldError('');
                }}
                managedBroadcastsLoading={calendarAvailabilityQuery.isLoading}
                calendarRefreshing={calendarAvailabilityQuery.isFetching}
                currentTargetLabel={formatTargetSummary(draft.targets)}
                targetContextLabel={formatTargetSummary(draft.targets)}
                timingMode="scheduled"
                availableTimingModes={['scheduled']}
                viewMode="compose"
                allowRecipe={false}
                disabled={isBusy}
              />
            </Suspense>
          )}
        </>
      ) : null}

      {draft.timingMode === 'schedule' &&
      draft.scheduleKind === 'slots' &&
      calendarAvailabilityQuery.isError ? (
        <div className="publications-calendar-error" role="alert">
          <span>Не удалось загрузить занятое время.</span>
          <button type="button" onClick={() => void calendarAvailabilityQuery.refetch()}>
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            <span>Повторить</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}
