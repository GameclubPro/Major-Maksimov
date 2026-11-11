import { AppIcon as IconoirSprite } from '../ui/app-icon';
import type {
  ChannelStatsBucket,
  ChannelStatsRange,
  ChannelStatsResponse,
  ChannelStatsSummary,
} from '@maxim/contracts/channel-stats';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { SegmentedControl } from '../ui/segmented-control';
import { formatCount, formatPeriodRange, periodOptions } from '../../lib/channel-stats-format';
import {
  formatChannelStatsHourTick,
  resolveAudienceChartAverageGrowthLabel,
  resolveAudienceChartDisplayValue,
  resolveChannelReachMetric,
  resolveChannelStatsSliderIndex,
  resolveInitialAudienceChartIndex,
  shouldRenderChannelStatsPointMarkers,
} from '../../lib/channel-stats-chart';

type AudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  displayValue: number | null;
  plotValue: number;
  deltaFromPrevious: number | null;
  deltaPercentFromPrevious: number | null;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
  joinedFlowY: number;
  leftFlowY: number;
  source: ChannelStatsSummary['daily'][number]['source'];
  confidence: ChannelStatsSummary['daily'][number]['confidence'];
};

type PreviousAudienceChartPoint = {
  at: string;
  participantsCount: number | null;
  displayValue: number;
  joined: number;
  left: number;
  net: number;
  cumulativeNet: number;
  x: number;
  y: number;
  source: ChannelStatsSummary['daily'][number]['source'];
  confidence: ChannelStatsSummary['daily'][number]['confidence'];
};

type AudienceChartModel = {
  width: number;
  points: AudienceChartPoint[];
  previousPoints: PreviousAudienceChartPoint[];
  linePath: string;
  areaPath: string;
  joinedFlowPath: string;
  joinedFlowLinePath: string;
  leftFlowPath: string;
  leftFlowLinePath: string;
  previousLinePath: string;
  hasLine: boolean;
  hasPreviousLine: boolean;
  hasJoinedFlow: boolean;
  hasLeftFlow: boolean;
  guideYs: number[];
  dividerY: number;
  activityRailY: number;
  eventRailY: number;
  zeroY: number;
  height: number;
  leftPad: number;
  rightPad: number;
  plotTop: number;
  plotBottom: number;
  floorY: number;
  axisLabels: Array<{ y: number; label: string }>;
};

const dayShortLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

const CHART_VIEWBOX_WIDTH = 390;

const CHART_VIEWBOX_HEIGHT = 260;

const AUDIENCE_CHART_LEFT_PAD = 52;

const AUDIENCE_CHART_RIGHT_PAD = 8;

const COMPACT_COUNT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const DENSE_COUNT_FORMATTER = new Intl.NumberFormat('ru-RU', { useGrouping: false });

const DAY_MONTH_NUMERIC_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Moscow',
});

const CHART_DETAIL_HOUR_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});

const CHART_DETAIL_DAY_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'long',
  timeZone: 'Europe/Moscow',
});

const PERCENT_ONE_DECIMAL_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const POST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});

const SIGNED_PERCENT_FORMATTERS = new Map<number, Intl.NumberFormat>();

const SIGNED_DECIMAL_FORMATTERS = new Map<string, Intl.NumberFormat>();

function getSignedPercentFormatter(maximumFractionDigits: number): Intl.NumberFormat {
  const normalizedDigits = Math.max(0, Math.trunc(maximumFractionDigits));
  const cached = SIGNED_PERCENT_FORMATTERS.get(normalizedDigits);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: normalizedDigits,
  });
  SIGNED_PERCENT_FORMATTERS.set(normalizedDigits, formatter);
  return formatter;
}

function getSignedDecimalFormatter(
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): Intl.NumberFormat {
  const normalizedMinimum = Math.max(0, Math.trunc(minimumFractionDigits));
  const normalizedMaximum = Math.max(normalizedMinimum, Math.trunc(maximumFractionDigits));
  const key = `${normalizedMinimum}:${normalizedMaximum}`;
  const cached = SIGNED_DECIMAL_FORMATTERS.get(key);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: normalizedMinimum,
    maximumFractionDigits: normalizedMaximum,
  });
  SIGNED_DECIMAL_FORMATTERS.set(key, formatter);
  return formatter;
}

function formatAudienceCount(
  value: number | null,
  confidence: ChannelStatsSummary['daily'][number]['confidence'] | null | undefined,
): string {
  const formatted = formatCount(value);
  return formatted !== '—' && confidence === 'medium' ? `~${formatted}` : formatted;
}

function formatCompactCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (Math.abs(value) < 100_000) {
    return formatCount(value);
  }

  return COMPACT_COUNT_FORMATTER.format(value);
}

function formatDenseCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);

  if (absolute < 100_000) {
    return DENSE_COUNT_FORMATTER.format(value);
  }

  return COMPACT_COUNT_FORMATTER.format(value);
}

function formatSummaryTableDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly) {
    return `${dateOnly[3]}.${dateOnly[2]}`;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return DAY_MONTH_NUMERIC_FORMATTER.format(parsed);
}

function formatChartDayMonth(value: string | null): string {
  if (!value) {
    return '—';
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly) {
    return `${dateOnly[3]}.${dateOnly[2]}`;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '—';
  }

  return DAY_MONTH_NUMERIC_FORMATTER.format(parsed);
}

