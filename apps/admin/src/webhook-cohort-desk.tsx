import type {
  SafetyDeskWebhookCohortResponse,
  SafetyDeskWebhookCohortRow,
} from '@maxim/contracts/safety-desk';
import { useEffect, useState } from 'react';
import { safetyDeskApiClient } from './safety-desk-api-client';
import { readErrorMessage } from './safety-desk-model';

const statusLabels: Record<SafetyDeskWebhookCohortRow['status'], string> = {
  RECEIVED: 'Ожидает подготовки',
  QUEUED: 'Передано обработчику',
  PROCESSED: 'Событие обработано',
  DUPLICATE: 'Повторное входящее событие',
  FAILED: 'Обработка завершилась ошибкой',
  NO_REPLAY_HELD: 'Повтор запрещён',
  CANCELLED: 'Обработка отменена',
  QUARANTINED: 'Карантин',
};

const cohortClock = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
function formatCohortTime(value: string) {
  return `${cohortClock.format(new Date(value))} МСК`;
}

function latency(value: number | null) {
  return value === null ? 'Нет измерений' : `${(value / 1000).toFixed(2)} с`;
}

export function WebhookCohortDesk({ refreshToken }: { refreshToken: number }) {
  const [snapshot, setSnapshot] = useState<SafetyDeskWebhookCohortResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void safetyDeskApiClient
      .fetchWebhookCohort()
      .then(
        (result) => {
          if (current) setSnapshot(result);
        },
        (cause: unknown) => {
          if (current) setError(readErrorMessage(cause));
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [refreshToken]);

  return (
    <section className="cohort-desk" aria-label="Результаты обработки событий" aria-busy={loading}>
      <header>
        <h2>Обработка событий</h2>
        <p>
          Все состояния событий, поступивших за закрытый интервал в 30 секунд. После конца интервала
          выдерживается ещё 30 секунд для наблюдения результата.
        </p>
      </header>
      {loading && <p role="status">Загружаю наблюдения…</p>}
      {error && (
        <p className="auth-alert" role="alert">
          {error}
          {snapshot ? ' Ниже — последний успешный снимок; обновление не подтверждено.' : ''}
        </p>
      )}
      {snapshot && (
        <>
          <div className="cohort-summary">
            <p>
              Интервал:{' '}
              <strong>
                {formatCohortTime(snapshot.windowStartedAt)} —{' '}
                {formatCohortTime(snapshot.windowEndedAt)}
              </strong>
            </p>
            <p>
              Состояния проверены: <strong>{formatCohortTime(snapshot.observedAt)}</strong>
            </p>
            <p>
              {snapshot.sampleComplete
                ? 'Полная выборка интервала'
                : 'Неполная выборка: достигнут предел чтения'}
              . Событий:{' '}
              <strong>
                {snapshot.sampleComplete ? '' : 'не менее '}
                {snapshot.totalCountLowerBound}
              </strong>
              .
            </p>
          </div>
          <p className="cohort-evidence-note">
            Обработка события не подтверждает удаление, санкцию или отправку сообщения. Здесь нет
            связанной квитанции действия; его результат не установлен.
          </p>
          {snapshot.totalCountLowerBound === 0 && (
            <p role="status">
              За этот интервал события не наблюдались. Пустая выборка не подтверждает работу всех
              функций.
            </p>
          )}
          <div className="cohort-table-scroll">
            <table className="cohort-table">
              <caption>Состояния входящих событий</caption>
              <thead>
                <tr>
                  <th scope="col">Состояние</th>
                  <th scope="col">События</th>
                  <th scope="col">Истёк срок исполнения</th>
                  <th scope="col">Подготовка p95</th>
                  <th scope="col">Обработка p95</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((row) => (
                  <tr key={row.status}>
                    <th scope="row">{statusLabels[row.status]}</th>
                    <td>
                      {row.truncated ? '≥ ' : ''}
                      {row.countLowerBound}
                    </td>
                    <td>{row.expiredAtObservation}</td>
                    <td>{latency(row.enqueueLatency.p95Ms)}</td>
                    <td>{latency(row.processedLatency.p95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Время обработки рассчитано только для завершённых событий с корректными отметками
            времени. Истечение срока не доказывает отсутствие уже начатого действия.
          </p>
        </>
      )}
    </section>
  );
}
