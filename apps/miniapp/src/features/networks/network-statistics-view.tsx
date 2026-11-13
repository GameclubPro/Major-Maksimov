import { useState } from 'react';
import { NetworkStatisticsCommunities } from './network-statistics-communities';
import type { ManagedEntityType } from '@maxim/contracts';
import type {
  NetworkMetricCoverage,
  NetworkStatisticsResponse,
} from '@maxim/contracts/networks-stats';
import { AppIcon } from '../../components/ui/app-icon';
import { Spinner } from '../../components/ui/spinner';
import type { NetworkStatisticsRange, NetworkStatisticsState } from './network-statistics';
import './network-statistics-view.css';

const number = new Intl.NumberFormat('ru-RU');
const date = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Moscow',
});
const timestamp = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});
export function formatNetworkMetric(value: number | null, signed = false): string {
  return value == null ? '—' : `${signed && value > 0 ? '+' : ''}${number.format(value)}`;
}
function Coverage({
  value,
  growth = false,
  sharedCoverage = false,
  sharedFreshness = false,
}: {
  value: NetworkMetricCoverage;
  growth?: boolean;
  sharedCoverage?: boolean;
  sharedFreshness?: boolean;
}) {
  if (sharedCoverage && sharedFreshness) return null;
  return (
    <div className="network-metric-coverage">
      {!sharedCoverage ? (
        <span className={`network-coverage-badge is-${value.status}`}>
          {value.status === 'unavailable'
            ? 'Нет наблюдений'
            : value.includedEntities < value.totalEntities
              ? `По ${number.format(value.includedEntities)} из ${number.format(value.totalEntities)}`
              : value.status === 'partial'
                ? growth
                  ? 'История может быть неполной'
                  : 'Есть пропуски'
                : `Учтено: ${number.format(value.includedEntities)} из ${number.format(value.totalEntities)}`}
        </span>
      ) : null}
      {!sharedFreshness ? (
        <small>
          {growth ? 'Последние наблюдения' : 'Обновлено'}:{' '}
          {value.asOf ? `${timestamp.format(new Date(value.asOf))} МСК` : 'нет даты'}
        </small>
      ) : null}
    </div>
  );
}
function Metric({
  label,
  metric,
  growth = false,
  sharedCoverage = false,
  sharedFreshness = false,
}: {
  label: string;
  metric: NetworkStatisticsResponse['audience'];
  growth?: boolean;
  sharedCoverage?: boolean;
  sharedFreshness?: boolean;
}) {
  return (
    <article className="network-detail-metric">
      <span>{label}</span>
      <strong
        className={
          growth && metric.value ? (metric.value > 0 ? 'is-positive' : 'is-negative') : undefined
        }
      >
        {formatNetworkMetric(metric.value, growth)}
      </strong>
      <Coverage
        value={metric.coverage}
        growth={growth}
        sharedCoverage={sharedCoverage}
        sharedFreshness={sharedFreshness}
      />
    </article>
  );
}
function GrowthChart({
  series,
  entityType,
}: {
  series: NetworkStatisticsResponse['series'];
  entityType: ManagedEntityType;
}) {
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, series.length - 1));
  const selected = series[Math.min(selectedIndex, series.length - 1)];
  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = dayKey.format(new Date());
  const max = Math.max(1, ...series.map((point) => Math.abs(point.netGrowth ?? 0)));
  const observed = series.some((point) => point.netGrowth != null);
  return (
    <section className="network-growth-panel" aria-labelledby="network-growth-title">
      <div className="network-panel-heading">
        <div>
          <h2 id="network-growth-title">Прирост по дням</h2>
        </div>
        <AppIcon icon="StatsUpSquare" />
      </div>
      {observed ? (
        <>
          <svg
            className="network-growth-bars"
            viewBox="0 0 600 170"
            preserveAspectRatio="none"
            role="img"
            aria-label="Дневной прирост. Коснитесь дня или выберите его ползунком ниже."
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setSelectedIndex(
                Math.max(
                  0,
                  Math.min(
                    series.length - 1,
                    Math.floor(((event.clientX - bounds.left) / bounds.width) * series.length),
                  ),
                ),
              );
            }}
          >
            <line className="network-growth-baseline" x1="0" x2="600" y1="85" y2="85" />
            {series.map((point, index) => {
              const step = 600 / Math.max(series.length, 1);
              const height = Math.max(
                point.netGrowth === 0 ? 1 : 3,
                (Math.abs(point.netGrowth ?? 0) / max) * 76,
              );
              const label = `${date.format(new Date(point.at))}: ${formatNetworkMetric(point.netGrowth, true)}`;
              return (
                <g
                  key={point.at}
                  className={`network-growth-day ${index === selectedIndex ? 'is-selected' : ''} ${point.netGrowth == null ? 'is-missing' : point.netGrowth < 0 ? 'is-negative' : 'is-positive'}`}
                >
                  <title>{label}</title>
                  {point.netGrowth != null ? (
                    <rect
                      x={index * step + 2}
                      y={point.netGrowth < 0 ? 85 : 85 - height}
                      width={Math.max(step - 4, 2)}
                      height={height}
                      rx="3"
                    />
                  ) : (
                    <circle cx={index * step + step / 2} cy="85" r="2" />
                  )}
                </g>
              );
            })}
          </svg>
          <div className="network-chart-dates">
            <span>{series[0] ? date.format(new Date(series[0].at)) : ''}</span>
            <span>Пропуск — нет данных</span>
            <span>{series.at(-1) ? date.format(new Date(series.at(-1)!.at)) : ''}</span>
          </div>
          <input
            className="network-chart-slider"
            type="range"
            aria-label="День графика"
            min={0}
            max={series.length - 1}
            value={Math.min(selectedIndex, series.length - 1)}
            aria-valuetext={
              selected
                ? `${date.format(new Date(selected.at))}: ${formatNetworkMetric(selected.netGrowth, true)}`
                : undefined
            }
            onChange={(event) => setSelectedIndex(Number(event.target.value))}
          />
          {selected ? (
            <div className="network-chart-selection" role="status" aria-live="polite">
              <strong>
                {date.format(new Date(selected.at))} ·{' '}
                {formatNetworkMetric(selected.netGrowth, true)}
              </strong>
              {selected.netGrowth === null ? <span>Нет наблюдений о приросте</span> : null}
              {entityType === 'channel' ? (
                <span>
                  Просмотры: {formatNetworkMetric(selected.viewsGained)}
                  {selected.viewsGained !== null && !selected.viewsComplete
                    ? ' · Есть пропуски'
                    : ''}
                </span>
              ) : null}
              {dayKey.format(new Date(selected.at)) === today ? (
                <small>Текущий день ещё не завершён</small>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="network-chart-empty">
          <AppIcon icon="StatsUpSquare" />
          <strong>Пока нет наблюдений о приросте</strong>
        </div>
      )}
      <details className="network-daily-details">
        <summary>Значения по дням</summary>
        <div className="network-statistics-table-scroll">
          <table>
            <caption className="sr-only">Наблюдаемый дневной прирост</caption>
            <thead>
              <tr>
                <th scope="col">День</th>
                <th scope="col">Прирост</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.at}>
                  <th scope="row">{date.format(new Date(point.at))}</th>
                  <td>{formatNetworkMetric(point.netGrowth, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
export interface NetworkStatisticsViewProps {
  state: NetworkStatisticsState;
  entityType: ManagedEntityType;
  range: NetworkStatisticsRange;
  onOpenCommunity?: (entityId: string) => void;
  viewKey?: string;
  className?: string;
}
export function NetworkStatisticsView({
  state,
  entityType,
  range,
  viewKey = 'network-statistics',
  onOpenCommunity,
  className,
}: NetworkStatisticsViewProps) {
  const { data } = state;
  if (!data)
    return (
      <div className="network-statistics-empty" role={state.phase === 'error' ? 'alert' : 'status'}>
        {state.phase === 'loading' || state.phase === 'checking' ? (
          <Spinner />
        ) : (
          <AppIcon icon="StatsUpSquare" />
        )}
        <strong>
          {state.phase === 'error'
            ? 'Не удалось загрузить статистику'
            : state.phase === 'stale'
              ? 'Состав сетки изменился'
              : 'Загружаем статистику'}
        </strong>
        {state.phase === 'error' || state.phase === 'stale' ? (
          <p>{state.error?.message ?? 'Обновите данные, чтобы продолжить.'}</p>
        ) : null}
        {(state.phase === 'error' || state.phase === 'stale') &&
        state.error?.retryable !== false ? (
          <button type="button" className="networks-secondary" onClick={state.refresh}>
            Повторить
          </button>
        ) : null}
      </div>
    );
  const coverages = [data.audience.coverage, data.netGrowth.coverage];
  if (entityType === 'channel' && data.viewsGained) coverages.push(data.viewsGained.coverage);
  const sharedCoverage = coverages.every(
    (coverage) =>
      coverage.status === 'ready' &&
      coverage.includedEntities === data.audience.coverage.includedEntities &&
      coverage.totalEntities === data.audience.coverage.totalEntities,
  );
  const sharedAsOf = coverages.every((coverage) => coverage.asOf === data.audience.coverage.asOf)
    ? data.audience.coverage.asOf
    : null;
  return (
    <div
      className={`network-statistics-view ${className ?? ''}`}
      aria-busy={state.phase === 'checking'}
    >
      {state.phase === 'checking' ? (
        <div className="network-statistics-progress" role="status">
          <Spinner />
          <span>
            Проверяем доступ · {number.format(data.authorization.checked)} из{' '}
            {number.format(data.authorization.total)}
          </span>
        </div>
      ) : null}
      {data.authorization.denied || data.authorization.unavailable ? (
        <p className="network-statistics-caption" role="status">
          {data.authorization.denied
            ? `Нет доступа: ${number.format(data.authorization.denied)}. `
            : ''}
          {data.authorization.unavailable
            ? `Не удалось проверить: ${number.format(data.authorization.unavailable)}. `
            : ''}
          Эти сообщества не включены в показатели.
        </p>
      ) : null}
      {sharedCoverage || sharedAsOf ? (
        <div className="network-statistics-summary">
          {sharedCoverage ? (
            <span>
              Сообщества: {number.format(data.audience.coverage.includedEntities)} из{' '}
              {number.format(data.audience.coverage.totalEntities)}
            </span>
          ) : null}
          {sharedAsOf ? (
            <span>Наблюдения: {timestamp.format(new Date(sharedAsOf))} МСК</span>
          ) : null}
        </div>
      ) : null}
      <div className={`network-detail-metrics ${entityType === 'channel' ? 'has-views' : ''}`}>
        <Metric
          label={entityType === 'chat' ? 'Участники' : 'Подписчики'}
          metric={data.audience}
          sharedCoverage={sharedCoverage}
          sharedFreshness={Boolean(sharedAsOf)}
        />
        <Metric
          label={`Прирост · ${range === '7d' ? 7 : 30} дней`}
          metric={data.netGrowth}
          growth
          sharedCoverage={sharedCoverage}
          sharedFreshness={Boolean(sharedAsOf)}
        />
        {entityType === 'channel' && data.viewsGained ? (
          <Metric
            label="Прирост просмотров"
            metric={data.viewsGained}
            growth
            sharedCoverage={sharedCoverage}
            sharedFreshness={Boolean(sharedAsOf)}
          />
        ) : null}
      </div>
      <GrowthChart
        key={`${data.favoriteType}:${range}`}
        series={data.series}
        entityType={entityType}
      />
      <details className="network-statistics-method network-daily-details">
        <summary>О данных</summary>
        <p>
          Аудитория — сумма участников учтённых сообществ. Один человек может учитываться в
          нескольких сообществах.
        </p>
        <p>
          Период: {date.format(new Date(data.period.from))} —{' '}
          {timestamp.format(new Date(data.period.to))} МСК. Расчёт по текущему составу сетки.
        </p>
        <p>
          Прирост — наблюдаемые вступления минус выходы. Пропуски означают отсутствие данных.
          Текущий день ещё не завершён.
        </p>
        <p>Неполные наблюдения не подтверждают непрерывную историю за период.</p>
        {data.audience.coverage.observedFrom ? (
          <p>
            Начало наблюдений аудитории:{' '}
            {date.format(new Date(data.audience.coverage.observedFrom))}.
          </p>
        ) : null}
        {data.netGrowth.coverage.observedFrom ? (
          <p>
            Начало наблюдений прироста:{' '}
            {date.format(new Date(data.netGrowth.coverage.observedFrom))}.
          </p>
        ) : null}
        {entityType === 'channel' ? (
          <p>
            Просмотры — прирост за период, включая старые публикации. MAX возвращает периодические
            замеры: между ними точное время прироста неизвестно.
            {data.unallocatedViews > 0
              ? ` Нельзя распределить по дням: ${number.format(data.unallocatedViews)}.`
              : ''}
          </p>
        ) : null}
      </details>
      <NetworkStatisticsCommunities
        key={`${data.entityType}:${data.favoriteType}:${data.period.range}`}
        data={data}
        viewKey={viewKey}
        onOpenCommunity={onOpenCommunity}
      />
      <button
        type="button"
        className="networks-text-button network-statistics-refresh"
        onClick={state.refresh}
      >
        <AppIcon icon="RefreshDouble" />
        Обновить статистику
      </button>
    </div>
  );
}
