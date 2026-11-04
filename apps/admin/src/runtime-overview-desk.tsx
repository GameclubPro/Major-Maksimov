import { useState } from 'react';
import type {
  SafetyDeskOverviewResponse,
  SafetyDeskOverviewPending,
  SafetyDeskOverviewPercentiles,
  SafetyDeskOverviewHistoryPoint,
} from '@maxim/contracts/safety-desk';
import { observationTime } from './observation-view';
import { useRuntimeOverview, type OverviewAccessScope } from './use-runtime-overview';
import {
  overviewAvailability,
  overviewBotStatus,
  overviewDelayTone,
  overviewDuration,
  overviewNumber,
  overviewOutcomeCount,
  overviewStatus,
  staleOverview,
  type OverviewObservation,
} from './runtime-overview-state';

type EvidenceFamily = 'webhook' | 'deletion' | 'publication' | 'delivery';
type QueueRow = NonNullable<SafetyDeskOverviewResponse['queues']['value']>['rows'][number];

const availabilityLabels = {
  FRESH: 'Свежее наблюдение',
  STALE: 'Данные устарели',
  UNAVAILABLE: 'Нет наблюдений',
  INVALID: 'Данные не подтверждены',
};

function SourceStamp({
  source,
  now,
}: {
  source: {
    availability: SafetyDeskOverviewResponse['collector']['availability'];
    observedAt: string | null;
  };
  now: number;
}) {
  const availability = overviewAvailability(source, now);
  return (
    <span className={`runtime-source runtime-source--${availability.toLowerCase()}`}>
      {availabilityLabels[availability]}
      {source.observedAt ? ` · ${observationTime(source.observedAt)}` : ''}
    </span>
  );
}

function Pending({
  label,
  observation,
  now,
}: {
  label: string;
  observation: OverviewObservation<SafetyDeskOverviewPending>;
  now: number;
}) {
  const value = observation.value;
  const tone =
    overviewAvailability(observation, now) === 'FRESH' && value?.ageBasis === 'receipt_created'
      ? overviewDelayTone(value.oldestAgeMs)
      : 'neutral';
  return (
    <article className={`runtime-measure runtime-tone--${tone}`}>
      <h3>{label}</h3>
      <strong className="runtime-measure__value">
        {value
          ? `${value.sampleComplete ? '' : '≥ '}${overviewNumber(value.countLowerBound)}`
          : 'Нет данных'}
      </strong>
      <dl className="runtime-inline-values">
        <div>
          <dt>
            {value?.ageBasis === 'state_updated_sample'
              ? 'Без изменения состояния'
              : 'Самое старое событие'}
          </dt>
          <dd>{overviewDuration(value?.oldestAgeMs)}</dd>
        </div>
      </dl>
      {value?.ageBasis === 'state_updated_sample' && (
        <span className="runtime-note">
          Может включать запланированные действия и повторные попытки
        </span>
      )}
      {value && !value.sampleComplete && (
        <span className="runtime-note">Нижняя граница: выборка ограничена</span>
      )}
      <SourceStamp source={observation} now={now} />
    </article>
  );
}

