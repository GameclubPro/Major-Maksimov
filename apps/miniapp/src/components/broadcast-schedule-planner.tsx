import { AppIcon as IconoirSprite } from './ui/app-icon';
import type { ManagedBroadcastCalendarSlot, ManagedBroadcastSummary } from '@maxim/contracts';
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { MaxMarkdownPreview } from './max-markdown-preview';
import { TimeField } from './ui/time-field';
import { cn } from '../lib/cn';
import {
  buildAgendaEntries,
  buildAgendaEntriesFromCalendarSlots,
  type BroadcastScheduleAgendaEntry,
} from '../lib/broadcast-planner-agenda';
import {
  BROADCAST_PLANNER_NOW_REFRESH_MS,
  BROADCAST_PLANNER_SLOT_GROUPS,
  addDays,
  buildSlotsByDay,
  buildFreeWindowsForDay,
  formatAgendaTime,
  formatCountLabel,
  formatDayChipLabel,
  formatDayDensityLabel,
  formatDaySummary,
  formatMinuteLabel,
  formatMonthKey,
  getBroadcastPlannerKeyboardNavigationDayKey,
  getBroadcastPlannerWindow,
  getCommonSelectedMinutesForDays,
  getMinutesList,
  getMonthCells,
  getMonthKey,
  getMonthKeys,
  getSelectedDaySlots,
  getSelectedMinutesForDay,
  normalizeBroadcastPlannerTimeMinutes,
  parseBroadcastPlannerTimeLabel,
  sortDayKeys,
  startOfDay,
  type BroadcastFreeWindow,
} from '../lib/broadcast-planner-time';
import {
  BROADCAST_RECIPE_MAX_DAYS,
  BROADCAST_RECIPE_MAX_POSTS_PER_DAY,
  BROADCAST_RECIPE_MIN_DAYS,
  BROADCAST_RECIPE_MIN_POSTS_PER_DAY,
  areBroadcastScheduleRecipeDraftsEqual,
  buildBroadcastScheduleRecipePlan,
  createDefaultBroadcastScheduleRecipeDraft,
  normalizeBroadcastScheduleRecipeDraft,
  normalizeBroadcastScheduleRecipeMinutes,
  type BroadcastScheduleRecipeDraft,
} from '../lib/broadcast-schedule-recipe';
import {
  BROADCAST_CYCLE_MAX_HOURS,
  BROADCAST_CYCLE_INTERVAL_OPTIONS,
  BROADCAST_SCHEDULE_MAX_DAYS,
  buildBroadcastScheduleSlotIso,
  clampBroadcastCycleCount,
  clampBroadcastCycleEveryHours,
  countBroadcastScheduleDays,
  createDefaultBroadcastCycleDraft,
  formatBroadcastCycleIntervalLabel,
  formatBroadcastCycleLastSendLabel,
  formatBroadcastCycleSummary,
  formatBroadcastScheduleDay,
  formatBroadcastScheduleSlot,
  formatLocalDateTimeInputValue,
  getBroadcastSlotInstantKey,
  getBroadcastScheduleDayKey,
  normalizeBroadcastCycleDraft,
  parseLocalDateTimeInputValue,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import { maxImpact, maxSelectionChanged } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import './broadcast-schedule-planner.css';
import './broadcast-schedule-planner-precise.css';

type BroadcastSchedulePlannerProps = {
  value: string[];
  occupiedSlots?: string[];
  error?: string;
  disabled?: boolean;
  resetKey?: string | number;
  onChange: (nextValue: string[]) => void;
  onOpenDay?: (dayKey: string) => void;
  onSelectionStateChange?: (state: BroadcastSchedulePlannerSelectionState) => void;
  managedBroadcasts?: ManagedBroadcastSummary[];
  calendarSlots?: ManagedBroadcastCalendarSlot[];
  targetAwareAvailability?: boolean;
  managedBroadcastsLoading?: boolean;
  sourceChatId?: string | null;
  currentTargetLabel?: string;
  targetContextLabel?: string;
  targetContextMeta?: string;
  calendarRefreshing?: boolean;
  excludeBroadcastId?: string | null;
  excludeAutopostRuleId?: string | null;
  onEditBroadcast?: (broadcastId: string) => void;
  onDeleteBroadcast?: (broadcastId: string) => void;
  pendingEditBroadcastId?: string | null;
  pendingDeleteBroadcastId?: string | null;
  timingMode?: BroadcastTimingMode;
  availableTimingModes?: readonly BroadcastTimingMode[];
  cycle?: BroadcastCycleDraft;
  onTimingModeChange?: (mode: BroadcastTimingMode) => void;
  onCycleChange?: (cycle: BroadcastCycleDraft) => void;
  viewMode?: 'compose' | 'calendar';
  allowRecipe?: boolean;
  preciseTime?: boolean;
  minimumLeadMs?: number;
};

export type BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: number;
  selectedDayCount: number;
  slotCount: number;
  futureSlotCount: number;
  isDaySheetOpen: boolean;
  isConfirmed: boolean;
  hasBlockingIssue: boolean;
};

type BroadcastScheduleSheetMode = 'time' | 'agenda';