function formatMoscowDateKey(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  return new Date(parsed.getTime() + 3 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function formatChartDetailDate(value: string | null, bucket: ChannelStatsBucket): string {
  if (!value) {
    return 'Нет данных';
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Нет данных';
  }

  if (bucket === 'hour') {
    return CHART_DETAIL_HOUR_FORMATTER.format(parsed);
  }

  return CHART_DETAIL_DAY_FORMATTER.format(parsed);
}

function formatSignedCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  const formatted = formatCount(Math.abs(value));
  if (value > 0) {
    return `+${formatted}`;
  }

  if (value < 0) {
    return `-${formatted}`;
  }

  return '0';
}

function formatDenseSignedCount(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  if (value > 0) {
    return `+${formatDenseCount(value)}`;
  }

  if (value < 0) {
    return `-${formatDenseCount(Math.abs(value))}`;
  }

  return '0';
}

function formatPercent(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return `${PERCENT_ONE_DECIMAL_FORMATTER.format(value)}%`;
}

function formatSignedPercent(value: number | null, maximumFractionDigits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  const formatted = getSignedPercentFormatter(maximumFractionDigits)
    .format(Math.abs(value))
    .replace(',', '.');

  if (value > 0) {
    return `+${formatted}%`;
  }

  if (value < 0) {
    return `-${formatted}%`;
  }

  return '0%';
}

function formatSignedDecimalCount(value: number | null, maximumFractionDigits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  const formatted = getSignedDecimalFormatter(
    Number.isInteger(value) ? 0 : Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  )
    .format(Math.abs(value))
    .replace(',', '.');

  if (value > 0) {
    return `+${formatted}`;
  }

  if (value < 0) {
    return `-${formatted}`;
  }

  return formatted;
}

function readNullableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hasAudienceDisplayValue<T extends { displayValue: number | null }>(
  point: T,
): point is T & { displayValue: number } {
  return typeof point.displayValue === 'number' && Number.isFinite(point.displayValue);
}

function resolveAudiencePlotValue<T extends { displayValue: number | null }>(
  points: readonly T[],
  index: number,
): number | null {
  const ownValue = points[index]?.displayValue;
  if (typeof ownValue === 'number' && Number.isFinite(ownValue)) {
    return ownValue;
  }

  let previousIndex = -1;
  let previousValue: number | null = null;
  for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidateValue = points[candidateIndex]?.displayValue;
    if (typeof candidateValue === 'number' && Number.isFinite(candidateValue)) {
      previousIndex = candidateIndex;
      previousValue = candidateValue;
      break;
    }
  }

  let nextIndex = -1;
  let nextValue: number | null = null;
  for (let candidateIndex = index + 1; candidateIndex < points.length; candidateIndex += 1) {
    const candidateValue = points[candidateIndex]?.displayValue;
    if (typeof candidateValue === 'number' && Number.isFinite(candidateValue)) {
      nextIndex = candidateIndex;
      nextValue = candidateValue;
      break;
    }
  }

  if (previousValue !== null && nextValue !== null) {
    const span = Math.max(1, nextIndex - previousIndex);
    const progress = (index - previousIndex) / span;
    return previousValue + (nextValue - previousValue) * progress;
  }

  return previousValue ?? nextValue;
}

function resolveChannelStatsSummary(stats: ChannelStatsResponse): ChannelStatsSummary {
  const maybeSummary = (stats as Partial<ChannelStatsResponse>).summary;
  if (maybeSummary) {
    const subscribers = maybeSummary.subscribers;
    return {
      ...maybeSummary,
      subscribers: {
        ...subscribers,
        todayJoined: subscribers.todayJoined ?? null,
        todayLeft: subscribers.todayLeft ?? null,
      },
      daily: maybeSummary.daily.map((row) => {
        return {
          ...row,
          joined: readNullableCount(row.joined),
          left: readNullableCount(row.left),
          source: row.source ?? 'unavailable',
          confidence: row.confidence ?? 'low',
        };
      }),
    };
  }

  const currentSubscribers = stats.channel.participantsCount;
  const joined = stats.official.audience.joined ?? 0;
  const left = stats.official.audience.left ?? 0;
  const weekDelta = stats.official.audience.net ?? joined - left;
  const displayViews = stats.official.content.views;
  const perPost =
    stats.official.content.posts > 0
      ? Math.round(displayViews / stats.official.content.posts)
      : null;
  const dailyByDate = new Map<string, number | null>();
  stats.official.series.participants
    .slice()
    .sort((leftPoint, rightPoint) => leftPoint.at.localeCompare(rightPoint.at))
    .forEach((point) => {
      const date = formatMoscowDateKey(point.at);
      if (date) {
        dailyByDate.set(date, point.participantsCount);
      }
    });
  const todayDate = formatMoscowDateKey(stats.period.to);
  if (todayDate && typeof currentSubscribers === 'number') {
    dailyByDate.set(todayDate, currentSubscribers);
  }
  const dailySource = Array.from(dailyByDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .slice(-16);
  const membershipByDate = new Map<string, { joined: number; left: number }>();
  stats.official.series.membership.forEach((point) => {
    const date = formatMoscowDateKey(point.at);
    if (!date) {
      return;
    }

    const current = membershipByDate.get(date) ?? { joined: 0, left: 0 };
    current.joined += point.joined;
    current.left += point.left ?? 0;
    membershipByDate.set(date, current);
  });
  const daily: ChannelStatsSummary['daily'] = dailySource.map(
    ([date, subscribers], index, rows) => {
      const previous = index > 0 ? rows[index - 1]?.[1] : null;
      const flow = membershipByDate.get(date) ?? null;

      return {
        date,
        subscribers,
        delta:
          subscribers === null || previous === null || previous === undefined
            ? null
            : subscribers - previous,
        joined: flow?.joined ?? null,
        left: flow?.left ?? null,
        source: subscribers === null ? 'unavailable' : 'snapshot',
        confidence: subscribers === null ? 'low' : 'high',
      };
    },
  );

  return {
    subscribers: {
      current: currentSubscribers,
      todayDelta: daily.at(-1)?.delta ?? null,
      todayJoined: null,
      todayLeft: null,
      weekDelta,
      sixteenDaysDelta: weekDelta,
    },
    views: {
      perPost,
      last24h: null,
      last48h: null,
      er24: null,
    },
    reach: {
      averageViews24h: null,
      averageViews48h: null,
      err48Percent: null,
      subscriberDenominator: null,
      sampleSize24h: 0,
      sampleSize48h: 0,
      coverage24h: 'unavailable',
      coverage48h: 'unavailable',
      asOf: null,
      method: 'post-age-cohort',
    },
    daily,
  };
}

function formatPostDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }

  return POST_DATE_TIME_FORMATTER.format(parsed);
}

function formatBestWindowValue(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const day = dayShortLabels[window.dayOfWeek] ?? '';
  const hour = String(window.hour).padStart(2, '0');
  return `${day} ${hour}:00`.trim();
}

function formatBestWindowStats(window: ChannelStatsResponse['signals']['bestWindows'][number]) {
  const views = formatCompactCount(window.averageViews);
  const reactions = formatCompactCount(window.averageReactions);
  return reactions === '—' || window.averageReactions === 0
    ? `${views} просм.`
    : `${views} просм. · ${reactions} реакц.`;
}

