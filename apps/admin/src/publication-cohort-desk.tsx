import type {
  SafetyDeskPublicationCohortResponse,
  SafetyDeskPublicationCohortRow,
} from '@maxim/contracts/safety-desk';
import { useEffect, useState } from 'react';
import { safetyDeskApiClient } from './safety-desk-api-client';

const labels: Record<SafetyDeskPublicationCohortRow['status'], string> = {
  SCHEDULED: 'Запланировано',
  IN_PROGRESS: 'Выполняется',
  SENT: 'Отправка завершена',
  PARTIAL: 'Частично выполнено',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Исход неизвестен',
  CANCELED: 'Отменено',
};
const clock = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const time = (value: string) => `${clock.format(new Date(value))} МСК`;

export function PublicationCohortDesk({ refreshToken }: { refreshToken: number }) {
  const [snapshot, setSnapshot] = useState<SafetyDeskPublicationCohortResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    setLoading(true);
    setFailed(false);
    void safetyDeskApiClient
      .fetchPublicationCohort()
      .then(
        (result) => {
          if (current) setSnapshot(result);
        },
        () => {
          if (current) setFailed(true);
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
    <section className="cohort-desk" aria-label="Результаты запусков Публика" aria-busy={loading}>
      <header>
        <h2>Запуски Публика</h2>
        <p>
          Все состояния запусков, созданных за закрытые 15 минут. Снимок сделан через 30 секунд
          после конца интервала.
        </p>
      </header>
      {loading && <p role="status">Загружаю запуски Публика…</p>}
      {failed && (
        <p role="alert" className="auth-alert">
          Не удалось проверить запуски Публика. Обновите наблюдения позже.
        </p>
      )}
      {snapshot && (
        <>
          <p>
            Интервал:{' '}
            <strong>
              {time(snapshot.windowStartedAt)} — {time(snapshot.windowEndedAt)}
            </strong>
          </p>
          <p>
            Состояния проверены: <strong>{time(snapshot.observedAt)}</strong>
          </p>
          <p>
            {snapshot.sampleComplete
              ? 'Полная выборка интервала'
              : 'Неполная выборка: достигнут предел чтения'}
            . Запусков:{' '}
            <strong>
              {snapshot.sampleComplete ? '' : 'не менее '}
              {snapshot.totalCountLowerBound}
            </strong>
            .
          </p>
          <p className="cohort-evidence-note">
            Один запуск может включать много получателей. Это число созданных запусков, а не
            запросов или сообщений. Поздний ручной повтор отдельно не учитывается. Статус запуска не
            подтверждает результат каждого внешнего действия.
          </p>
          {snapshot.totalCountLowerBound === 0 && (
            <p role="status">
              За этот интервал новые запуски не наблюдались. Пустая выборка не подтверждает доставку
              публикаций.
            </p>
          )}
          <div className="cohort-table-scroll">
            <table className="cohort-table">
              <caption>Состояния созданных запусков</caption>
              <thead>
                <tr>
                  <th scope="col">Состояние</th>
                  <th scope="col">Запуски</th>
                  <th scope="col">Срок ещё не наступил</th>
                  <th scope="col">Ожидают исполнения</th>
                  <th scope="col">Срок истёк</th>
                  <th scope="col">Срок неизвестен</th>
                  <th scope="col">Есть препятствие</th>
                  <th scope="col">Самое долгое ожидание</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((row) => (
                  <tr key={row.status}>
                    <th scope="row">{labels[row.status]}</th>
                    <td>
                      {row.truncated ? '≥ ' : ''}
                      {row.countLowerBound}
                    </td>
                    <td>{row.pendingNotDue}</td>
                    <td>{row.pendingDue}</td>
                    <td>{row.pendingExpired}</td>
                    <td>{row.pendingTimingUnknown}</td>
                    <td>{row.blockedPending}</td>
                    <td>
                      {row.oldestDueAgeSec === null
                        ? 'Нет измерений'
                        : `${row.oldestDueAgeSec.toFixed(1)} с`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Режимы и содержимое запусков</summary>
            <div className="cohort-table-scroll">
              <table className="cohort-table">
                <caption>Классификация по сохранённым данным</caption>
                <thead>
                  <tr>
                    <th scope="col">Состояние</th>
                    <th scope="col">Сейчас</th>
                    <th scope="col">Один раз</th>
                    <th scope="col">Даты</th>
                    <th scope="col">Повторение</th>
                    <th scope="col">Режим неизвестен</th>
                    <th scope="col">Текст</th>
                    <th scope="col">Изображение</th>
                    <th scope="col">Видео</th>
                    <th scope="col">Содержимое неизвестно</th>
                    <th scope="col">Сохранено разрешение повторить</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.rows.map((row) => (
                    <tr key={row.status}>
                      <th scope="row">{labels[row.status]}</th>
                      {(['NOW', 'ONCE', 'SLOTS', 'RECURRENCE', 'UNKNOWN'] as const).map((mode) => (
                        <td key={mode}>{row.modeCounts[mode]}</td>
                      ))}
                      {(['TEXT', 'IMAGE', 'VIDEO', 'UNKNOWN'] as const).map((media) => (
                        <td key={media}>{row.mediaCounts[media]}</td>
                      ))}
                      <td>{row.retryAuthorizedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p>
            Ожидание рассчитано от назначенного времени для запусков, срок которых уже наступил, но
            ещё не истёк. Истечение срока не доказывает отсутствие начатого действия. Время
            завершения не записано и здесь не оценивается. Сохранённое разрешение повторить не
            подтверждает действующее право отправки; неизвестный исход не разрешает автоматический
            повтор.
          </p>
        </>
      )}
    </section>
  );
}