function Percentiles({
  value,
  compact = false,
  fresh,
}: {
  value: SafetyDeskOverviewPercentiles | null;
  compact?: boolean;
  fresh: boolean;
}) {
  return (
    <dl className={`runtime-percentiles${compact ? ' runtime-percentiles--compact' : ''}`}>
      {(['p50Ms', 'p95Ms', 'p99Ms'] as const).map((key) => (
        <div key={key}>
          <dt>{key.slice(0, -2)}</dt>
          <dd
            className={`runtime-text--${fresh ? overviewDelayTone(value?.[key] ?? null) : 'neutral'}`}
          >
            {overviewDuration(value?.[key])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const outcomeLabels: Record<string, string> = {
  SUCCEEDED: 'Подтверждено',
  SUCCEEDED_NOOP: 'Подтверждено без изменения',
  ALREADY_ABSENT: 'Уже отсутствует',
  FAILED_TERMINAL: 'Ошибка',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Исход неизвестен',
  CANCELLED: 'Отменено',
  SKIPPED: 'Пропущено',
  EXPIRED: 'Срок истёк',
  SUPERSEDED: 'Заменено',
};

function Outcomes({ values }: { values: Array<{ outcome: string; count: number }> | null }) {
  if (values === null) return <p className="runtime-note">Результаты не наблюдались</p>;
  if (values.length === 0)
    return <p className="runtime-note">В выборке нет завершённых действий</p>;
  return (
    <ul className="runtime-outcomes">
      {values.map(({ outcome, count }) => (
        <li key={outcome}>
          <span>{outcomeLabels[outcome] ?? 'Другой исход'}</span>
          <strong>{overviewNumber(count)}</strong>
        </li>
      ))}
    </ul>
  );
}

const segments = [
  ['waiting', 'Ожидают'],
  ['prioritized', 'С приоритетом'],
  ['active', 'В работе'],
  ['delayed', 'Отложены'],
] as const;

function queueTotal(row: Pick<QueueRow, 'waiting' | 'prioritized' | 'active' | 'delayed'>) {
  return segments.reduce((sum, [key]) => sum + row[key], 0);
}

function QueueDistribution({
  counts,
  label,
}: {
  counts: Pick<QueueRow, 'waiting' | 'prioritized' | 'active' | 'delayed'>;
  label: string;
}) {
  const total = queueTotal(counts);
  return (
    <div className="runtime-distribution">
      <div
        className={`runtime-distribution__bar${total === 0 ? ' is-empty' : ''}`}
        role="img"
        aria-label={`${label}: ${segments.map(([key, name]) => `${name} ${counts[key]}`).join(', ')}`}
      >
        {segments.map(
          ([key]) =>
            counts[key] > 0 && (
              <span
                key={key}
                className={`runtime-segment runtime-segment--${key}`}
                style={{ width: `${(counts[key] / total) * 100}%` }}
              />
            ),
        )}
      </div>
      <dl className="runtime-distribution__legend">
        {segments.map(([key, name]) => (
          <div key={key}>
            <dt>
              <i className={`runtime-dot runtime-segment--${key}`} />
              {name}
            </dt>
            <dd>{overviewNumber(counts[key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Queues({ snapshot, now }: { snapshot: SafetyDeskOverviewResponse; now: number }) {
  const queueData = snapshot.queues.value;
  const families = {
    webhook: 'Входящие события',
    actions: 'Действия ботов',
    auxiliary: 'Фоновые задачи',
  } as const;
  return (
    <section className="runtime-section" aria-label="Распределение очередей">
      <div className="runtime-section__heading">
        <h3>Очереди сейчас</h3>
        <SourceStamp source={snapshot.queues} now={now} />
      </div>
      {queueData ? (
        <div className="runtime-queue-grid">
          {(Object.keys(families) as Array<keyof typeof families>).map((family) => {
            const rows = queueData.rows.filter((row) => row.family === family);
            if (!rows.length) return null;
            const counts = rows.reduce(
              (sum, row) => ({
                waiting: sum.waiting + row.waiting,
                prioritized: sum.prioritized + row.prioritized,
                active: sum.active + row.active,
                delayed: sum.delayed + row.delayed,
              }),
              { waiting: 0, prioritized: 0, active: 0, delayed: 0 },
            );
            return (
              <article className="runtime-queue-card" key={family}>
                <div className="runtime-section__heading">
                  <h4>{families[family]}</h4>
                  <strong>{overviewNumber(queueTotal(counts))}</strong>
                </div>
                <QueueDistribution counts={counts} label={families[family]} />
                <details>
                  <summary>Очереди и сохранённые результаты</summary>
                  <p className="runtime-note">
                    Завершённые и ошибочные задания хранятся в очереди. Их число не равно
                    результатам действий за период.
                  </p>
                  <div className="runtime-queue-details">
                    {rows.map((row) => (
                      <div key={row.name} className="runtime-queue-detail">
                        <span>{row.name}</span>
                        <QueueDistribution counts={row} label={row.name} />
                        <span className="runtime-note">
                          Сохранено: завершено {overviewNumber(row.completed)} · с ошибкой{' '}
                          {overviewNumber(row.failed)}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="runtime-empty">Состояние очередей недоступно</p>
      )}
    </section>
  );
}

function BotCard({
  bot,
  now,
  actionSampleComplete,
  onEvidence,
}: {
  bot: SafetyDeskOverviewResponse['bots'][number];
  now: number;
  actionSampleComplete: boolean;
  onEvidence: (family: EvidenceFamily) => void;
}) {
  const status = overviewBotStatus(bot, now, actionSampleComplete);
  const pending = bot.pendingReceipts.value;
  const unfinished = bot.unfinishedActions.value;
  const publisherReasons: Record<string, string> = {
    runtime_disabled: 'Отправка выключена',
    global_paused: 'Общая пауза отправки',
    identity_unattested: 'Личность бота не подтверждена',
  };
  return (
    <article className={`runtime-bot runtime-tone--${status.tone}`} aria-label={bot.label}>
      <div className="runtime-bot__heading">
        <div>
          <span className="runtime-eyebrow">
            {bot.kind === 'publisher' ? 'Публикации' : 'Модерация'}
          </span>
          <h4>{bot.label}</h4>
        </div>
        <span className={`runtime-status runtime-status--${status.tone}`}>{status.label}</span>
      </div>
      <dl className="runtime-bot__facts">
        <div>
          <dt>Последнее событие</dt>
          <dd>
            {bot.subscription.value
              ? observationTime(bot.subscription.value.lastIncomingAt)
              : 'Нет наблюдений'}
          </dd>
        </div>
        <div>
          <dt>Последний результат действия</dt>
          <dd>
            {bot.lastTerminalAt.value
              ? observationTime(bot.lastTerminalAt.value.at)
              : 'Нет наблюдений'}
          </dd>
        </div>
        <div>
          <dt>Ожидающие события</dt>
          <dd>
            {pending
              ? `${pending.sampleComplete ? '' : '≥ '}${overviewNumber(pending.countLowerBound)}`
              : 'Нет данных'}
          </dd>
        </div>
        <div>
          <dt>Незавершённые действия</dt>
          <dd>
            {unfinished
              ? `${unfinished.sampleComplete ? '' : '≥ '}${overviewNumber(unfinished.countLowerBound)}`
              : 'Нет данных'}
          </dd>
        </div>
      </dl>
      <div className="runtime-bot__latency">
        <span className="runtime-note">
          Задержка измерена для {overviewNumber(bot.actionLatency.value?.sampleCount)} из{' '}
          {overviewNumber(overviewOutcomeCount(bot.outcomes.value))} результатов
        </span>
        <Percentiles
          value={bot.actionLatency.value}
          fresh={overviewAvailability(bot.actionLatency, now) === 'FRESH'}
          compact
        />
      </div>
      <details>
        <summary>Ожидание и подтверждения</summary>
        <dl className="runtime-bot__facts">
          <div>
            <dt>Возраст входящего события</dt>
            <dd>{overviewDuration(pending?.oldestAgeMs)}</dd>
          </div>
          <div>
            <dt>Действие без изменения состояния</dt>
            <dd>{overviewDuration(unfinished?.oldestAgeMs)}</dd>
          </div>
        </dl>
        <p className="runtime-note">
          Возраст состояния может включать запланированное ожидание и повторные попытки.
        </p>
        {(pending?.sampleComplete === false || unfinished?.sampleComplete === false) && (
          <p className="runtime-note">
            Выборка ограничена. Количество и возраст могут быть больше.
          </p>
        )}
        {bot.publisher?.value?.blocker && (
          <p>{publisherReasons[bot.publisher.value.blocker] ?? 'Отправка требует внимания'}</p>
        )}
        <Outcomes values={bot.outcomes.value} />
        <div className="runtime-sources">
          <SourceStamp source={bot.subscription} now={now} />
          <SourceStamp source={bot.pendingReceipts} now={now} />
          <SourceStamp source={bot.actionLatency} now={now} />
          {bot.publisher && <SourceStamp source={bot.publisher} now={now} />}
        </div>
        <button
          type="button"
          className="ghost-action"
          onClick={() => onEvidence(bot.kind === 'publisher' ? 'delivery' : 'webhook')}
        >
          Открыть подтверждения
        </button>
      </details>
    </article>
  );
}

export function historyChartPath(
  points: Array<{ at: string; value: number | null }>,
  start: number,
  end: number,
) {
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  let previousAt: number | null = null;
  let connected = false;
  return points
    .map((point) => {
      const at = Date.parse(point.at);
      if (point.value === null || at < start || at > end) {
        connected = false;
        return '';
      }
      const x = 4 + ((at - start) / Math.max(1, end - start)) * 632;
      const y = 112 - (point.value / maximum) * 104;
      const command = connected && previousAt !== null && at - previousAt <= 90_000 ? 'L' : 'M';
      previousAt = at;
      connected = true;
      return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function History({ snapshot, now }: { snapshot: SafetyDeskOverviewResponse; now: number }) {
  const [hours, setHours] = useState<1 | 24>(1);
  const end = now;
  const start = end - hours * 3_600_000;
  const points = snapshot.history.points.filter(
    (point) => Date.parse(point.at) >= start && Date.parse(point.at) <= end,
  );
  const plots: Array<{
    key: keyof Omit<SafetyDeskOverviewHistoryPoint, 'at'>;
    title: string;
    duration: boolean;
  }> = [
    { key: 'waiting', title: 'Ожидающие задания', duration: false },
    { key: 'p95Ms', title: 'p95 завершённых действий', duration: true },
    { key: 'oldestReceiptAgeMs', title: 'Возраст незавершённых событий', duration: true },
    { key: 'oldestActionAgeMs', title: 'Действия без изменения состояния', duration: true },
  ];
  const recentWaiting = points.filter((point) => point.waiting !== null).slice(-2);
  const consecutive =
    recentWaiting.length === 2 &&
    Date.parse(recentWaiting[1]!.at) - Date.parse(recentWaiting[0]!.at) >= 30_000 &&
    Date.parse(recentWaiting[1]!.at) - Date.parse(recentWaiting[0]!.at) <= 90_000 &&
    now - Date.parse(recentWaiting[1]!.at) <= 90_000;
  const delta = consecutive ? recentWaiting[1]!.waiting! - recentWaiting[0]!.waiting! : null;
  return (
    <section className="runtime-section" aria-label="История наблюдений">
      <div className="runtime-section__heading">
        <div>
          <h3>По минутам</h3>
          <SourceStamp source={snapshot.history} now={now} />
        </div>
        <div className="runtime-range" aria-label="Период графиков">
          {([1, 24] as const).map((value) => (
            <button
              type="button"
              className="ghost-action"
              key={value}
              aria-pressed={hours === value}
              onClick={() => setHours(value)}
            >
              {value === 1 ? 'Час' : 'Сутки'}
            </button>
          ))}
        </div>
      </div>
      <p className="runtime-note">
        Изменение ожидающих за последнюю минуту:{' '}
        {delta === null
          ? 'нет непрерывного измерения'
          : `${delta > 0 ? '+' : ''}${overviewNumber(delta)}`}
        . Разрывы означают пропуски наблюдений.
      </p>
      <div className="runtime-history-grid">
        {plots.map(({ key, title, duration }) => {
          const series = points.map((point) => ({ at: point.at, value: point[key] }));
          const values = series.flatMap((point) => (point.value === null ? [] : [point.value]));
          const last = series.at(-1)?.value ?? null;
          return (
            <article className="runtime-chart" key={key}>
              <div className="runtime-section__heading">
                <h4>{title}</h4>
                <strong>{duration ? overviewDuration(last) : overviewNumber(last)}</strong>
              </div>
              {values.length ? (
                <svg
                  viewBox="0 0 640 120"
                  role="img"
                  aria-label={`${title}, ${hours === 1 ? 'последний час' : 'последние сутки'}`}
                >
                  <title>{`${title}. Измерения по минутам, пропуски показаны разрывами.`}</title>
                  <line x1="4" y1="112" x2="636" y2="112" className="runtime-chart__axis" />
                  <path
                    d={historyChartPath(series, start, end)}
                    className={`runtime-chart__line${duration ? ' runtime-chart__line--latency' : ''}`}
                  />
                  {values.length === 1 && (
                    <circle
                      cx={
                        4 +
                        ((Date.parse(series.find((point) => point.value !== null)!.at) - start) /
                          Math.max(1, end - start)) *
                          632
                      }
                      cy={112 - (values[0]! / Math.max(1, values[0]!)) * 104}
                      r="2"
                      className="runtime-chart__point"
                    />
                  )}
                </svg>
              ) : (
                <div className="runtime-chart__empty">Нет измерений за этот период</div>
              )}
              <div className="runtime-chart__scale">
                <span>
                  {new Date(start).toLocaleTimeString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  МСК
                </span>
                <span>
                  Максимум:{' '}
                  {duration
                    ? overviewDuration(values.length ? Math.max(...values) : null)
                    : overviewNumber(values.length ? Math.max(...values) : null)}
                </span>
                <span>Сейчас</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function RuntimeOverviewSnapshot({
  snapshot: receivedSnapshot,
  now = Date.now(),
  failedRefresh = false,
  onEvidence = () => {},
}: {
  snapshot: SafetyDeskOverviewResponse;
  now?: number;
  failedRefresh?: boolean;
  onEvidence?: (family: EvidenceFamily) => void;
}) {
  const snapshot = failedRefresh ? staleOverview(receivedSnapshot) : receivedSnapshot;
  const status = overviewStatus(snapshot, now, failedRefresh);
  const attentionCount = snapshot.bots.filter((bot) => {
    const status = overviewBotStatus(bot, now, snapshot.actions.value?.sampleComplete === true);
    return (
      ['warning', 'danger'].includes(status.tone) ||
      ['Данные неполные', 'Неполная выборка', 'Неполные данные задержки'].includes(status.label)
    );
  }).length;
  const actionData = snapshot.actions.value;
  const queueData = snapshot.queues.value;
  const totalJobs = queueData
    ? queueData.rows.reduce((sum, row) => sum + queueTotal(row), 0)
    : null;
  const pace =
    overviewAvailability(snapshot.actions, now) === 'FRESH' && actionData
      ? `${actionData.sampleComplete ? '' : '≥ '}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(actionData.sampleComplete ? actionData.sampleCount / 15 : Math.floor((actionData.sampleCount / 15) * 10) / 10)}`
      : 'Нет свежих данных';
  return (
    <div className="runtime-overview">
      <div className={`runtime-summary runtime-tone--${status.tone}`}>
        <div>
          <span className={`runtime-status runtime-status--${status.tone}`}>{status.label}</span>
          <p>
            Требуют внимания:{' '}
            <strong>
              {attentionCount} из {snapshot.bots.length}
            </strong>
          </p>
        </div>
        <div className="runtime-summary__time">
          <span>Последний успешный сбор</span>
          <strong>{observationTime(snapshot.collector.lastSuccessfulAt)}</strong>
          <SourceStamp source={snapshot.collector} now={now} />
        </div>
      </div>
      <div className="runtime-measure-grid">
        <article className="runtime-measure">
          <h3>Заданий в очередях</h3>
          <strong className="runtime-measure__value">{overviewNumber(totalJobs)}</strong>
          <span className="runtime-note">Ожидают, исполняются или отложены</span>
          <SourceStamp source={snapshot.queues} now={now} />
        </article>
        <Pending label="События настроенных ботов" observation={snapshot.receipts} now={now} />
        <Pending
          label="Незавершённые действия"
          observation={snapshot.unfinishedActions}
          now={now}
        />
      </div>
      <section className="runtime-section" aria-label="Состояние ботов">
        <div className="runtime-section__heading">
          <h3>Боты</h3>
          <span className="runtime-note">Наблюдения обрабатываемой работы</span>
        </div>
        <div className="runtime-bot-grid">
          {snapshot.bots.map((bot) => (
            <BotCard
              key={bot.botId}
              bot={bot}
              now={now}
              actionSampleComplete={snapshot.actions.value?.sampleComplete === true}
              onEvidence={onEvidence}
            />
          ))}
        </div>
        {snapshot.bots.length === 0 && <p className="runtime-empty">Список ботов не получен</p>}
      </section>
      <Queues snapshot={snapshot} now={now} />
      <section className="runtime-section" aria-label="Задержки и результаты">
        <div className="runtime-section__heading">
          <h3>Завершённые действия за 15 минут</h3>
          <SourceStamp source={snapshot.actions} now={now} />
        </div>
        <dl className="runtime-inline-values">
          <div>
            <dt>Результатов в минуту</dt>
            <dd>{pace}</dd>
          </div>
        </dl>
        <span className="runtime-note">
          Среднее за 15 минут, включая ошибки и неизвестные исходы
        </span>
        <Percentiles
          value={actionData?.latency ?? null}
          fresh={overviewAvailability(snapshot.actions, now) === 'FRESH'}
        />
        <p className="runtime-note">
          В выборке:{' '}
          {actionData
            ? `${actionData.sampleComplete ? '' : '≥ '}${overviewNumber(actionData.sampleCount)}`
            : 'нет данных'}
          . С измеренной задержкой: {overviewNumber(actionData?.latency.sampleCount)}. Задержка
          отсчитывается от готовности действия до конечного состояния.
        </p>
        <Outcomes values={actionData?.outcomes ?? null} />
        <details>
          <summary>Покрытие и этапы ожидания</summary>
          <p>
            Событие ожидает обработки → действие ожидает исполнения → записан результат. Возраст
            незавершённой работы показан отдельно от задержек завершённых действий.
          </p>
          <p>
            Незавершённые события учтены для настроенных ботов и основного бота. События удалённых
            из настроек ботов в этот обзор не входят.
          </p>
          {actionData && (
            <p className="runtime-note">
              Окно результатов: {observationTime(actionData.windowStartedAt)} —{' '}
              {observationTime(actionData.windowEndedAt)}.{' '}
              {actionData.sampleComplete
                ? 'Выборка полная.'
                : 'Достигнут предел выборки; результаты могут быть больше.'}
            </p>
          )}
          <div className="runtime-evidence-actions">
            <button type="button" className="ghost-action" onClick={() => onEvidence('webhook')}>
              Обработка событий
            </button>
            <button type="button" className="ghost-action" onClick={() => onEvidence('deletion')}>
              Удаления
            </button>
            <button type="button" className="ghost-action" onClick={() => onEvidence('delivery')}>
              Доставки Публика
            </button>
          </div>
        </details>
      </section>
      <History snapshot={snapshot} now={now} />
      <details className="runtime-section">
        <summary>Наблюдаемые процессы</summary>
        <p>
          {snapshot.workers.value
            ? `Свежие отчёты: ${snapshot.workers.value.freshCount} из ${snapshot.workers.value.expectedCount}`
            : 'Общие отчёты процессов недоступны'}
        </p>
        <SourceStamp source={snapshot.workers} now={now} />
        <ul className="runtime-worker-list">
          {snapshot.workers.value?.rows.map((row) => (
            <li key={row.service}>
              <span>{row.service}</span>
              <span>{observationTime(row.observedAt)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function RuntimeOverviewDesk({
  accessCode,
  refreshToken,
  accessScope,
  onEvidence,
}: {
  accessCode: string;
  refreshToken: number;
  accessScope: OverviewAccessScope;
  onEvidence: (family: EvidenceFamily) => void;
}) {
  const view = useRuntimeOverview(accessCode, refreshToken, accessScope);
  return (
    <section
      className="cohort-desk runtime-desk"
      aria-label="Боты и очереди"
      aria-busy={view.loading}
    >
      <div className="runtime-section__heading">
        <h2>Боты и очереди</h2>
        <span className="runtime-note">Обновление каждые 15 секунд</span>
      </div>
      {view.loading && !view.snapshot && <p role="status">Читаю сохранённые наблюдения…</p>}
      {view.error && (
        <p role="alert" className="auth-alert">
          {view.error}
        </p>
      )}
      {view.snapshot && (
        <RuntimeOverviewSnapshot
          snapshot={view.snapshot}
          failedRefresh={Boolean(view.error)}
          onEvidence={onEvidence}
        />
      )}
    </section>
  );
}