function getSignedTone(value: number | null): 'positive' | 'negative' | 'neutral' {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'neutral';
  }

  if (value > 0) {
    return 'positive';
  }

  if (value < 0) {
    return 'negative';
  }

  return 'neutral';
}

function ChannelBestWindowsPanel({ stats }: { stats: ChannelStatsResponse }) {
  const windows = stats.signals.bestWindows.filter((window) => window.posts > 0).slice(0, 3);

  return (
    <article className="channel-fact-panel channel-best-windows-panel">
      <div className="channel-insights__panel-head">
        <div className="channel-insights__panel-copy">
          <strong>Окна публикаций</strong>
        </div>
      </div>

      {windows.length > 0 ? (
        <div className="channel-best-windows">
          {windows.map((window) => (
            <div key={`${window.dayOfWeek}-${window.hour}`} className="channel-best-windows__row">
              <strong>{formatBestWindowValue(window)}</strong>
              <span>{formatBestWindowStats(window)}</span>
              <small>{formatCount(window.posts)} постов</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="channel-fact-panel__empty">Недостаточно публикаций за период.</p>
      )}
    </article>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveSparseLabelIndices(length: number, plotWidth: number): Set<number> {
  const labelCount = plotWidth < 240 ? 3 : 4;
  if (length <= labelCount) {
    return new Set(Array.from({ length }, (_, index) => index));
  }

  const lastIndex = Math.max(0, length - 1);
  const anchors = Array.from({ length: labelCount }, (_, index) =>
    Math.round((lastIndex * index) / (labelCount - 1)),
  );

  return new Set(anchors);
}

function resolveChartIndexFromClientX(
  clientX: number,
  rect: DOMRect,
  pointsLength: number,
  leftPad = 0,
  rightPad = 0,
  viewBoxWidth = CHART_VIEWBOX_WIDTH,
): number {
  if (pointsLength <= 1) {
    return 0;
  }

  const plotLeft = rect.left + (rect.width * leftPad) / viewBoxWidth;
  const plotRight = rect.left + (rect.width * (viewBoxWidth - rightPad)) / viewBoxWidth;
  const ratio = clamp((clientX - plotLeft) / Math.max(plotRight - plotLeft, 1), 0, 1);
  return Math.round(ratio * (pointsLength - 1));
}

function captureChartPointer(event: PointerEvent<HTMLDivElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Older WebViews can skip pointer capture; scrubbing still works inside the canvas.
  }
}

function resolveAlignedIndex(
  sourceLength: number,
  targetIndex: number,
  targetLength: number,
): number {
  if (sourceLength <= 1 || targetLength <= 1) {
    return 0;
  }

  const ratio = clamp(targetIndex / Math.max(1, targetLength - 1), 0, 1);
  return Math.round(ratio * (sourceLength - 1));
}

function buildAudiencePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const [point] = points;
    return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }

  let path = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const deltaX = (next.x - current.x) / 2;

    path += ` C ${(current.x + deltaX * 0.7).toFixed(2)} ${current.y.toFixed(2)} ${(
      next.x -
      deltaX * 0.7
    ).toFixed(2)} ${next.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }

  return path;
}

function buildAudienceAreaPath(
  linePath: string,
  points: Array<{ x: number; y: number }>,
  floorY: number,
): string {
  if (!linePath || points.length === 0) {
    return '';
  }

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  return `${linePath} L ${lastPoint.x.toFixed(2)} ${floorY.toFixed(2)} L ${firstPoint.x.toFixed(
    2,
  )} ${floorY.toFixed(2)} Z`;
}

function buildEmptyAudienceChart(): AudienceChartModel {
  return {
    width: CHART_VIEWBOX_WIDTH,
    points: [],
    previousPoints: [],
    linePath: '',
    areaPath: '',
    joinedFlowPath: '',
    joinedFlowLinePath: '',
    leftFlowPath: '',
    leftFlowLinePath: '',
    previousLinePath: '',
    hasLine: false,
    hasPreviousLine: false,
    hasJoinedFlow: false,
    hasLeftFlow: false,
    guideYs: [],
    dividerY: 112,
    activityRailY: 132,
    eventRailY: 158,
    zeroY: 132,
    height: CHART_VIEWBOX_HEIGHT,
    leftPad: AUDIENCE_CHART_LEFT_PAD,
    rightPad: AUDIENCE_CHART_RIGHT_PAD,
    plotTop: 30,
    plotBottom: 164,
    floorY: 176,
    axisLabels: [],
  };
}

function buildAudienceChart(
  stats: ChannelStatsResponse,
  width = CHART_VIEWBOX_WIDTH,
): AudienceChartModel {
  const participantSeries = stats.official.series.participants;
  const membershipSeries = stats.official.series.membership;
  const previousParticipantSeries = stats.comparison.series?.participants ?? [];
  const previousMembershipSeries = stats.comparison.series?.membership ?? [];
  const currentParticipants = readNullableCount(stats.channel.participantsCount);
  const pointCount = Math.max(participantSeries.length, membershipSeries.length);
  if (pointCount === 0) {
    return buildEmptyAudienceChart();
  }

  const height = CHART_VIEWBOX_HEIGHT;
  const leftPad = AUDIENCE_CHART_LEFT_PAD;
  const rightPad = AUDIENCE_CHART_RIGHT_PAD;
  const lineTop = 20;
  const lineBottom = 222;
  const lineFloor = 222;
  const dividerY = lineBottom;
  const activityRailY = 174;
  const eventRailY = 190;
  const plotWidth = width - leftPad - rightPad;

  let cumulativeNet = 0;
  const basePoints = Array.from({ length: pointCount }, (_, index) => {
    const participant = participantSeries[index] ?? null;
    const membership = membershipSeries[index] ?? null;
    const at = membership?.at ?? participant?.at ?? new Date().toISOString();
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const net = joined - left;
    cumulativeNet += net;
    const x =
      pointCount === 1 ? width / 2 : leftPad + (plotWidth * index) / Math.max(1, pointCount - 1);

    return {
      at,
      participantsCount: participant?.participantsCount ?? null,
      joined,
      left,
      net,
      cumulativeNet,
      x,
      y: lineBottom,
      joinedFlowY: activityRailY,
      leftFlowY: activityRailY,
      source: participant?.source ?? 'unavailable',
      confidence: participant?.confidence ?? 'low',
    };
  });
  let previousKnownDisplayValue: number | null = null;
  const rawPoints = basePoints.map((point) => {
    const displayValue = resolveAudienceChartDisplayValue(point, currentParticipants, 0, false);
    const previousDisplayValue = previousKnownDisplayValue;
    const deltaFromPrevious =
      displayValue === null || previousDisplayValue === null
        ? null
        : Math.round(displayValue - previousDisplayValue);
    const deltaPercentFromPrevious =
      previousDisplayValue !== null && previousDisplayValue > 0 && deltaFromPrevious !== null
        ? (deltaFromPrevious / previousDisplayValue) * 100
        : null;
    if (displayValue !== null) {
      previousKnownDisplayValue = displayValue;
    }

    return {
      ...point,
      displayValue,
      deltaFromPrevious,
      deltaPercentFromPrevious,
    };
  });
  const displayablePoints = rawPoints.filter(hasAudienceDisplayValue);

  const previousPointCount = Math.max(
    previousParticipantSeries.length,
    previousMembershipSeries.length,
  );
  let previousCumulativeNet = 0;
  const previousBasePoints = Array.from({ length: previousPointCount }, (_, index) => {
    const participant = previousParticipantSeries[index] ?? null;
    const membership = previousMembershipSeries[index] ?? null;
    const at = membership?.at ?? participant?.at ?? new Date().toISOString();
    const joined = membership?.joined ?? 0;
    const left = membership?.left ?? 0;
    const net = joined - left;
    previousCumulativeNet += net;
    const x =
      previousPointCount === 1
        ? width / 2
        : leftPad + (plotWidth * index) / Math.max(1, previousPointCount - 1);

    return {
      at,
      participantsCount: participant?.participantsCount ?? null,
      joined,
      left,
      net,
      cumulativeNet: previousCumulativeNet,
      x,
      y: lineBottom,
      source: participant?.source ?? 'unavailable',
      confidence: participant?.confidence ?? 'low',
    };
  });
  const rawPreviousPoints = previousBasePoints.map((point) => ({
    ...point,
    displayValue: point.participantsCount,
  }));
  const previousDisplayablePoints = rawPreviousPoints.filter(hasAudienceDisplayValue);
  const hasPreviousDisplayValues = previousDisplayablePoints.length > 0;
  const displayValues = [
    ...displayablePoints.map((point) => point.displayValue),
    ...(hasPreviousDisplayValues
      ? previousDisplayablePoints.map((point) => point.displayValue)
      : []),
  ];
  const hasAnyDisplayValue = displayValues.length > 0;
  const rawMinValue = hasAnyDisplayValue ? Math.min(...displayValues) : 0;
  const rawMaxValue = hasAnyDisplayValue ? Math.max(...displayValues) : 0;
  const valueSpan = Math.max(1, rawMaxValue - rawMinValue);
  const valuePadding = Math.max(1, valueSpan * 0.18);
  const minValue = Math.max(0, rawMinValue - valuePadding);
  const maxValue = rawMaxValue + valuePadding;
  const valueRange = Math.max(1, maxValue - minValue);
  const resolveValueY = (value: number) =>
    lineTop + ((maxValue - value) / valueRange) * (lineBottom - lineTop);
  const fallbackPlotValue = displayValues[0] ?? 0;
  const points = rawPoints.map((point, index) => {
    const plotValue = resolveAudiencePlotValue(rawPoints, index) ?? fallbackPlotValue;
    return {
      ...point,
      plotValue,
      y: resolveValueY(plotValue),
    };
  });
  const linePoints = points.filter(hasAudienceDisplayValue);
  const previousPoints = previousDisplayablePoints.map((point) => ({
    ...point,
    y: resolveValueY(point.displayValue),
  }));

  const linePath = buildAudiencePath(linePoints.map((point) => ({ x: point.x, y: point.y })));
  const previousLinePath = buildAudiencePath(
    previousPoints.map((point) => ({ x: point.x, y: point.y })),
  );
  const joinedFlowLinePath = '';
  const leftFlowLinePath = '';
  const zeroY = lineBottom;
  const guideYs = hasAnyDisplayValue
    ? [
        lineTop,
        Math.round(lineTop + (lineBottom - lineTop) * 0.25),
        Math.round(lineTop + (lineBottom - lineTop) * 0.5),
        Math.round(lineTop + (lineBottom - lineTop) * 0.75),
        lineBottom,
      ]
    : [];
  const axisLabels = hasAnyDisplayValue
    ? guideYs
        .map((y) => {
          const ratio = (y - lineTop) / Math.max(1, lineBottom - lineTop);
          const value = maxValue - ratio * valueRange;
          return {
            y: y + 4,
            label: formatDenseCount(Math.round(value)),
          };
        })
        .filter((label, index, labels) => {
          const duplicateIndex = labels.findIndex((item) => item.label === label.label);
          const overlapsPrevious = labels
            .slice(0, index)
            .some((item) => Math.abs(item.y - label.y) < 12);
          return duplicateIndex === index && !overlapsPrevious;
        })
    : [];

  return {
    width,
    points,
    previousPoints,
    linePath,
    areaPath: buildAudienceAreaPath(
      linePath,
      linePoints.map((point) => ({ x: point.x, y: point.y })),
      lineFloor,
    ),
    joinedFlowPath: '',
    joinedFlowLinePath,
    leftFlowPath: '',
    leftFlowLinePath,
    previousLinePath,
    hasLine: linePoints.length > 0,
    hasPreviousLine: hasPreviousDisplayValues && previousPoints.length > 0,
    hasJoinedFlow: false,
    hasLeftFlow: false,
    guideYs,
    dividerY,
    activityRailY,
    eventRailY,
    zeroY,
    height,
    leftPad,
    rightPad,
    plotTop: lineTop,
    plotBottom: lineBottom,
    floorY: lineFloor,
    axisLabels,
  };
}

function AudienceChart({ stats }: { stats: ChannelStatsResponse }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(CHART_VIEWBOX_WIDTH);
  const chart = useMemo(() => buildAudienceChart(stats, plotWidth), [stats, plotWidth]);
  const labels = chart.points;
  const hasChartData = chart.hasLine;
  const [activeIndex, setActiveIndex] = useState(() =>
    resolveInitialAudienceChartIndex(chart.points),
  );
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const pointerRectRef = useRef<DOMRect | null>(null);
  const queuedPointerClientXRef = useRef<number | null>(null);
  const pointerFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const measure = () => {
      const width = plot.getBoundingClientRect().width;
      if (width > 0) setPlotWidth(width);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    measure();
    return () => observer.disconnect();
  }, [hasChartData]);

  useEffect(() => {
    setActiveIndex(resolveInitialAudienceChartIndex(chart.points));
  }, [
    chart.points.length,
    stats.channel.participantsCount,
    stats.official.audience.joined,
    stats.official.audience.left,
    stats.official.audience.net,
    stats.meta.churnAvailable,
    stats.period.from,
    stats.period.to,
  ]);

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
      }
    },
    [],
  );

  const updateActiveIndexFromClientX = (clientX: number, rect: DOMRect) => {
    const nextIndex = resolveChartIndexFromClientX(
      clientX,
      rect,
      chart.points.length,
      chart.leftPad,
      chart.rightPad,
      chart.width,
    );
    setActiveIndex((current) => (current === nextIndex ? current : nextIndex));
  };
  const cancelPendingPointerFrame = () => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    queuedPointerClientXRef.current = null;
  };
  const schedulePointerIndexUpdate = (clientX: number) => {
    queuedPointerClientXRef.current = clientX;
    if (pointerFrameRef.current !== null) {
      return;
    }

    if (typeof window.requestAnimationFrame !== 'function') {
      const rect = pointerRectRef.current;
      if (rect) {
        updateActiveIndexFromClientX(clientX, rect);
      }
      queuedPointerClientXRef.current = null;
      return;
    }

    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const rect = pointerRectRef.current;
      const queuedClientX = queuedPointerClientXRef.current;
      queuedPointerClientXRef.current = null;
      if (!rect || queuedClientX === null) {
        return;
      }

      updateActiveIndexFromClientX(queuedClientX, rect);
    });
  };
  const stopChartScrub = () => {
    const clientX = queuedPointerClientXRef.current;
    const rect = pointerRectRef.current;
    if (clientX !== null && rect) updateActiveIndexFromClientX(clientX, rect);
    pointerRectRef.current = null;
    cancelPendingPointerFrame();
  };

  const safeActiveIndex = clamp(activeIndex, 0, Math.max(chart.points.length - 1, 0));
  const activePoint = chart.points[safeActiveIndex] ?? null;
  const previousIndex = resolveAlignedIndex(
    chart.previousPoints.length,
    safeActiveIndex,
    chart.points.length,
  );
  const activePreviousPoint = chart.previousPoints[previousIndex] ?? null;
  const activeComparablePreviousPoint = chart.hasPreviousLine ? activePreviousPoint : null;
  const renderPointMarkers = shouldRenderChannelStatsPointMarkers(
    stats.period.range,
    chart.points.length,
  );
  const graphClassName = `channel-stats-graph channel-stats-graph--audience-reference ${
    renderPointMarkers ? '' : 'channel-stats-graph--continuous'
  }`.trim();

  const firstPoint = chart.points[0] ?? null;
  const lastPoint = chart.points.at(-1) ?? null;
  const knownPoints = chart.points.filter(hasAudienceDisplayValue);
  const firstKnownPoint = knownPoints[0] ?? null;
  const lastKnownPoint = knownPoints.at(-1) ?? null;
  const totalGrowth =
    firstKnownPoint && lastKnownPoint
      ? Math.round(lastKnownPoint.displayValue - firstKnownPoint.displayValue)
      : null;
  const knownPointSpan =
    firstKnownPoint && lastKnownPoint
      ? Math.max(1, chart.points.indexOf(lastKnownPoint) - chart.points.indexOf(firstKnownPoint))
      : 1;
  const averageGrowth = totalGrowth !== null ? totalGrowth / knownPointSpan : null;
  const averageGrowthLabel = resolveAudienceChartAverageGrowthLabel(stats.period.bucket);
  const detailLabelIndices = new Set<number>();
  const xAxisLabelIndices = resolveSparseLabelIndices(
    labels.length,
    chart.width - chart.leftPad - chart.rightPad,
  );
  const activeParticipantsLabel = formatAudienceCount(
    activePoint?.displayValue ?? null,
    activePoint?.confidence,
  );
  const activeDelta = activePoint?.deltaFromPrevious ?? activePoint?.net ?? null;
  const activeDeltaLabel = formatSignedCount(activeDelta);
  const activePercentLabel = formatSignedPercent(activePoint?.deltaPercentFromPrevious ?? null, 1);
  const activeBucketLabel = stats.period.bucket === 'hour' ? 'За час' : 'За день';
  const activeGuideLabel = activePoint
    ? `${formatChartDetailDate(activePoint.at, stats.period.bucket)}: ${formatAudienceCount(
        activePoint.displayValue,
        activePoint.confidence,
      )} подписчиков, ${activeBucketLabel.toLocaleLowerCase('ru-RU')} ${activeDeltaLabel}${
        stats.meta.churnAvailable
          ? `, ${formatCount(activePoint.joined)} пришли, ${formatCount(activePoint.left)} ушли`
          : ''
      }`
    : 'Данные по аудитории недоступны';
  const tooltipX = activePoint ? clamp((activePoint.x / chart.width) * 100, 15, 85) : 50;
  const tooltipStyle = { '--tooltip-x': `${tooltipX}%` } as CSSProperties;
  const axisLabelX = Math.max(16, chart.leftPad - 5);

  return (
    <div className={graphClassName}>
      {!hasChartData ? (
        <div className="channel-stats-graph__empty">
          {chart.points.length === 0
            ? 'Пока нет данных за период.'
            : 'Данные об аудитории за этот период недоступны.'}
        </div>
      ) : (
        <>
          <div className="channel-stats-graph__canvas channel-stats-graph__canvas--audience">
            <div className="channel-audience-board__heading">
              <strong>Динамика аудитории</strong>
            </div>
            <div
              ref={plotRef}
              className="channel-audience-board__plot"
              tabIndex={0}
              role="slider"
              aria-label="Динамика аудитории"
              aria-valuemin={1}
              aria-valuemax={chart.points.length}
              aria-valuenow={safeActiveIndex + 1}
              aria-valuetext={activeGuideLabel}
              onPointerDown={(event) => {
                captureChartPointer(event);
                const rect = plotRef.current?.getBoundingClientRect();
                if (!rect) return;
                pointerRectRef.current = rect;
                setIsTooltipVisible(true);
                updateActiveIndexFromClientX(event.clientX, rect);
              }}
              onPointerMove={(event) => {
                if (event.buttons !== 1) {
                  return;
                }

                setIsTooltipVisible(true);
                schedulePointerIndexUpdate(event.clientX);
              }}
              onPointerUp={stopChartScrub}
              onPointerCancel={() => {
                stopChartScrub();
                setIsTooltipVisible(false);
              }}
              onPointerLeave={stopChartScrub}
              onBlur={() => {
                stopChartScrub();
                setIsTooltipVisible(false);
              }}
              onKeyDown={(event) => {
                const nextIndex = resolveChannelStatsSliderIndex(
                  safeActiveIndex,
                  chart.points.length,
                  event.key,
                );
                if (nextIndex !== null) {
                  event.preventDefault();
                  setIsTooltipVisible(true);
                  setActiveIndex(nextIndex);
                }
              }}
            >
              {activePoint && isTooltipVisible ? (
                <div className="channel-stats-graph__tooltip" style={tooltipStyle}>
                  <small>{formatChartDetailDate(activePoint.at, stats.period.bucket)}</small>
                  <strong>{activeParticipantsLabel} подписчиков</strong>
                  <span>
                    {activeBucketLabel} {activeDeltaLabel} · {activePercentLabel}
                  </span>
                  {activeComparablePreviousPoint ? (
                    <em>Предыдущий: {formatCount(activeComparablePreviousPoint.displayValue)}</em>
                  ) : null}
                </div>
              ) : null}

              <svg
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                className="channel-stats-graph__svg"
                aria-hidden
              >
                {chart.axisLabels.map((label) => (
                  <text
                    key={`${label.label}-${label.y}`}
                    x={axisLabelX}
                    y={label.y}
                    className="channel-stats-graph__axis-text"
                    textAnchor="end"
                  >
                    {label.label}
                  </text>
                ))}
                {xAxisLabelIndices.size > 1
                  ? chart.points.map((point, index) =>
                      xAxisLabelIndices.has(index) ? (
                        <line
                          key={`audience-v-guide-${point.at}-${index}`}
                          x1={point.x}
                          y1={chart.plotTop}
                          x2={point.x}
                          y2={chart.plotBottom}
                          className="channel-stats-graph__grid channel-stats-graph__grid--vertical"
                        />
                      ) : null,
                    )
                  : null}
                {chart.guideYs.map((y) => (
                  <line
                    key={`guide-${y}`}
                    x1={chart.leftPad}
                    y1={y}
                    x2={chart.width - chart.rightPad}
                    y2={y}
                    className="channel-stats-graph__grid"
                  />
                ))}
                <line
                  x1={chart.leftPad}
                  y1={chart.plotBottom}
                  x2={chart.width - chart.rightPad}
                  y2={chart.plotBottom}
                  className="channel-stats-graph__baseline"
                />
                {chart.hasLine ? (
                  <path
                    d={chart.areaPath}
                    className="channel-stats-graph__area channel-stats-graph__area--audience"
                  />
                ) : null}
                {chart.hasLine ? (
                  <path
                    d={chart.linePath}
                    className="channel-stats-graph__line-glow channel-stats-graph__line-glow--audience"
                  />
                ) : null}
                {activePoint && isTooltipVisible ? (
                  <line
                    x1={activePoint.x}
                    y1={chart.plotTop}
                    x2={activePoint.x}
                    y2={chart.plotBottom}
                    className="channel-stats-graph__active-guide"
                  />
                ) : null}
                {chart.hasPreviousLine ? (
                  <path
                    d={chart.previousLinePath}
                    className="channel-stats-graph__line channel-stats-graph__line--previous"
                  />
                ) : null}
                {chart.hasLine ? (
                  <path
                    d={chart.linePath}
                    className="channel-stats-graph__line channel-stats-graph__line--audience"
                  />
                ) : null}
                {chart.points.map((point, index) => {
                  const showDetails = detailLabelIndices.has(index);
                  const showDate = xAxisLabelIndices.has(index);
                  const labelY = Math.max(12, point.y - 13);
                  const deltaY = Math.min(chart.floorY - 13, point.y + 21);
                  const detailLabelX = clamp(
                    point.x,
                    chart.leftPad + 10,
                    chart.width - chart.rightPad - 10,
                  );
                  const dateTextAnchor =
                    index === 0 ? 'start' : index === chart.points.length - 1 ? 'end' : 'middle';
                  const deltaTone = getSignedTone(point.deltaFromPrevious);

                  return (
                    <g
                      key={labels[index]?.at ?? index}
                      className={`channel-stats-graph__point-group ${
                        safeActiveIndex === index ? 'is-active' : ''
                      } ${showDetails ? 'has-detail' : ''}`}
                    >
                      {showDetails ? (
                        <>
                          <text
                            x={detailLabelX}
                            y={labelY}
                            textAnchor="middle"
                            className="channel-stats-graph__point-value"
                          >
                            {formatAudienceCount(point.displayValue, point.confidence)}
                          </text>
                          {point.deltaFromPrevious !== null ? (
                            <>
                              <text
                                x={detailLabelX}
                                y={deltaY}
                                textAnchor="middle"
                                className={`channel-stats-graph__point-delta is-${deltaTone}`}
                              >
                                {formatSignedCount(point.deltaFromPrevious)}
                              </text>
                              <text
                                x={detailLabelX}
                                y={deltaY + 11}
                                textAnchor="middle"
                                className={`channel-stats-graph__point-percent is-${deltaTone}`}
                              >
                                {formatSignedPercent(point.deltaPercentFromPrevious, 1)}
                              </text>
                            </>
                          ) : null}
                        </>
                      ) : null}
                      {renderPointMarkers && point.displayValue !== null ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r={safeActiveIndex === index ? 4.2 : 3.4}
                          className={`channel-stats-graph__dot ${
                            safeActiveIndex === index ? 'is-active' : ''
                          }`}
                        />
                      ) : null}
                      {showDate ? (
                        <text
                          x={point.x}
                          y={chart.height - 10}
                          textAnchor={dateTextAnchor}
                          className="channel-stats-graph__x-label"
                        >
                          {stats.period.bucket === 'hour'
                            ? formatChannelStatsHourTick(point.at)
                            : formatChartDayMonth(point.at)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="channel-audience-board__series" aria-label="Периоды на графике">
              <span>Выбранный период</span>
              {chart.hasPreviousLine ? (
                <span className="is-previous">Предыдущий период</span>
              ) : null}
            </div>
            <output className="channel-audience-selection" aria-live="polite" aria-atomic="true">
              <span>
                {activePoint
                  ? formatChartDetailDate(activePoint.at, stats.period.bucket)
                  : 'Нет данных'}
              </span>
              <strong>{activeParticipantsLabel}</strong>
              <span className={`is-${getSignedTone(activeDelta)}`}>
                {activeDeltaLabel} {activeBucketLabel.toLocaleLowerCase('ru-RU')}
              </span>
            </output>
            <details className="channel-audience-details">
              <summary>
                Изменение за период{' '}
                <b className={`is-${getSignedTone(totalGrowth)}`}>
                  {formatSignedCount(totalGrowth)}
                </b>
              </summary>
              <dl>
                <div>
                  <dt>Начало периода</dt>
                  <dd>
                    {formatAudienceCount(firstPoint?.displayValue ?? null, firstPoint?.confidence)}
                  </dd>
                </div>
                <div>
                  <dt>Конец периода</dt>
                  <dd>
                    {formatAudienceCount(lastPoint?.displayValue ?? null, lastPoint?.confidence)}
                  </dd>
                </div>
                <div>
                  <dt>{averageGrowthLabel}</dt>
                  <dd className={`is-${getSignedTone(averageGrowth)}`}>
                    {formatSignedDecimalCount(averageGrowth)}
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

function TopPostsChart({ stats }: { stats: ChannelStatsResponse }) {
  const posts = stats.official.content.topPosts;
  const resolvePostViews = (
    post: ChannelStatsResponse['official']['content']['topPosts'][number],
  ) => post.viewsDelta;

  if (posts.length === 0) {
    return (
      <div className="channel-posts-chart">
        <div className="channel-stats-graph__empty">Пока нет публикаций за период.</div>
      </div>
    );
  }

  return (
    <div className="channel-posts-chart">
      <div className="channel-posts-chart__list">
        {posts.map((post, index) => {
          const value = resolvePostViews(post);
          const valueLabel = formatCompactCount(value);
          const detailParts = [`${formatCount(value)} просмотров за период`];
          const hasPreview = Boolean(post.previewUrl);

          const row = (
            <>
              <div
                className={`channel-posts-chart__preview ${
                  hasPreview ? 'channel-posts-chart__preview--image' : ''
                }`}
                aria-hidden="true"
              >
                {post.previewUrl ? (
                  <img src={post.previewUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span>#{index + 1}</span>
                )}
              </div>
              <div className="channel-posts-chart__content">
                <div className="channel-posts-chart__row-head">
                  <span className="channel-posts-chart__rank">№{index + 1}</span>
                  <span className="channel-posts-chart__title">
                    {formatPostDateTime(post.publishedAt)} · МСК
                  </span>
                  {post.url ? (
                    <IconoirSprite
                      variant="iconoir"
                      icon="OpenNewWindow"
                      className="channel-posts-chart__external-icon"
                      aria-hidden="true"
                      width={16}
                      height={16}
                      strokeWidth={2}
                    />
                  ) : null}
                </div>
                <div className="channel-posts-chart__metrics" aria-hidden="true">
                  <span>
                    <small>Просмотры</small>
                    <strong>{valueLabel}</strong>
                  </span>
                </div>
              </div>
            </>
          );
          const rowLabel = `Публикация ${index + 1}, ${formatPostDateTime(
            post.publishedAt,
          )} по московскому времени: ${detailParts.join(', ')}${
            post.url ? ', откроется в новой вкладке' : ''
          }`;

          return post.url ? (
            <a
              key={post.messageId}
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="channel-posts-chart__row channel-posts-chart__row--linked"
              aria-label={rowLabel}
            >
              {row}
            </a>
          ) : (
            <article
              key={post.messageId}
              className="channel-posts-chart__row"
              aria-label={rowLabel}
            >
              {row}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function ChannelStatsOverview({
  stats,
  range,
  onRangeChange,
}: {
  stats: ChannelStatsResponse;
  range: ChannelStatsRange;
  onRangeChange: (range: ChannelStatsRange) => void;
}) {
  const summary = resolveChannelStatsSummary(stats);
  const averageViews24h = resolveChannelReachMetric(summary.reach, 'averageViews24h');
  const averageViews48h = resolveChannelReachMetric(summary.reach, 'averageViews48h');
  const err48 = resolveChannelReachMetric(summary.reach, 'err48Percent');
  const [expandedPeriod, setExpandedPeriod] = useState<string | null>(null);
  const periodKey = `${stats.channel.id}/${stats.period.from}/${stats.period.to}`;
  const showAllDays = expandedPeriod === periodKey;
  const summaryDailyRows = (
    showAllDays ? summary.daily.slice() : summary.daily.slice(-9)
  ).reverse();
  const hasTopPosts = stats.official.content.topPosts.length > 0;
  const hasBestWindows = stats.signals.bestWindows.some((window) => window.posts > 0);
  const hasDetailPanels = hasTopPosts || hasBestWindows;
  const coverageFrom = stats.meta.officialCoverageFrom;
  const partialCoverageFrom =
    coverageFrom !== null && Date.parse(coverageFrom) > Date.parse(stats.period.from)
      ? coverageFrom
      : null;
  const reachCalculatedAt = summary.reach.asOf;

  const formatReachCaption = (
    metric: ReturnType<typeof resolveChannelReachMetric>,
    readyLabel = `Постов в выборке: ${formatCount(metric.sampleSize)}`,
  ) => {
    if (metric.coverage === 'ready') {
      return readyLabel;
    }
    if (metric.coverage === 'insufficient') {
      return metric.sampleSize > 0
        ? `Недостаточно данных · постов: ${formatCount(metric.sampleSize)}`
        : 'Недостаточно данных';
    }

    return 'Нет данных';
  };

  return (
    <section
      className="channel-insights__summary channel-insights__summary--command stagger-in"
      aria-label="Сводка по каналу"
    >
      <div className="channel-insights__overview-toolbar">
        <span>
          {formatPeriodRange(stats.period.from, stats.period.to)}
          {stats.period.bucket === 'hour' ? ' · МСК' : ''}
        </span>
        <SegmentedControl
          value={range}
          options={periodOptions}
          onChange={(next) => onRangeChange(next as ChannelStatsRange)}
          className="channel-insights__range"
          ariaLabel="Период статистики канала"
        />
      </div>
      {stats.meta.refreshQueued || partialCoverageFrom ? (
        <div className="channel-insights__data-status" role="status">
          {stats.meta.refreshQueued ? <span>Обновляем данные канала</span> : null}
          {partialCoverageFrom ? (
            <span>Данные доступны с {formatPostDateTime(partialCoverageFrom)} · МСК</span>
          ) : null}
        </div>
      ) : null}
      <div className="channel-insights__summary-metrics channel-insights__summary-metrics--compact">
        <article className="channel-summary-card channel-summary-card--compact">
          <small>Подписчики сейчас</small>
          <strong>{formatCount(summary.subscribers.current)}</strong>
        </article>
        <article className="channel-summary-card channel-summary-card--compact">
          <small aria-label="Средние просмотры за 24 часа">
            Просмотры / <span className="channel-summary-card__unit">24 ч</span>
          </small>
          <strong>{formatCount(averageViews24h.value)}</strong>
          <span>{formatReachCaption(averageViews24h)}</span>
        </article>
      </div>

      <div className="channel-insights__overview-top">
        <div className="channel-insights__primary-stack">
          <article className="channel-insights__chart-card channel-insights__chart-card--executive channel-insights__chart-card--audience">
            <AudienceChart stats={stats} />
          </article>
        </div>

        {summaryDailyRows.length > 0 ? (
          <section className="channel-summary-table-card" aria-label="Динамика подписчиков по дням">
            <div className="channel-summary-table-heading">
              <strong>По дням</strong>
              {summary.daily.length > 9 ? (
                <button
                  type="button"
                  aria-expanded={showAllDays}
                  aria-controls="channel-daily-table"
                  onClick={() => setExpandedPeriod(showAllDays ? null : periodKey)}
                >
                  {showAllDays ? 'Последние 9 дней' : `Весь период · ${summary.daily.length}`}
                </button>
              ) : null}
            </div>
            <div
              className="channel-summary-table-scroll"
              role="region"
              aria-label="Таблица по дням"
              tabIndex={0}
            >
              <table
                id="channel-daily-table"
                className="channel-summary-table"
                aria-label="Динамика подписчиков по дням"
              >
                <thead>
                  <tr>
                    <th scope="col">День</th>
                    <th scope="col" aria-label="Всего подписчиков">
                      Всего
                    </th>
                    <th scope="col">Прирост</th>
                    <th scope="col">Вход / выход</th>
                  </tr>
                </thead>
                <tbody>
                  {summaryDailyRows.map((row, index) => {
                    const joined = row.joined ?? null;
                    const left = row.left ?? null;
                    const hasFlow = joined !== null || left !== null;
                    const joinedFlow = joined ?? 0;
                    const leftFlow = left ?? 0;
                    const isCurrent = index === 0;

                    return (
                      <tr key={row.date} className={isCurrent ? 'is-current' : undefined}>
                        <td className="channel-summary-table__date">
                          <time dateTime={row.date} aria-current={isCurrent ? 'date' : undefined}>
                            {formatSummaryTableDate(row.date)}
                          </time>
                        </td>
                        <td className="channel-summary-table__total">
                          <span className="channel-summary-table__total-value">
                            {formatAudienceCount(row.subscribers, row.confidence)}
                          </span>
                        </td>
                        <td
                          className={`channel-summary-table__growth is-${getSignedTone(row.delta)}`}
                        >
                          <span className="channel-summary-table__growth-value">
                            {formatDenseSignedCount(row.delta)}
                          </span>
                        </td>
                        <td className="channel-summary-table__movement">
                          {hasFlow ? (
                            <span className="channel-summary-table__movement-pair">
                              <span
                                role="img"
                                className={`channel-summary-table__movement-pill ${
                                  joined === null ? 'is-neutral' : 'is-positive'
                                }`}
                                aria-label={
                                  joined === null
                                    ? 'Вступления: нет данных'
                                    : `Вступили: ${formatDenseCount(joinedFlow)}`
                                }
                              >
                                <span aria-hidden="true">↗</span>
                                <em aria-hidden="true">{formatDenseCount(joined)}</em>
                              </span>
                              <span
                                role="img"
                                className={`channel-summary-table__movement-pill ${
                                  left === null ? 'is-neutral' : 'is-negative'
                                }`}
                                aria-label={
                                  left === null
                                    ? 'Выходы: нет данных'
                                    : `Вышли: ${formatDenseCount(leftFlow)}`
                                }
                              >
                                <span aria-hidden="true">↘</span>
                                <em aria-hidden="true">{formatDenseCount(left)}</em>
                              </span>
                            </span>
                          ) : (
                            <span className="channel-summary-table__movement-empty">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      {reachCalculatedAt ? (
        <p className="channel-insights__calculated-at">
          Охват рассчитан{' '}
          <time dateTime={reachCalculatedAt}>{formatPostDateTime(reachCalculatedAt)}</time> · МСК
        </p>
      ) : null}

      <details className="channel-insights__reach-details">
        <summary>Просмотры и охват за 48 часов</summary>
        <div className="channel-insights__summary-metrics channel-insights__summary-metrics--compact">
          <article className="channel-summary-card channel-summary-card--compact">
            <small aria-label="Средние просмотры за 48 часов">
              Ср. просмотры за <span className="channel-summary-card__unit">48 ч</span>
            </small>
            <strong>{formatCount(averageViews48h.value)}</strong>
            <span>{formatReachCaption(averageViews48h)}</span>
          </article>
          <article className="channel-summary-card channel-summary-card--compact">
            <small>
              Охват подписчиков за <span className="channel-summary-card__unit">48 ч</span>
            </small>
            <strong>{formatPercent(err48.value)}</strong>
            <span>
              {formatReachCaption(err48, `Постов в расчёте: ${formatCount(err48.sampleSize)}`)}
            </span>
          </article>
        </div>
        <p>Охват: средние просмотры поста за первые 48 часов / подписчики × 100.</p>
      </details>

      {hasDetailPanels ? (
        <div className="channel-insights__detail-grid">
          {hasTopPosts ? (
            <article className="channel-fact-panel channel-top-posts-panel">
              <div className="channel-insights__panel-head">
                <div className="channel-insights__panel-copy">
                  <strong>Топ публикаций</strong>
                </div>
              </div>
              <TopPostsChart stats={stats} />
            </article>
          ) : null}

          {hasBestWindows ? <ChannelBestWindowsPanel stats={stats} /> : null}
        </div>
      ) : null}
    </section>
  );
}
