import type { SafetyDeskDeleteCohortRow } from '@maxim/contracts/safety-desk';
import { safetyDeskApiClient } from './safety-desk-api-client';
import {
  ObservationPanel,
  ObservationWindow,
  observationDuration,
  useObservationSnapshot,
} from './observation-view';

const load = () => safetyDeskApiClient.fetchDeleteCohort();
const statuses: Record<SafetyDeskDeleteCohortRow['status'], string> = {
  OBSERVED: 'Наблюдение',
  PENDING: 'Ожидает',
  IN_PROGRESS: 'Исполняется',
  RETRYABLE: 'Отложено',
  WAITING_CAPABILITY: 'Ожидает прав',
  AMBIGUOUS: 'Исход неизвестен',
  SUCCEEDED: 'Завершено',
  ALREADY_ABSENT: 'Сообщение отсутствует',
  EXPIRED: 'Срок истёк',
  FAILED_TERMINAL: 'Остановлено',
};
const outcomes: Record<keyof SafetyDeskDeleteCohortRow['outcomeCounts'], string> = {
  confirmed: 'Подтверждено',
  acknowledged: 'Есть ответ MAX',
  already_absent: 'Отсутствие проверено',
  unknown: 'Исход неизвестен',
  stopped: 'Остановлено',
  observed: 'Только наблюдение',
  pending: 'Ожидает',
};
const outcomeKeys = Object.keys(outcomes) as Array<keyof typeof outcomes>;

export function DeleteCohortDesk(props: { refreshToken: number }) {
  const view = useObservationSnapshot(load, props.refreshToken);
  return (
    <ObservationPanel title="Намерения удаления" {...view}>
      {view.snapshot && (
        <>
          <ObservationWindow snapshot={view.snapshot} />
          <p>
            Все состояния записей удаления за закрытые 15 минут. Наблюдение само по себе не
            разрешает удаление; новые причины и последующие попытки не считаются отдельными
            записями.
          </p>
          <div className="cohort-table-scroll">
            <table className="cohort-table">
              <caption>Состояние записи и подтверждение результата</caption>
              <thead>
                <tr>
                  <th scope="col">Состояние</th>
                  <th scope="col">Всего</th>
                  {outcomeKeys.map((key) => (
                    <th scope="col" key={key}>
                      {outcomes[key]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.snapshot.rows.map((row) => (
                  <tr key={row.status}>
                    <th scope="row">{statuses[row.status]}</th>
                    <td>
                      {row.truncated ? '≥ ' : ''}
                      {row.countLowerBound}
                    </td>
                    {outcomeKeys.map((key) => (
                      <td key={key}>{row.outcomeCounts[key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Сроки и время подтверждённых удалений</summary>
            <div className="cohort-table-scroll">
              <table className="cohort-table">
                <thead>
                  <tr>
                    <th scope="col">Состояние</th>
                    <th scope="col">Срок истёк</th>
                    <th scope="col">Срок неизвестен</th>
                    <th scope="col">Измерено</th>
                    <th scope="col">p95</th>
                    <th scope="col">p99</th>
                    <th scope="col">Некорректное время</th>
                  </tr>
                </thead>
                <tbody>
                  {view.snapshot.rows.map((row) => (
                    <tr key={row.status}>
                      <th scope="row">{statuses[row.status]}</th>
                      <td>{row.deadlineCounts.elapsed}</td>
                      <td>{row.deadlineCounts.invalid}</td>
                      <td>{row.finalizedLatency.sampleCount}</td>
                      <td>{observationDuration(row.finalizedLatency.p95Ms)}</td>
                      <td>{observationDuration(row.finalizedLatency.p99Ms)}</td>
                      <td>{row.finalizedLatency.invalidClockCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Сохранённые причины ожидания</summary>
            <div className="cohort-table-scroll">
              <table className="cohort-table">
                <thead>
                  <tr>
                    <th scope="col">Состояние</th>
                    <th scope="col">Ещё не пора</th>
                    <th scope="col">Повтор уже назначен</th>
                    <th scope="col">Захват действует</th>
                    <th scope="col">Захват истёк</th>
                    <th scope="col">Ожидает прав</th>
                    <th scope="col">Сохранение результата</th>
                    <th scope="col">Неизвестный эффект</th>
                  </tr>
                </thead>
                <tbody>
                  {view.snapshot.rows.map((row) => (
                    <tr key={row.status}>
                      <th scope="row">{statuses[row.status]}</th>
                      {(
                        [
                          'notDue',
                          'retryDue',
                          'leaseActive',
                          'leaseStale',
                          'capability',
                          'receiptSettlement',
                          'effectUnknown',
                        ] as const
                      ).map((key) => (
                        <td key={key}>{row.waitCounts[key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Причины могут пересекаться. Сохранённый захват не доказывает, что обработчик сейчас
              работает.
            </p>
          </details>
          <p>
            Время показано только для подтверждённого завершения. Остальные состояния остаются в
            общем числе. Истечение срока и отсутствующая квитанция не доказывают отсутствие внешнего
            действия. Неизвестный исход не разрешает автоматический повтор.
          </p>
        </>
      )}
    </ObservationPanel>
  );
}