function areSelectionStatesEqual(
  left: BroadcastSchedulePlannerSelectionState | null,
  right: BroadcastSchedulePlannerSelectionState,
): boolean {
  return (
    left !== null &&
    left.pickedDayCount === right.pickedDayCount &&
    left.selectedDayCount === right.selectedDayCount &&
    left.slotCount === right.slotCount &&
    left.futureSlotCount === right.futureSlotCount &&
    left.isDaySheetOpen === right.isDaySheetOpen &&
    left.isConfirmed === right.isConfirmed &&
    left.hasBlockingIssue === right.hasBlockingIssue
  );
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const SLOT_GROUPS = BROADCAST_PLANNER_SLOT_GROUPS;
const PLANNER_NOW_REFRESH_MS = BROADCAST_PLANNER_NOW_REFRESH_MS;

export function BroadcastSchedulePlanner({
  value,
  occupiedSlots = [],
  error,
  disabled = false,
  resetKey,
  onChange,
  onOpenDay,
  onSelectionStateChange,
  managedBroadcasts = [],
  calendarSlots = [],
  targetAwareAvailability = false,
  managedBroadcastsLoading = false,
  sourceChatId = null,
  currentTargetLabel = 'Текущий чат',
  targetContextLabel,
  targetContextMeta,
  calendarRefreshing = false,
  excludeBroadcastId = null,
  excludeAutopostRuleId = null,
  onEditBroadcast,
  onDeleteBroadcast,
  pendingEditBroadcastId = null,
  pendingDeleteBroadcastId = null,
  timingMode = 'scheduled',
  availableTimingModes = ['now', 'scheduled', 'cycle'],
  cycle,
  onTimingModeChange,
  onCycleChange,
  viewMode = 'compose',
  allowRecipe = true,
  preciseTime = false,
  minimumLeadMs = 30_000,
}: BroadcastSchedulePlannerProps) {
  const minuteStep = preciseTime ? 1 : 30;
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const liveNow = useMemo(() => new Date(liveNowMs), [liveNowMs]);
  const liveTodayKey = getBroadcastScheduleDayKey(liveNow);
  const liveMonthKey = getMonthKey(liveNow);
  const normalizedValue = useMemo(() => sortAndUniqueBroadcastSlots(value), [value]);
  const calendarOnly = viewMode === 'calendar';
  const scheduledDayKeys = useMemo(
    () => sortDayKeys(normalizedValue.map((slot) => getBroadcastScheduleDayKey(slot))),
    [normalizedValue],
  );
  const initialDayKey = scheduledDayKeys[0] ?? liveTodayKey;
  const [activeDayKey, setActiveDayKey] = useState(initialDayKey);
  const [pickedDayKeys, setPickedDayKeys] = useState<string[]>([]);
  const [currentMonthKey, setCurrentMonthKey] = useState(() =>
    normalizedValue[0] ? getMonthKey(new Date(normalizedValue[0])) : liveMonthKey,
  );
  const [sheetMode, setSheetMode] = useState<BroadcastScheduleSheetMode | null>(null);
  const [agendaDayKey, setAgendaDayKey] = useState<string | null>(null);
  const [applyToAllPickedDays, setApplyToAllPickedDays] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [calendarExpanded, setCalendarExpanded] = useState(() => calendarOnly);
  const [customTimeValue, setCustomTimeValue] = useState('');
  const [hasBlockingIssue, setHasBlockingIssue] = useState(false);
  const [recipeDraft, setRecipeDraft] = useState<BroadcastScheduleRecipeDraft>(() =>
    createDefaultBroadcastScheduleRecipeDraft(),
  );
  const calendarGridId = useId();
  const lastSelectionStateRef = useRef<BroadcastSchedulePlannerSelectionState | null>(null);
  const calendarGridRef = useRef<HTMLDivElement | null>(null);
  const pendingCalendarFocusDayKeyRef = useRef<string | null>(null);
  const sheetPanelRef = useRef<HTMLElement | null>(null);

  const { start: windowStart, end: windowEnd } = getBroadcastPlannerWindow(liveNow);
  const monthKeys = getMonthKeys(windowStart, windowEnd);
  const visibleMonthKey = monthKeys.includes(currentMonthKey) ? currentMonthKey : monthKeys[0];
  const selectedDayCount = countBroadcastScheduleDays(normalizedValue);
  const availabilityCalendarSlots = calendarSlots.filter(
    (slot) =>
      (!excludeBroadcastId || slot.broadcastId !== excludeBroadcastId) &&
      (!excludeAutopostRuleId || slot.autopostRuleId !== excludeAutopostRuleId),
  );
  const calendarBusySlots = sortAndUniqueBroadcastSlots(
    availabilityCalendarSlots
      .filter((slot) => !targetAwareAvailability || slot.hasTargetOverlap)
      .map((slot) => slot.scheduledAt),
  );
  const occupiedSlotList =
    calendarSlots.length > 0 ? calendarBusySlots : sortAndUniqueBroadcastSlots(occupiedSlots);
  const occupiedInstantSet = new Set(occupiedSlotList.map(getBroadcastSlotInstantKey));
  const occupiedSlotsByDay = new Map<string, string[]>();
  for (const slot of occupiedSlotList) {
    const dayKey = getBroadcastScheduleDayKey(slot);
    const current = occupiedSlotsByDay.get(dayKey) ?? [];
    current.push(slot);
    occupiedSlotsByDay.set(dayKey, current);
  }
  const selectedInstantSet = new Set(normalizedValue.map(getBroadcastSlotInstantKey));
  const pickedDaySet = new Set(pickedDayKeys);
  const minimumTime = liveNowMs + minimumLeadMs;
  // FLAG: The lead window blocks new selections; keep saved imminent selections visible.
  const futureSlots = normalizedValue.filter((slot) => new Date(slot).getTime() >= liveNowMs);
  const activeDaySlots = getSelectedDaySlots(activeDayKey, normalizedValue);
  const pickedDayLabel = formatCountLabel(pickedDayKeys.length, 'день', 'дня', 'дней');
  const pickedDaySummary = formatDaySummary(pickedDayKeys);
  const targetDayKeys =
    applyToAllPickedDays && pickedDayKeys.length > 1 ? pickedDayKeys : [activeDayKey];
  const selectedTargetMinutes =
    applyToAllPickedDays && pickedDayKeys.length > 1
      ? getCommonSelectedMinutesForDays(targetDayKeys, normalizedValue, minuteStep)
      : getSelectedMinutesForDay(activeDayKey, normalizedValue, minuteStep);
  const selectedTargetMinuteLabels = selectedTargetMinutes.map(formatMinuteLabel);
  const slotsByDay = useMemo(() => buildSlotsByDay(normalizedValue), [normalizedValue]);
  const recipeOccupiedSlots = occupiedSlotList.filter(
    (slot) => !selectedInstantSet.has(getBroadcastSlotInstantKey(slot)),
  );
  const recipePlan = buildBroadcastScheduleRecipePlan(recipeDraft, {
    nowMs: liveNowMs,
    minimumTimeMs: minimumTime,
    occupiedSlots: recipeOccupiedSlots,
  });
  const recipeSlotCount = recipePlan.slots.length;
  const recipeTimeLabels = recipeDraft.minutes.map(formatMinuteLabel);
  const recipeApplied =
    recipePlan.isComplete && areStringArraysEqual(normalizedValue, recipePlan.slots);
  const recipeSummary = `${formatCountLabel(
    recipeDraft.dayCount,
    'день',
    'дня',
    'дней',
  )} × ${recipeDraft.postsPerDay}`;
  const recipeIssueLabel =
    recipePlan.issue === 'duplicate-time'
      ? 'Время повторяется'
      : recipePlan.skippedBusyDayCount > 0
        ? 'Занято'
        : recipePlan.skippedPastDayCount > 0
          ? 'Начнем позже'
          : 'Нет времени';
  const currentScheduleRecipe = useMemo<BroadcastScheduleRecipeDraft | null>(() => {
    if (normalizedValue.length === 0 || selectedDayCount === 0) {
      return null;
    }

    const dayEntries = Array.from(slotsByDay.entries());
    const firstEntry = dayEntries[0];
    if (!firstEntry) {
      return null;
    }

    const firstMinutes = getSelectedMinutesForDay(firstEntry[0], firstEntry[1]);
    if (firstMinutes.length === 0) {
      return null;
    }

    const hasSameTimes = dayEntries.every(([dayKey, slots]) =>
      areStringArraysEqual(
        getSelectedMinutesForDay(dayKey, slots).map(String),
        firstMinutes.map(String),
      ),
    );
    if (!hasSameTimes) {
      return null;
    }

    const firstDayMs = new Date(`${dayEntries[0]?.[0] ?? ''}T12:00:00`).getTime();
    const lastDayMs = new Date(
      `${dayEntries[dayEntries.length - 1]?.[0] ?? ''}T12:00:00`,
    ).getTime();
    const calendarSpanDays =
      Number.isFinite(firstDayMs) && Number.isFinite(lastDayMs)
        ? Math.round((lastDayMs - firstDayMs) / (24 * 60 * 60_000)) + 1
        : dayEntries.length;
    const isWorkdaysOnly =
      calendarSpanDays > dayEntries.length &&
      dayEntries.every(([dayKey]) => {
        const weekDay = new Date(`${dayKey}T12:00:00`).getDay();
        return weekDay !== 0 && weekDay !== 6;
      });

    return {
      dayCount: dayEntries.length,
      postsPerDay: firstMinutes.length,
      weekdayMode: isWorkdaysOnly ? 'workdays' : 'any',
      minutes: normalizeBroadcastScheduleRecipeMinutes(firstMinutes, firstMinutes.length),
    };
  }, [normalizedValue.length, selectedDayCount, slotsByDay]);
  const normalizedCycle = normalizeBroadcastCycleDraft(
    cycle ?? createDefaultBroadcastCycleDraft(liveNowMs),
    liveNowMs,
  );
  const agendaEntries =
    calendarSlots.length > 0
      ? buildAgendaEntriesFromCalendarSlots(
          calendarSlots,
          sourceChatId,
          currentTargetLabel,
          excludeBroadcastId,
          excludeAutopostRuleId,
        )
      : buildAgendaEntries(
          managedBroadcasts,
          currentTargetLabel,
          excludeBroadcastId,
          excludeAutopostRuleId,
        );
  const agendaEntriesByDay = new Map<string, BroadcastScheduleAgendaEntry[]>();
  for (const entry of agendaEntries) {
    const current = agendaEntriesByDay.get(entry.dayKey) ?? [];
    current.push(entry);
    agendaEntriesByDay.set(entry.dayKey, current);
  }
  const agendaDayEntries = agendaDayKey ? (agendaEntriesByDay.get(agendaDayKey) ?? []) : [];
  const agendaSlotCount = agendaDayEntries.reduce(
    (count, entry) => count + entry.timeSlots.length,
    0,
  );
  const agendaFreeWindowSlots =
    agendaDayKey && calendarSlots.length > 0
      ? availabilityCalendarSlots
          .filter(
            (slot) =>
              getBroadcastScheduleDayKey(slot.scheduledAt) === agendaDayKey &&
              (!targetAwareAvailability || slot.hasTargetOverlap),
          )
          .map((slot) => slot.scheduledAt)
      : agendaDayEntries.flatMap((entry) => entry.timeSlots);
  const agendaFreeWindows = buildFreeWindowsForDay(agendaFreeWindowSlots);
  const showAgendaSkeleton =
    sheetMode === 'agenda' && managedBroadcastsLoading && agendaDayEntries.length === 0;
  const isDaySheetOpen = sheetMode !== null;
  useNativeBackHandler(
    () => {
      setApplyToAllPickedDays(false);
      setSheetMode(null);
      setAgendaDayKey(null);
      maxImpact('soft');
      return true;
    },
    { enabled: isDaySheetOpen, priority: 640 },
  );
  const futureSlotCount = futureSlots.length;
  const scheduleStatusLabel =
    timingMode === 'now'
      ? 'Сейчас'
      : timingMode === 'cycle'
        ? 'Повтор'
        : futureSlotCount > 0
          ? formatCountLabel(futureSlotCount, 'отправка', 'отправки', 'отправок')
          : 'Не выбрано';
  const pickedSlotsCount = pickedDayKeys.reduce(
    (count, dayKey) => count + getSelectedDaySlots(dayKey, normalizedValue).length,
    0,
  );
  const hasAnyAvailableTimeSlot =
    sheetMode === 'time' && targetDayKeys.every((dayKey) => hasAvailableTimeSlotForDay(dayKey));
  const nextAvailableDayKey =
    sheetMode === 'time' && !hasAnyAvailableTimeSlot ? findNextAvailableDayKey(activeDayKey) : null;
  const normalizedTargetContextLabel =
    targetContextLabel?.trim() || currentTargetLabel.trim() || 'Текущий чат';
  const normalizedTargetContextMeta = targetContextMeta?.trim() ?? '';
  const timingModeSet = new Set(availableTimingModes);
  const showTimingModePicker = !calendarOnly && availableTimingModes.length > 1;
  const showCalendar = calendarOnly || (timingMode === 'scheduled' && calendarExpanded);
  const showRecipe = allowRecipe && !calendarOnly && timingMode === 'scheduled';
  const emitSelectionStateChange = useEffectEvent(
    (nextState: BroadcastSchedulePlannerSelectionState) => {
      onSelectionStateChange?.(nextState);
    },
  );

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, PLANNER_NOW_REFRESH_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (pickedDayKeys.length > 0) {
      if (!pickedDayKeys.includes(activeDayKey)) {
        setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
      }
      return;
    }

    if (scheduledDayKeys.length === 0) {
      setActiveDayKey((current) => (current === liveTodayKey ? current : liveTodayKey));
      setCurrentMonthKey((current) => (current === liveMonthKey ? current : liveMonthKey));
      return;
    }

    if (!scheduledDayKeys.includes(activeDayKey)) {
      setActiveDayKey(scheduledDayKeys[0] ?? activeDayKey);
    }
  }, [activeDayKey, liveMonthKey, liveTodayKey, pickedDayKeys, scheduledDayKeys]);

  useEffect(() => {
    if (pickedDayKeys.length === 0) {
      if (sheetMode === 'time') {
        setSheetMode(null);
      }
      setApplyToAllPickedDays(false);
      return;
    }

    if (pickedDayKeys.length === 1) {
      setApplyToAllPickedDays(false);
    }
  }, [pickedDayKeys, sheetMode]);

  useEffect(() => {
    if (sheetMode !== 'agenda' || !agendaDayKey) {
      return;
    }

    if (managedBroadcastsLoading) {
      return;
    }

    if (agendaDayEntries.length === 0) {
      setSheetMode(null);
      setAgendaDayKey(null);
    }
  }, [agendaDayEntries.length, agendaDayKey, managedBroadcastsLoading, sheetMode]);

  useEffect(() => {
    setPickedDayKeys(scheduledDayKeys);
    setActiveDayKey(scheduledDayKeys[0] ?? liveTodayKey);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    setCalendarExpanded(calendarOnly);
  }, [resetKey]);

  useEffect(() => {
    if (normalizedValue.length === 0) {
      setIsConfirmed(false);
    }
  }, [normalizedValue.length]);

  useEffect(() => {
    if (!currentScheduleRecipe || hasBlockingIssue) {
      return;
    }

    setRecipeDraft((current) =>
      areBroadcastScheduleRecipeDraftsEqual(current, currentScheduleRecipe)
        ? current
        : currentScheduleRecipe,
    );
  }, [currentScheduleRecipe, hasBlockingIssue]);

  useEffect(() => {
    if (timingMode === 'scheduled') {
      return;
    }

    setPickedDayKeys([]);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(timingMode === 'now' || timingMode === 'cycle');
    setHasBlockingIssue(false);
    setCalendarExpanded(false);
  }, [normalizedValue.length, timingMode]);

  useEffect(() => {
    if (!isDaySheetOpen) {
      return undefined;
    }

    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const focusableSelector =
      'button:not(:disabled):not([tabindex="-1"]), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.time-field-sheet')) {
        return;
      }

      if (event.key === 'Escape') {
        closeDaySheet();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const panel = sheetPanelRef.current;
      if (!panel) {
        return;
      }

      const focusableItems = Array.from(
        panel.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((item) => !item.hasAttribute('disabled') && item.getClientRects().length > 0);

      if (focusableItems.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const firstItem = focusableItems[0];
      const lastItem = focusableItems[focusableItems.length - 1];
      const activeElement = document.activeElement;

      if (activeElement && !panel.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem)?.focus();
      } else if (!event.shiftKey && activeElement === panel) {
        event.preventDefault();
        firstItem?.focus();
      } else if (event.shiftKey && (activeElement === firstItem || activeElement === panel)) {
        event.preventDefault();
        lastItem?.focus();
      } else if (!event.shiftKey && activeElement === lastItem) {
        event.preventDefault();
        firstItem?.focus();
      }
    };

    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    const frame = window.requestAnimationFrame(() => {
      sheetPanelRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(() => {
        previousActiveElement?.focus();
      });
    };
  }, [isDaySheetOpen]);

  useEffect(() => {
    if (calendarOnly) {
      setCalendarExpanded(true);
    }
  }, [calendarOnly]);

  useEffect(() => {
    const dayKey = pendingCalendarFocusDayKeyRef.current;
    if (!dayKey || !showCalendar) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      const dayButton = calendarGridRef.current?.querySelector<HTMLButtonElement>(
        `[data-broadcast-schedule-day="${dayKey}"]`,
      );
      if (!dayButton?.disabled) {
        dayButton?.focus();
      }
      pendingCalendarFocusDayKeyRef.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [showCalendar, visibleMonthKey]);

  useEffect(() => {
    const nextState = {
      pickedDayCount: pickedDayKeys.length,
      selectedDayCount,
      slotCount: normalizedValue.length,
      futureSlotCount,
      isDaySheetOpen,
      isConfirmed,
      hasBlockingIssue,
    };

    if (areSelectionStatesEqual(lastSelectionStateRef.current, nextState)) {
      return;
    }

    lastSelectionStateRef.current = nextState;
    emitSelectionStateChange(nextState);
  }, [
    emitSelectionStateChange,
    futureSlotCount,
    hasBlockingIssue,
    isConfirmed,
    isDaySheetOpen,
    normalizedValue.length,
    pickedDayKeys.length,
    selectedDayCount,
  ]);

  function replaceSlotsForDays(
    dayKeys: string[],
    updater: (dayKey: string, currentSlots: string[]) => string[],
  ) {
    const uniqueDayKeys = sortDayKeys(dayKeys);
    const cleaned = normalizedValue.filter(
      (slot) => !uniqueDayKeys.includes(getBroadcastScheduleDayKey(slot)),
    );
    const nextSlots = [...cleaned];

    for (const dayKey of uniqueDayKeys) {
      nextSlots.push(...updater(dayKey, getSelectedDaySlots(dayKey, normalizedValue)));
    }

    onChange(sortAndUniqueBroadcastSlots(nextSlots));
  }

  function applyRecipeDraft(nextRecipe: BroadcastScheduleRecipeDraft) {
    const normalizedRecipe = normalizeBroadcastScheduleRecipeDraft(nextRecipe);
    const nextPlan = buildBroadcastScheduleRecipePlan(normalizedRecipe, {
      nowMs: liveNowMs,
      minimumTimeMs: minimumTime,
      occupiedSlots: recipeOccupiedSlots,
    });
    const nextSlots = nextPlan.slots;

    activateScheduledMode();
    setRecipeDraft(normalizedRecipe);
    if (!nextPlan.isComplete) {
      setIsConfirmed(false);
      setHasBlockingIssue(true);
      return;
    }

    setPickedDayKeys(nextPlan.dayKeys);
    setActiveDayKey((current) => {
      const nextDayKey = getBroadcastScheduleDayKey(nextSlots[0] ?? '');
      return nextDayKey && nextDayKey !== 'NaN-NaN-NaN' ? nextDayKey : current;
    });
    setApplyToAllPickedDays(true);
    setIsConfirmed(nextPlan.isComplete);
    setHasBlockingIssue(false);
    onChange(nextSlots);
  }

  function patchRecipeDraft(patch: Partial<BroadcastScheduleRecipeDraft>) {
    const nextRecipe = {
      ...recipeDraft,
      ...patch,
    };
    applyRecipeDraft(nextRecipe);
    maxSelectionChanged();
  }

  function setRecipeTime(index: number, value: string) {
    const parsedMinutes = parseBroadcastPlannerTimeLabel(value);
    if (parsedMinutes === null) {
      return;
    }

    const nextMinutes = [...recipeDraft.minutes];
    nextMinutes[index] = normalizeBroadcastPlannerTimeMinutes(parsedMinutes);
    patchRecipeDraft({ minutes: nextMinutes });
  }

  function activateScheduledMode() {
    if (timingMode !== 'scheduled') {
      onTimingModeChange?.('scheduled');
    }
  }

  function selectTimingMode(nextMode: BroadcastTimingMode) {
    if (disabled || calendarOnly) {
      return;
    }

    onTimingModeChange?.(nextMode);
    setBroadcastModeSideEffects(nextMode);
    maxSelectionChanged();
  }

  function setBroadcastModeSideEffects(nextMode: BroadcastTimingMode) {
    setIsConfirmed(false);
    setPickedDayKeys([]);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setHasBlockingIssue(false);

    if (nextMode === 'scheduled') {
      setCalendarExpanded(normalizedValue.length > 0);
      if (scheduledDayKeys.length > 0) {
        setPickedDayKeys(scheduledDayKeys);
        setActiveDayKey(scheduledDayKeys[0] ?? activeDayKey);
      }
      return;
    }

    if (normalizedValue.length > 0) {
      onChange([]);
    }
    setCalendarExpanded(false);
  }

  function getMinuteChipState(minutes: number) {
    const selectedCountForTargets = targetDayKeys.filter((dayKey) =>
      isSlotSelectedForDay(dayKey, minutes),
    ).length;
    const pastRestrictionCount = targetDayKeys.filter(
      (dayKey) => isSlotInPast(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    ).length;
    const isSelected = selectedCountForTargets === targetDayKeys.length;
    const isMixed = selectedCountForTargets > 0 && selectedCountForTargets < targetDayKeys.length;
    const hasBusy = targetDayKeys.some(
      (dayKey) => isSlotBusy(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    );
    const hasPastRestriction = pastRestrictionCount > 0 && !isSelected && !isMixed;

    return {
      isSelected,
      isMixed,
      hasBusy,
      hasPastRestriction,
    };
  }

  function isSlotInPast(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    return new Date(slotIso).getTime() < minimumTime;
  }

  function isSlotBusy(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    const slotKey = getBroadcastSlotInstantKey(slotIso);
    return occupiedInstantSet.has(slotKey) && !selectedInstantSet.has(slotKey);
  }

  function isSlotSelectedForDay(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    const slotKey = getBroadcastSlotInstantKey(slotIso);
    return getSelectedDaySlots(dayKey, normalizedValue).some(
      (slot) => getBroadcastSlotInstantKey(slot) === slotKey,
    );
  }

  function hasAvailableTimeSlotForDay(dayKey: string): boolean {
    return SLOT_GROUPS.some((group) =>
      getMinutesList(group).some(
        (minutes) =>
          (!isSlotInPast(dayKey, minutes) || isSlotSelectedForDay(dayKey, minutes)) &&
          (!isSlotBusy(dayKey, minutes) || isSlotSelectedForDay(dayKey, minutes)),
      ),
    );
  }

  function findNextAvailableDayKey(dayKey: string): string | null {
    const cursor = new Date(`${dayKey}T12:00:00`);
    for (let offset = 1; offset <= BROADCAST_SCHEDULE_MAX_DAYS; offset += 1) {
      const candidateKey = getBroadcastScheduleDayKey(addDays(cursor, offset));
      if (startOfDay(new Date(`${candidateKey}T12:00:00`)).getTime() > windowEnd.getTime()) {
        return null;
      }
      if (hasAvailableTimeSlotForDay(candidateKey)) {
        return candidateKey;
      }
    }
    return null;
  }

  function openAgendaDay(dayKey: string) {
    activateScheduledMode();
    setActiveDayKey(dayKey);
    setAgendaDayKey(dayKey);
    setSheetMode('agenda');
    onOpenDay?.(dayKey);
    maxImpact('medium');
  }

  function togglePickedDay(dayKey: string) {
    if (disabled) {
      return;
    }

    activateScheduledMode();
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    setPickedDayKeys((current) => {
      const exists = current.includes(dayKey);
      const next = exists
        ? current.filter((item) => item !== dayKey)
        : sortDayKeys([...current, dayKey]);

      if (!exists) {
        setActiveDayKey(dayKey);
        onOpenDay?.(dayKey);
      } else if (activeDayKey === dayKey && next[0]) {
        setActiveDayKey(next[0]);
      }

      return next;
    });
    maxSelectionChanged();
  }

  function openTimeStep() {
    if (disabled || pickedDayKeys.length === 0) {
      return;
    }

    activateScheduledMode();
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    if (!pickedDayKeys.includes(activeDayKey)) {
      setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
    }
    setApplyToAllPickedDays(pickedDayKeys.length > 1);
    setAgendaDayKey(null);
    setSheetMode('time');
    maxImpact('medium');
  }

  function handleDockTimePointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse') {
      return;
    }

    event.preventDefault();
    openTimeStep();
  }

  function finishPickedSelection() {
    setPickedDayKeys([]);
    setApplyToAllPickedDays(false);
    setSheetMode(null);
    setAgendaDayKey(null);
    setIsConfirmed(normalizedValue.length > 0);
    setHasBlockingIssue(false);
  }

  function closeDaySheet() {
    setApplyToAllPickedDays(false);
    setSheetMode(null);
    setAgendaDayKey(null);
    maxImpact('soft');
  }

  function clearPickedSelection() {
    finishPickedSelection();
    maxImpact('soft');
  }

  function clearCalendarSchedule() {
    setPickedDayKeys([]);
    setApplyToAllPickedDays(false);
    setSheetMode(null);
    setAgendaDayKey(null);
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    if (normalizedValue.length > 0) {
      onChange([]);
    }
    maxImpact('soft');
  }

  function clearTargetDays() {
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    replaceSlotsForDays(targetDayKeys, () => []);
    maxImpact('soft');
  }

  function openTimeStepForAgendaDay() {
    if (disabled || !agendaDayKey) {
      return;
    }

    activateScheduledMode();
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    setPickedDayKeys([agendaDayKey]);
    setActiveDayKey(agendaDayKey);
    setApplyToAllPickedDays(false);
    setSheetMode('time');
    maxImpact('medium');
  }

  function pickFreeWindow(window: BroadcastFreeWindow) {
    if (disabled || !agendaDayKey) {
      return;
    }

    activateScheduledMode();
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    setPickedDayKeys([agendaDayKey]);
    setActiveDayKey(agendaDayKey);
    setApplyToAllPickedDays(false);
    setSheetMode('time');
    replaceSlotsForDays([agendaDayKey], (dayKey, currentSlots) => {
      const slotIso = buildBroadcastScheduleSlotIso(dayKey, window.startMinutes);
      return sortAndUniqueBroadcastSlots([...currentSlots, slotIso]);
    });
    maxImpact('medium');
  }

  function handleAgendaEdit(broadcastId: string) {
    if (disabled || !onEditBroadcast) {
      return;
    }

    setSheetMode(null);
    setAgendaDayKey(null);
    onEditBroadcast(broadcastId);
  }

  function handleAgendaDelete(broadcastId: string) {
    if (disabled || !onDeleteBroadcast) {
      return;
    }

    setSheetMode(null);
    setAgendaDayKey(null);
    onDeleteBroadcast(broadcastId);
  }

  function openScheduledDay(dayKey: string) {
    if (disabled) {
      return;
    }

    activateScheduledMode();
    setPickedDayKeys([dayKey]);
    setActiveDayKey(dayKey);
    setApplyToAllPickedDays(false);
    setAgendaDayKey(null);
    setSheetMode('time');
    setIsConfirmed(false);
    setHasBlockingIssue(false);
    onOpenDay?.(dayKey);
    maxImpact('medium');
  }

  function openScheduleSummary() {
    if (timingMode === 'cycle') {
      selectTimingMode('cycle');
      maxImpact('soft');
      return;
    }

    activateScheduledMode();
    setCalendarExpanded((current) => !current);
    if (scheduledDayKeys.length > 0 && pickedDayKeys.length === 0) {
      setPickedDayKeys(scheduledDayKeys);
      setActiveDayKey(scheduledDayKeys[0] ?? activeDayKey);
    }
    maxImpact('soft');
  }

  function focusCalendarDay(dayKey: string) {
    const targetDate = new Date(`${dayKey}T12:00:00`);
    const targetTime = startOfDay(targetDate).getTime();
    if (
      !Number.isFinite(targetTime) ||
      targetTime < windowStart.getTime() ||
      targetTime > windowEnd.getTime()
    ) {
      return;
    }

    const targetMonthKey = getMonthKey(targetDate);
    if (targetMonthKey !== visibleMonthKey) {
      pendingCalendarFocusDayKeyRef.current = dayKey;
      setCurrentMonthKey(targetMonthKey);
      return;
    }

    calendarGridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-broadcast-schedule-day="${dayKey}"]`)
      ?.focus();
  }

  function handleCalendarDayKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, dayKey: string) {
    const targetDayKey = getBroadcastPlannerKeyboardNavigationDayKey(
      dayKey,
      event.key,
      windowStart,
      windowEnd,
    );
    if (!targetDayKey) {
      return;
    }

    event.preventDefault();
    focusCalendarDay(targetDayKey);
  }

  function toggleSlot(minutes: number) {
    if (disabled) {
      return;
    }

    activateScheduledMode();
    setHasBlockingIssue(false);
    const hasPastRestriction = targetDayKeys.some(
      (dayKey) => isSlotInPast(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    );
    if (hasPastRestriction) {
      return;
    }

    const hasBusyRestriction = targetDayKeys.some(
      (dayKey) => isSlotBusy(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    );
    if (hasBusyRestriction) {
      return;
    }

    const shouldAdd = targetDayKeys.some((dayKey) => !isSlotSelectedForDay(dayKey, minutes));
    replaceSlotsForDays(targetDayKeys, (dayKey, currentSlots) => {
      const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
      return shouldAdd
        ? sortAndUniqueBroadcastSlots([...currentSlots, slotIso])
        : currentSlots.filter(
            (slot) => getBroadcastSlotInstantKey(slot) !== getBroadcastSlotInstantKey(slotIso),
          );
    });
    maxImpact(shouldAdd ? 'light' : 'soft');
  }

  function getCustomTimeError(value: string): string | undefined {
    const parsedMinutes = parseBroadcastPlannerTimeLabel(value);
    if (parsedMinutes === null) return undefined;
    const minutes = normalizeBroadcastPlannerTimeMinutes(parsedMinutes, minuteStep);
    const newDayKeys = targetDayKeys.filter((dayKey) => !isSlotSelectedForDay(dayKey, minutes));
    if (
      newDayKeys.some(
        (dayKey) =>
          Date.parse(buildBroadcastScheduleSlotIso(dayKey, minutes)) < Date.now() + minimumLeadMs,
      )
    )
      return 'Выберите более позднее время.';
    if (newDayKeys.some((dayKey) => isSlotBusy(dayKey, minutes)))
      return 'Это время занято. Выберите другое.';
    return undefined;
  }

  function addCustomTime(value: string) {
    if (disabled) return;
    setCustomTimeValue(value);
    const parsedMinutes = parseBroadcastPlannerTimeLabel(value);
    if (parsedMinutes === null || getCustomTimeError(value)) {
      return;
    }

    const minutes = normalizeBroadcastPlannerTimeMinutes(parsedMinutes, minuteStep);
    activateScheduledMode();
    setHasBlockingIssue(false);
    // FLAG: Entering a time adds it idempotently; only chips and explicit removal toggle it off.
    replaceSlotsForDays(targetDayKeys, (dayKey, currentSlots) => [
      ...currentSlots,
      buildBroadcastScheduleSlotIso(dayKey, minutes),
    ]);
    setCustomTimeValue('');
    maxImpact('light');
  }

  const monthCells = getMonthCells(visibleMonthKey);
  const scheduleReady =
    timingMode === 'now' ||
    timingMode === 'cycle' ||
    (timingMode === 'scheduled' && futureSlotCount > 0 && !hasBlockingIssue);
  const cycleStartInputValue = formatLocalDateTimeInputValue(normalizedCycle.startAt);
  const cycleStartMinValue = formatLocalDateTimeInputValue(new Date(liveNowMs + 30_000));
  const compactScheduleModeLabel =
    timingMode === 'now' ? 'Сейчас' : timingMode === 'cycle' ? 'Повтор' : 'Позже';
  const compactScheduleMeta =
    timingMode === 'now'
      ? 'сразу'
      : timingMode === 'cycle'
        ? formatBroadcastCycleSummary(normalizedCycle, liveNowMs)
        : futureSlotCount > 0
          ? [
              formatCountLabel(futureSlotCount, 'отправка', 'отправки', 'отправок'),
              formatCountLabel(selectedDayCount, 'день', 'дня', 'дней'),
            ].join(' · ')
          : 'Без времени';
  const compactScheduleSummary = `${compactScheduleModeLabel} · ${compactScheduleMeta}`;
  const compactSlotPreview =
    timingMode === 'scheduled' && futureSlots.length > 0
      ? [
          ...futureSlots.slice(0, 3).map((slot) => formatBroadcastScheduleSlot(slot)),
          futureSlots.length > 3 ? `+${futureSlots.length - 3}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  const compactScheduleAction =
    timingMode === 'scheduled'
      ? futureSlotCount > 0
        ? 'Изменить'
        : 'Выбрать даты'
      : 'Настроить время';

  return (
    <>
      <section
        className={cn(
          'broadcast-planner',
          calendarOnly && 'is-calendar-only',
          disabled && 'is-disabled',
        )}
      >
        <div className="broadcast-planner__calendar-card">
          {!calendarOnly ? (
            <>
              <div
                className={cn(
                  'broadcast-planner__mode-card',
                  calendarRefreshing && 'is-refreshing',
                )}
              >
                {showTimingModePicker ? (
                  <div className="broadcast-planner__intent-row" aria-label="Режим отправки">
                    {timingModeSet.has('now') ? (
                      <button
                        type="button"
                        className={cn(
                          'broadcast-planner__intent-chip',
                          timingMode === 'now' && 'is-active',
                        )}
                        onClick={() => selectTimingMode('now')}
                        disabled={disabled}
                        aria-pressed={timingMode === 'now'}
                      >
                        <strong>Сейчас</strong>
                        <small>сразу</small>
                      </button>
                    ) : null}
                    {timingModeSet.has('scheduled') ? (
                      <button
                        type="button"
                        className={cn(
                          'broadcast-planner__intent-chip',
                          timingMode === 'scheduled' && 'is-active',
                        )}
                        onClick={() => selectTimingMode('scheduled')}
                        disabled={disabled}
                        aria-pressed={timingMode === 'scheduled'}
                      >
                        <strong>Позже</strong>
                        <small>{futureSlotCount > 0 ? scheduleStatusLabel : 'даты'}</small>
                      </button>
                    ) : null}
                    {timingModeSet.has('cycle') ? (
                      <button
                        type="button"
                        className={cn(
                          'broadcast-planner__intent-chip',
                          'has-info',
                          timingMode === 'cycle' && 'is-active',
                        )}
                        onClick={() => selectTimingMode('cycle')}
                        disabled={disabled}
                        aria-pressed={timingMode === 'cycle'}
                        aria-label="Повтор автопостинга"
                        title="Повтор автопостинга"
                      >
                        <strong>Повтор</strong>
                        <small>
                          {formatBroadcastCycleIntervalLabel(normalizedCycle.everyHours)}
                        </small>
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  className={cn('broadcast-planner__compact-summary', scheduleReady && 'is-ready')}
                  onClick={openScheduleSummary}
                  disabled={disabled}
                  title={`Когда: ${compactScheduleSummary}`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${calendarGridId}-error` : undefined}
                >
                  <span className="broadcast-planner__compact-copy">
                    <small>Когда</small>
                    <strong>{compactScheduleSummary}</strong>
                    {compactSlotPreview ? <span>{compactSlotPreview}</span> : null}
                  </span>
                  <span className="broadcast-planner__compact-action">{compactScheduleAction}</span>
                </button>
              </div>
            </>
          ) : null}

          {showRecipe ? (
            <div className="broadcast-planner__recipe" aria-label="Серия отправок">
              <div className="broadcast-planner__recipe-actions is-top">
                <button
                  type="button"
                  className="broadcast-planner__recipe-calendar"
                  onClick={clearCalendarSchedule}
                  disabled={
                    disabled || (normalizedValue.length === 0 && pickedDayKeys.length === 0)
                  }
                >
                  Очистить
                </button>
              </div>

              <div className="broadcast-planner__recipe-grid">
                <div className="broadcast-planner__recipe-stepper">
                  <span>Дней</span>
                  <div>
                    <button
                      type="button"
                      onClick={() => patchRecipeDraft({ dayCount: recipeDraft.dayCount - 1 })}
                      disabled={disabled || recipeDraft.dayCount <= BROADCAST_RECIPE_MIN_DAYS}
                      aria-label="Меньше дней"
                    >
                      −
                    </button>
                    <strong>{recipeDraft.dayCount}</strong>
                    <button
                      type="button"
                      onClick={() => patchRecipeDraft({ dayCount: recipeDraft.dayCount + 1 })}
                      disabled={disabled || recipeDraft.dayCount >= BROADCAST_RECIPE_MAX_DAYS}
                      aria-label="Больше дней"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="broadcast-planner__recipe-stepper">
                  <span>Постов/день</span>
                  <div>
                    <button
                      type="button"
                      onClick={() => patchRecipeDraft({ postsPerDay: recipeDraft.postsPerDay - 1 })}
                      disabled={
                        disabled || recipeDraft.postsPerDay <= BROADCAST_RECIPE_MIN_POSTS_PER_DAY
                      }
                      aria-label="Меньше постов в день"
                    >
                      −
                    </button>
                    <strong>{recipeDraft.postsPerDay}</strong>
                    <button
                      type="button"
                      onClick={() => patchRecipeDraft({ postsPerDay: recipeDraft.postsPerDay + 1 })}
                      disabled={
                        disabled || recipeDraft.postsPerDay >= BROADCAST_RECIPE_MAX_POSTS_PER_DAY
                      }
                      aria-label="Больше постов в день"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div className="broadcast-planner__recipe-times" aria-label="Время публикаций">
                {recipeDraft.minutes.map((minutes, index) => (
                  <TimeField
                    key={`recipe-time-${index}`}
                    label={`${index + 1}`}
                    value={formatMinuteLabel(minutes)}
                    variant="compact"
                    minuteStep={30}
                    disabled={disabled}
                    onChange={(nextValue) => setRecipeTime(index, nextValue)}
                  />
                ))}
              </div>

              <div className="broadcast-planner__recipe-actions">
                <button
                  type="button"
                  className={cn(
                    'broadcast-planner__recipe-summary',
                    recipeApplied && 'is-ready',
                    recipePlan.issue && 'has-issue',
                  )}
                  onClick={() => applyRecipeDraft(recipeDraft)}
                  disabled={disabled || !recipePlan.isComplete}
                >
                  <strong>{recipeSummary}</strong>
                  <span>
                    {recipePlan.isComplete
                      ? `${formatCountLabel(recipeSlotCount, 'отправка', 'отправки', 'отправок')} · ${recipeTimeLabels.join(', ')}`
                      : recipeIssueLabel}
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    'broadcast-planner__recipe-calendar',
                    calendarExpanded && 'is-active',
                  )}
                  onClick={() => {
                    setCalendarExpanded((current) => !current);
                    maxSelectionChanged();
                  }}
                  disabled={disabled}
                  aria-expanded={calendarExpanded}
                  aria-controls={calendarGridId}
                >
                  Даты
                </button>
              </div>
            </div>
          ) : null}

          {showCalendar ? (
            <>
              {calendarOnly ? (
                <div
                  className={cn(
                    'broadcast-planner__calendar-context',
                    calendarRefreshing && 'is-refreshing',
                  )}
                >
                  <span
                    className="broadcast-planner__target-chip"
                    title={normalizedTargetContextLabel}
                  >
                    {normalizedTargetContextLabel}
                  </span>
                  {normalizedTargetContextMeta ? (
                    <small>{normalizedTargetContextMeta}</small>
                  ) : null}
                </div>
              ) : null}

              <div className="broadcast-planner__calendar-head">
                <button
                  type="button"
                  className="broadcast-planner__month-button"
                  onClick={() => {
                    const currentIndex = monthKeys.indexOf(visibleMonthKey);
                    if (currentIndex > 0) {
                      setCurrentMonthKey(monthKeys[currentIndex - 1] ?? visibleMonthKey);
                      maxSelectionChanged();
                    }
                  }}
                  disabled={disabled || monthKeys.indexOf(visibleMonthKey) <= 0}
                  aria-label="Предыдущий месяц"
                >
                  ←
                </button>
                <strong aria-live="polite">{formatMonthKey(visibleMonthKey)}</strong>
                <button
                  type="button"
                  className="broadcast-planner__month-button"
                  onClick={() => {
                    const currentIndex = monthKeys.indexOf(visibleMonthKey);
                    if (currentIndex >= 0 && currentIndex < monthKeys.length - 1) {
                      setCurrentMonthKey(monthKeys[currentIndex + 1] ?? visibleMonthKey);
                      maxSelectionChanged();
                    }
                  }}
                  disabled={disabled || monthKeys.indexOf(visibleMonthKey) >= monthKeys.length - 1}
                  aria-label="Следующий месяц"
                >
                  →
                </button>
              </div>

              <div className="broadcast-planner__weekdays" aria-hidden>
                {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, index) => (
                  <span key={`${label}-${index}`}>{label}</span>
                ))}
              </div>

              <div
                ref={calendarGridRef}
                id={calendarGridId}
                className="broadcast-planner__grid"
                role="group"
                aria-label={`Календарь: ${formatMonthKey(visibleMonthKey)}`}
              >
                {monthCells.map((cell) => {
                  const dayKey = getBroadcastScheduleDayKey(cell);
                  const daySlots = getSelectedDaySlots(dayKey, normalizedValue);
                  const agendaCount = (agendaEntriesByDay.get(dayKey) ?? []).length;
                  const dayBusySlots = (occupiedSlotsByDay.get(dayKey) ?? []).filter(
                    (slot) => !selectedInstantSet.has(getBroadcastSlotInstantKey(slot)),
                  );
                  const busyCount = dayBusySlots.length;
                  const freeWindowCount = buildFreeWindowsForDay(dayBusySlots).length;
                  const hasFreeWindows = freeWindowCount > 0;
                  const isDenseDay = busyCount + daySlots.length >= 4 || agendaCount >= 3;
                  const isOutsideMonth = getMonthKey(cell) !== visibleMonthKey;
                  const isBeforeWindow = startOfDay(cell).getTime() < windowStart.getTime();
                  const isAfterWindow = startOfDay(cell).getTime() > windowEnd.getTime();
                  const isDisabled = disabled || isBeforeWindow || isAfterWindow;
                  const isToday = dayKey === liveTodayKey;
                  const isActive = dayKey === activeDayKey;
                  const isPicked = pickedDaySet.has(dayKey);
                  const dayAriaLabelParts = [formatDayChipLabel(dayKey)];

                  if (isToday) {
                    dayAriaLabelParts.push('сегодня');
                  }

                  if (daySlots.length > 0) {
                    dayAriaLabelParts.push(
                      `${formatCountLabel(
                        daySlots.length,
                        'отправка',
                        'отправки',
                        'отправок',
                      )} настроено`,
                    );
                  } else if (isPicked) {
                    dayAriaLabelParts.push('выбран для настройки');
                  } else if (agendaCount > 0) {
                    dayAriaLabelParts.push(
                      `${formatCountLabel(agendaCount, 'автопостинг', 'автопостинга', 'автопостингов')} запланировано`,
                    );
                  } else if (busyCount > 0) {
                    dayAriaLabelParts.push('есть занятое время');
                  }
                  if (hasFreeWindows) {
                    dayAriaLabelParts.push('есть свободное окно');
                  }

                  return (
                    <button
                      key={`${visibleMonthKey}-${dayKey}`}
                      type="button"
                      className={cn(
                        'broadcast-planner__day',
                        isOutsideMonth && 'is-outside',
                        daySlots.length > 0 && 'is-selected',
                        busyCount > 0 && 'is-busy',
                        hasFreeWindows && 'has-free-window',
                        isDenseDay && 'is-dense',
                        isToday && 'is-today',
                        isPicked && 'is-picked',
                        isActive && isPicked && 'is-active',
                      )}
                      disabled={isDisabled}
                      data-broadcast-schedule-day={dayKey}
                      aria-current={isToday ? 'date' : undefined}
                      aria-pressed={isPicked}
                      aria-label={dayAriaLabelParts.join(', ')}
                      onKeyDown={(event) => handleCalendarDayKeyDown(event, dayKey)}
                      onClick={() => {
                        const hasAgendaEntries = agendaCount > 0;
                        const hasDraftSlots = daySlots.length > 0;
                        if (
                          hasAgendaEntries &&
                          pickedDayKeys.length === 0 &&
                          !pickedDaySet.has(dayKey) &&
                          !hasDraftSlots
                        ) {
                          openAgendaDay(dayKey);
                          return;
                        }

                        if (
                          hasDraftSlots &&
                          pickedDayKeys.length === 0 &&
                          !pickedDaySet.has(dayKey)
                        ) {
                          openScheduledDay(dayKey);
                          return;
                        }

                        togglePickedDay(dayKey);
                      }}
                    >
                      {isPicked ? (
                        <span className="broadcast-planner__day-marker">✓</span>
                      ) : isToday ? (
                        <span className="broadcast-planner__day-today-dot" aria-hidden />
                      ) : null}
                      <div className="broadcast-planner__day-head">
                        <span className="broadcast-planner__day-number">{cell.getDate()}</span>
                      </div>
                      <div className="broadcast-planner__day-foot">
                        <span className="broadcast-planner__day-foot-main">
                          {daySlots.length > 0 ? (
                            <span
                              className={cn(
                                'broadcast-planner__day-density',
                                isPicked && 'is-picked',
                                isActive && isPicked && 'is-active',
                              )}
                              aria-hidden
                            >
                              {formatDayDensityLabel(daySlots.length)}
                            </span>
                          ) : !isPicked && agendaCount > 0 ? (
                            <span className="broadcast-planner__day-count" aria-hidden>
                              {agendaCount}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            'broadcast-planner__day-signals',
                            isPicked && daySlots.length === 0 && 'is-picked',
                            !isPicked &&
                              busyCount === 0 &&
                              !hasFreeWindows &&
                              daySlots.length === 0 &&
                              'is-empty',
                          )}
                          aria-hidden
                        >
                          {busyCount > 0 ? (
                            <span
                              className={cn(
                                'broadcast-planner__day-signal',
                                isDenseDay ? 'is-dense' : 'is-busy',
                              )}
                            />
                          ) : null}
                          {hasFreeWindows ? (
                            <span className="broadcast-planner__day-signal is-free" />
                          ) : null}
                          {daySlots.length > 0 || isPicked ? (
                            <span className="broadcast-planner__day-signal is-selected" />
                          ) : null}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {timingMode === 'cycle' && !calendarOnly ? (
            <div className="broadcast-planner__cycle-card">
              <div className="broadcast-planner__cycle-grid">
                <div className="broadcast-planner__cycle-field">
                  <span>Старт</span>
                  <div className="broadcast-planner__cycle-toggle">
                    <button
                      type="button"
                      className={cn(
                        'broadcast-planner__cycle-toggle-button',
                        normalizedCycle.startMode === 'now' && 'is-active',
                      )}
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            startMode: 'now',
                          }),
                        )
                      }
                      disabled={disabled}
                    >
                      Сейчас
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'broadcast-planner__cycle-toggle-button',
                        normalizedCycle.startMode === 'later' && 'is-active',
                      )}
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            startMode: 'later',
                          }),
                        )
                      }
                      disabled={disabled}
                    >
                      Позже
                    </button>
                  </div>
                  {normalizedCycle.startMode === 'later' ? (
                    <input
                      type="datetime-local"
                      value={cycleStartInputValue}
                      min={cycleStartMinValue}
                      onChange={(event) => {
                        const nextStartAt = parseLocalDateTimeInputValue(event.target.value);
                        if (nextStartAt) {
                          onCycleChange?.(
                            normalizeBroadcastCycleDraft({
                              ...normalizedCycle,
                              startMode: 'later',
                              startAt: nextStartAt,
                            }),
                          );
                        }
                      }}
                      disabled={disabled}
                      aria-label="Старт цикла"
                    />
                  ) : null}
                </div>

                <div className="broadcast-planner__cycle-field">
                  <span>Каждые</span>
                  <div className="broadcast-planner__cycle-intervals">
                    {BROADCAST_CYCLE_INTERVAL_OPTIONS.map((hours) => (
                      <button
                        key={hours}
                        type="button"
                        className={cn(
                          'broadcast-planner__cycle-interval',
                          normalizedCycle.everyHours === hours && 'is-active',
                        )}
                        onClick={() =>
                          onCycleChange?.(
                            normalizeBroadcastCycleDraft({
                              ...normalizedCycle,
                              everyHours: hours,
                            }),
                          )
                        }
                        disabled={disabled}
                      >
                        {formatBroadcastCycleIntervalLabel(hours)}
                      </button>
                    ))}
                  </div>
                  <label className="broadcast-planner__cycle-number">
                    <input
                      type="number"
                      min={1}
                      max={BROADCAST_CYCLE_MAX_HOURS}
                      value={normalizedCycle.everyHours}
                      onChange={(event) =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            everyHours: clampBroadcastCycleEveryHours(Number(event.target.value)),
                          }),
                        )
                      }
                      disabled={disabled}
                      aria-label="Период повтора в часах"
                    />
                    <small>ч</small>
                  </label>
                </div>

                <div className="broadcast-planner__cycle-field">
                  <span>Повторы</span>
                  <div className="broadcast-planner__cycle-stepper">
                    <button
                      type="button"
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            count: clampBroadcastCycleCount(normalizedCycle.count - 1),
                          }),
                        )
                      }
                      disabled={disabled || normalizedCycle.count <= 2}
                      aria-label="Меньше повторов"
                    >
                      −
                    </button>
                    <strong>{normalizedCycle.count}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            count: clampBroadcastCycleCount(normalizedCycle.count + 1),
                          }),
                        )
                      }
                      disabled={disabled || normalizedCycle.count >= 100}
                      aria-label="Больше повторов"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div className={cn('broadcast-planner__dock', 'is-cycle')}>
                <div className="broadcast-planner__dock-copy">
                  <strong>{formatBroadcastCycleSummary(normalizedCycle, liveNowMs)}</strong>
                  <small>до {formatBroadcastCycleLastSendLabel(normalizedCycle, liveNowMs)}</small>
                </div>
              </div>
            </div>
          ) : showCalendar && pickedDayKeys.length > 0 ? (
            <div className="broadcast-planner__dock">
              <div className="broadcast-planner__dock-copy">
                <strong>{pickedDaySummary}</strong>
                <small>
                  {pickedSlotsCount > 0
                    ? `${formatCountLabel(
                        pickedSlotsCount,
                        'отправка',
                        'отправки',
                        'отправок',
                      )} · ${pickedDayLabel}`
                    : pickedDayLabel}
                </small>
              </div>
              <div className="broadcast-planner__dock-actions">
                <button
                  type="button"
                  className="broadcast-planner__dock-clear"
                  onClick={clearPickedSelection}
                  disabled={disabled}
                  aria-label="Снять выбор дней"
                >
                  ×
                </button>
                <button
                  type="button"
                  className="broadcast-planner__dock-primary"
                  onPointerUp={handleDockTimePointerUp}
                  onClick={openTimeStep}
                  disabled={disabled || pickedDayKeys.length === 0}
                >
                  Время
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {error ? (
          <small id={`${calendarGridId}-error`} className="broadcast-planner__error">
            {error}
          </small>
        ) : null}
      </section>

      {typeof document !== 'undefined' &&
      isDaySheetOpen &&
      (sheetMode === 'agenda' || pickedDayKeys.length > 0)
        ? createPortal(
            <div className="broadcast-planner-sheet" aria-hidden={!isDaySheetOpen}>
              <button
                type="button"
                className="broadcast-planner-sheet__backdrop"
                aria-label="Закрыть выбор времени"
                onClick={closeDaySheet}
              />

              <section
                ref={sheetPanelRef}
                className="broadcast-planner-sheet__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="broadcast-planner-sheet-title"
                tabIndex={-1}
              >
                <div className="broadcast-planner-sheet__grabber" aria-hidden />

                <div className="broadcast-planner__sheet">
                  <div className="broadcast-planner__sheet-head">
                    <div>
                      <strong id="broadcast-planner-sheet-title">
                        {sheetMode === 'agenda'
                          ? formatBroadcastScheduleDay(agendaDayKey ?? activeDayKey)
                          : applyToAllPickedDays && pickedDayKeys.length > 1
                            ? pickedDaySummary
                            : formatBroadcastScheduleDay(activeDayKey)}
                      </strong>
                      <small>
                        {showAgendaSkeleton
                          ? 'Обновляем...'
                          : sheetMode === 'agenda'
                            ? `${formatCountLabel(
                                agendaDayEntries.length,
                                'автопостинг',
                                'автопостинга',
                                'автопостингов',
                              )} · ${formatCountLabel(
                                agendaSlotCount,
                                'отправка',
                                'отправки',
                                'отправок',
                              )}`
                            : applyToAllPickedDays && pickedDayKeys.length > 1
                              ? `${pickedDayLabel} · общее время`
                              : activeDaySlots.length > 0
                                ? `${formatCountLabel(
                                    activeDaySlots.length,
                                    'отправка',
                                    'отправки',
                                    'отправок',
                                  )} выбрано`
                                : 'Время'}
                      </small>
                    </div>

                    <div className="broadcast-planner__sheet-facts">
                      <button
                        type="button"
                        className="broadcast-planner__clear-button"
                        onClick={closeDaySheet}
                        disabled={disabled}
                        aria-label={sheetMode === 'agenda' ? 'Закрыть день' : 'Назад к календарю'}
                      >
                        {sheetMode === 'agenda' ? '×' : '←'}
                      </button>
                    </div>
                  </div>

                  {sheetMode === 'agenda' ? (
                    <>
                      {agendaFreeWindows.length > 0 ? (
                        <div
                          className="broadcast-planner__free-windows"
                          aria-label="Свободное время"
                        >
                          {agendaFreeWindows.map((window) => (
                            <button
                              key={`${agendaDayKey}-${window.id}`}
                              type="button"
                              className="broadcast-planner__free-window"
                              onClick={() => pickFreeWindow(window)}
                              disabled={disabled}
                            >
                              {window.label}
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {showAgendaSkeleton ? (
                        <div className="broadcast-planner__day-agenda-skeleton-list" aria-hidden>
                          {Array.from({ length: 2 }).map((_, index) => (
                            <div
                              key={`agenda-skeleton-${index}`}
                              className="broadcast-planner__day-agenda-skeleton-card"
                              style={{ animationDelay: `${index * 48}ms` }}
                            >
                              <span className="broadcast-planner__day-agenda-skeleton-line is-title" />
                              <span className="broadcast-planner__day-agenda-skeleton-line is-meta" />
                              <div className="broadcast-planner__day-agenda-skeleton-chips">
                                <span />
                                <span />
                                <span />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="broadcast-planner__day-agenda-list">
                          {agendaDayEntries.map((entry, index) => {
                            const isEditing = pendingEditBroadcastId === entry.id;
                            const isDeleting = pendingDeleteBroadcastId === entry.id;
                            const statusLabel = isEditing ? 'Открываем...' : entry.statusLabel;
                            const statusTone = isEditing ? 'active' : entry.tone;

                            const content = (
                              <>
                                <div className="broadcast-planner__day-agenda-head">
                                  <div className="broadcast-planner__day-agenda-copy">
                                    <div className="broadcast-planner__day-agenda-title-row">
                                      <MaxMarkdownPreview
                                        value={entry.previewSource}
                                        className="broadcast-planner__day-agenda-preview max-markdown-preview--clamp-2"
                                        normalizeWhitespace
                                        fallback={entry.title}
                                      />
                                      {entry.canEdit ? (
                                        <span
                                          className="broadcast-planner__day-agenda-chevron"
                                          aria-hidden
                                        >
                                          →
                                        </span>
                                      ) : null}
                                    </div>
                                    {statusLabel ? (
                                      <span
                                        className={cn(
                                          'broadcast-planner__day-agenda-status',
                                          `is-${statusTone}`,
                                        )}
                                      >
                                        {statusLabel}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="broadcast-planner__day-agenda-times">
                                  {entry.timeSlots.map((slot) => (
                                    <span
                                      key={`${entry.id}-${slot}`}
                                      className="broadcast-planner__day-agenda-time"
                                    >
                                      {formatAgendaTime(slot)}
                                    </span>
                                  ))}
                                </div>

                                {entry.facts.length > 0 ? (
                                  <div className="broadcast-planner__day-agenda-facts">
                                    {entry.facts.map((fact) => (
                                      <span key={`${entry.id}-${fact}`}>{fact}</span>
                                    ))}
                                  </div>
                                ) : null}
                              </>
                            );

                            return (
                              <article
                                key={`${entry.dayKey}-${entry.id}`}
                                className={cn(
                                  'broadcast-planner__day-agenda-card',
                                  `is-${entry.tone}`,
                                  entry.canEdit && 'is-editable',
                                )}
                                style={{ animationDelay: `${Math.min(index, 5) * 36}ms` }}
                              >
                                {entry.canEdit ? (
                                  <button
                                    type="button"
                                    className="broadcast-planner__day-agenda-surface"
                                    onClick={() => handleAgendaEdit(entry.id)}
                                    disabled={disabled || isDeleting}
                                  >
                                    {content}
                                  </button>
                                ) : (
                                  <div
                                    className={cn(
                                      'broadcast-planner__day-agenda-surface',
                                      'is-static',
                                    )}
                                  >
                                    {content}
                                  </div>
                                )}

                                {entry.canEdit ? (
                                  <div className="broadcast-planner__day-agenda-actions">
                                    <button
                                      type="button"
                                      className="broadcast-planner__day-agenda-delete"
                                      onClick={() => handleAgendaDelete(entry.id)}
                                      disabled={disabled || isDeleting || isEditing}
                                      aria-label="Удалить публикацию"
                                      title="Удалить публикацию"
                                    >
                                      {isDeleting ? '...' : '×'}
                                    </button>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      )}

                      <div className="broadcast-planner__sheet-footer">
                        <button
                          type="button"
                          className="broadcast-planner__sheet-submit"
                          onClick={openTimeStepForAgendaDay}
                          disabled={disabled || !agendaDayKey}
                        >
                          Добавить
                        </button>
                      </div>
                    </>
                  ) : pickedDayKeys.length > 1 ? (
                    <>
                      <div className="broadcast-planner__day-tabs">
                        {pickedDayKeys.map((dayKey) => (
                          <button
                            key={dayKey}
                            type="button"
                            className={cn(
                              'broadcast-planner__day-tab',
                              dayKey === activeDayKey && !applyToAllPickedDays && 'is-active',
                              getSelectedDaySlots(dayKey, normalizedValue).length > 0 &&
                                'has-slots',
                            )}
                            onClick={() => {
                              setActiveDayKey(dayKey);
                              setApplyToAllPickedDays(false);
                              maxSelectionChanged();
                            }}
                          >
                            <strong>{formatDayChipLabel(dayKey)}</strong>
                            <small>{getSelectedDaySlots(dayKey, normalizedValue).length}</small>
                          </button>
                        ))}
                      </div>

                      <div className="broadcast-planner__mode-row">
                        <button
                          type="button"
                          className={cn(
                            'broadcast-planner__mode-chip',
                            !applyToAllPickedDays && 'is-active',
                          )}
                          onClick={() => setApplyToAllPickedDays(false)}
                        >
                          По дням
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'broadcast-planner__mode-chip',
                            applyToAllPickedDays && 'is-active',
                          )}
                          onClick={() => setApplyToAllPickedDays(true)}
                        >
                          Для всех
                        </button>
                      </div>
                    </>
                  ) : null}

                  {sheetMode === 'time' ? (
                    <>
                      {!hasAnyAvailableTimeSlot ? (
                        <div className="broadcast-planner__time-empty" role="status">
                          <strong>Нет доступного времени</strong>
                          {nextAvailableDayKey ? (
                            <button
                              type="button"
                              onClick={() => {
                                setPickedDayKeys([nextAvailableDayKey]);
                                setActiveDayKey(nextAvailableDayKey);
                                setApplyToAllPickedDays(false);
                                maxSelectionChanged();
                              }}
                              disabled={disabled}
                            >
                              {formatDayChipLabel(nextAvailableDayKey)}
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                      {selectedTargetMinuteLabels.length > 0 ? (
                        <div
                          className="broadcast-planner__selected-strip"
                          aria-label="Выбранное время"
                        >
                          {selectedTargetMinuteLabels.map((label) =>
                            preciseTime ? (
                              <button
                                key={label}
                                type="button"
                                className="broadcast-planner__selected-chip is-removable"
                                aria-label={`Удалить время ${label}`}
                                title={`Удалить время ${label}`}
                                disabled={disabled}
                                onClick={() => {
                                  const minutes = parseBroadcastPlannerTimeLabel(label);
                                  if (minutes !== null) toggleSlot(minutes);
                                }}
                              >
                                <span>{label}</span>
                                <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
                              </button>
                            ) : (
                              <span key={label} className="broadcast-planner__selected-chip">
                                {label}
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}

                      <div className="broadcast-planner__custom-time">
                        <TimeField
                          label={preciseTime ? 'Точное время' : '+ время'}
                          value={customTimeValue}
                          placeholder={preciseTime ? 'Точное время' : '+ время'}
                          allowEmpty
                          clearLabel="Очистить"
                          variant="compact"
                          minuteStep={minuteStep}
                          precise={preciseTime}
                          disabled={disabled}
                          error={getCustomTimeError(customTimeValue)}
                          onChange={addCustomTime}
                        />
                      </div>

                      {SLOT_GROUPS.map((group) => (
                        <div key={group.label} className="broadcast-planner__time-group">
                          <div className="broadcast-planner__time-group-head">
                            <strong>{group.label}</strong>
                          </div>
                          <div className="broadcast-planner__time-grid">
                            {getMinutesList(group).map((minutes) => {
                              const chipState = getMinuteChipState(minutes);

                              return (
                                <button
                                  key={`${group.label}-${minutes}`}
                                  type="button"
                                  className={cn(
                                    'broadcast-planner__time-chip',
                                    chipState.isSelected && 'is-selected',
                                    chipState.isMixed && 'is-mixed',
                                    chipState.hasBusy && 'is-busy',
                                    chipState.hasPastRestriction && 'is-disabled',
                                  )}
                                  aria-label={
                                    chipState.hasBusy
                                      ? `${formatMinuteLabel(minutes)}, занято`
                                      : formatMinuteLabel(minutes)
                                  }
                                  onClick={() => toggleSlot(minutes)}
                                  disabled={
                                    disabled || chipState.hasPastRestriction || chipState.hasBusy
                                  }
                                >
                                  <strong>{formatMinuteLabel(minutes)}</strong>
                                  {chipState.hasBusy ? (
                                    <span className="broadcast-planner__info-mark" aria-hidden>
                                      Занято
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      <div className="broadcast-planner__sheet-footer">
                        <button
                          type="button"
                          className="broadcast-planner__review-link"
                          onClick={clearTargetDays}
                          disabled={disabled}
                        >
                          Сбросить время
                        </button>
                        <button
                          type="button"
                          className="broadcast-planner__sheet-submit"
                          onClick={() => {
                            finishPickedSelection();
                            maxImpact('soft');
                          }}
                          disabled={disabled}
                        >
                          Готово
                          {pickedSlotsCount > 0 ? <small>{pickedSlotsCount}</small> : null}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
