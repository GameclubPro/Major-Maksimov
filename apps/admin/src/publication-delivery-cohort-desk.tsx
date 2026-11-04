import { useMemo, useState, type FormEvent } from 'react';
import { safetyDeskApiClient } from './safety-desk-api-client';
import {
  ObservationPanel,
  ObservationWindow,
  observationTime,
  useObservationSnapshot,
} from './observation-view';
import {
  PublicationDeliveryEvidence,
  deliveryStatusLabels,
  deliveryReceiptLabels,
  deliveryWaitLabels,
} from './publication-delivery-evidence';

const load = () => safetyDeskApiClient.fetchPublicationDeliveryCohort();

export function PublicationDeliveryCohortDesk(props: { refreshToken: number }) {
  const view = useObservationSnapshot(load, props.refreshToken);
  const ownerScope = useMemo(() => ({}), []);
  const [input, setInput] = useState({ scope: ownerScope, id: '' });
  const inputId = input.scope === ownerScope ? input.id : '';
  const [selection, setSelected] = useState<{ scope: object; id: string; request: number } | null>(
    null,
  );
  // FLAG: A new owner must explicitly select evidence; never fetch the previous owner's ID.
  const selected = selection?.scope === ownerScope ? selection : null;
  const select = (id: string) => {
    setInput({ scope: ownerScope, id });
    setSelected((current) => ({ scope: ownerScope, id, request: (current?.request ?? 0) + 1 }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = inputId.trim();
    if (id && id.length <= 128) select(id);
  };
  return (
    <>
      <ObservationPanel title="Доставки Публика" {...view}>
        {view.snapshot && (
          <>
            <ObservationWindow snapshot={view.snapshot} />
            <p>
              Все состояния получателей, записанных за закрытые 15 минут. Последующие попытки входят
              в ту же запись. Ещё не созданные получатели учитываются только в наблюдениях запусков.
            </p>
            <div className="cohort-table-scroll">
              <table className="cohort-table">
                <caption>Сохранённые квитанции получателей</caption>
                <thead>
                  <tr>
                    <th scope="col">Состояние</th>
                    <th scope="col">Всего</th>
                    <th scope="col">Неизвестный исход с учётом истории</th>
                    {Object.entries(deliveryReceiptLabels).map(([key, label]) => (
                      <th scope="col" key={key}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.snapshot.rows.map((row) => (
                    <tr key={row.status}>
                      <th scope="row">{deliveryStatusLabels[row.status]}</th>
                      <td>
                        {row.truncated ? '≥ ' : ''}
                        {row.countLowerBound}
                      </td>
                      <td>{row.effectiveStatusCounts.AMBIGUOUS}</td>
                      {(
                        Object.keys(deliveryReceiptLabels) as Array<
                          keyof typeof deliveryReceiptLabels
                        >
                      ).map((key) => (
                        <td key={key}>{row.receiptEvidenceCounts[key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Сводка читает сохранённые квитанции получателей. Точное соответствие журналу действий
              проверяется отдельно для выбранной доставки.
            </p>
            <details>
              <summary>Проверки присутствия и сроки</summary>
              <div className="cohort-table-scroll">
                <table className="cohort-table">
                  <thead>
                    <tr>
                      <th scope="col">Состояние</th>
                      <th scope="col">Повторные проверки MAX</th>
                      <th scope="col">Подтверждение оператора</th>
                      <th scope="col">Историческая проверка</th>
                      <th scope="col">Проверка ожидается</th>
                      <th scope="col">Не назначена</th>
                      <th scope="col">Данные не согласуются</th>
                      <th scope="col">Срок истёк</th>
                      <th scope="col">Срок неизвестен</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.snapshot.rows.map((row) => (
                      <tr key={row.status}>
                        <th scope="row">{deliveryStatusLabels[row.status]}</th>
                        {(
                          [
                            'automated_stable',
                            'operator_confirmed',
                            'legacy_unproven',
                            'pending',
                            'not_recorded',
                            'invalid_evidence',
                          ] as const
                        ).map((key) => (
                          <td key={key}>{row.verificationCounts[key]}</td>
                        ))}
                        <td>{row.deadlineCounts.expired}</td>
                        <td>{row.deadlineCounts.unknown}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <details>
              <summary>Причины ожидания по сохранённым данным</summary>
              <ul>
                {(Object.keys(deliveryWaitLabels) as Array<keyof typeof deliveryWaitLabels>).map(
                  (reason) => {
                    const count = view.snapshot!.rows.reduce(
                      (sum, row) => sum + row.waitingReasonCounts[reason],
                      0,
                    );
                    return count ? (
                      <li key={reason}>
                        {deliveryWaitLabels[reason]}: {count}
                      </li>
                    ) : null;
                  },
                )}
              </ul>
              <p>
                Причины могут пересекаться. Сохранённый захват не доказывает, что обработчик сейчас
                работает.
              </p>
            </details>
            {view.snapshot.examples.length > 0 && (
              <details>
                <summary>Проверить отдельную доставку из выборки</summary>
                <ul>
                  {view.snapshot.examples.map((item) => (
                    <li key={item.deliveryId}>
                      <button
                        type="button"
                        className="ghost-action"
                        onClick={() => select(item.deliveryId)}
                      >
                        {deliveryStatusLabels[item.effectiveStatus]} ·{' '}
                        {observationTime(item.acceptedAt)} · {item.deliveryId}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p>
              Время завершения получателя не записано и здесь не оценивается. Подтверждение MAX не
              доказывает отображение сообщения в клиенте. Неизвестный исход не разрешает
              автоматический повтор.
            </p>
          </>
        )}
      </ObservationPanel>
      <section className="cohort-desk" aria-label="Поиск подтверждений доставки">
        <form onSubmit={submit} className="observation-evidence-search">
          <label>
            Идентификатор доставки
            <input
              value={inputId}
              maxLength={128}
              onChange={(event) => setInput({ scope: ownerScope, id: event.target.value })}
            />
          </label>
          <button type="submit" className="ghost-action" disabled={!inputId.trim()}>
            Проверить доставку
          </button>
        </form>
      </section>
      {selected && (
        <PublicationDeliveryEvidence
          key={props.refreshToken}
          deliveryId={selected.id}
          request={selected.request}
        />
      )}
    </>
  );
}
