import type { SafetyDeskCommercialAiPoolResponse } from '@maxim/contracts/safety-desk';
import { safetyDeskApiClient } from './safety-desk-api-client';
import { ObservationPanel, observationTime, useObservationSnapshot } from './observation-view';

const load = () => safetyDeskApiClient.fetchCommercialAiPoolRuntime();
const names = {
  'server-9b': 'Сервер · Qwen 9B',
  'pc-a-4b': 'ПК-A · Qwen 4B',
  'pc-b-9b': 'ПК-B · Qwen 9B',
  'pc-a-cpu-9b': 'ПК-A · CPU · Qwen 9B',
};
const states = {
  READY: 'Готов принять задание',
  SLOT_OCCUPIED: 'Слот занят',
  NOT_READY: 'Подключён, не готов',
  OFFLINE: 'Нет свежей регистрации',
  INVALID: 'Данные не прошли проверку',
  STALE: 'Состояние устарело',
};
const availability = {
  DISABLED: 'Пул выключен',
  FRESH: 'Свежий снимок узлов',
  STALE: 'Снимок устарел',
  INVALID: 'Некорректные наблюдения',
  UNAVAILABLE: 'Наблюдения недоступны',
};

export function CommercialAiPoolSnapshot({
  snapshot,
}: {
  snapshot: SafetyDeskCommercialAiPoolResponse;
}) {
  return (
    <div className="commercial-ai-snapshot">
      <div
        role="status"
        className={`commercial-ai-state commercial-ai-state--${snapshot.availability === 'FRESH' ? 'fresh' : 'warning'}`}
      >
        <strong>{availability[snapshot.availability]}</strong>
        <p>
          Проверено: {observationTime(snapshot.observedAt)}. Состояние относится к этому снимку.
        </p>
      </div>
      <p>
        {snapshot.routingEnabled
          ? 'Обработка через пул включена.'
          : 'Обработка через пул выключена.'}{' '}
        {snapshot.policy === 'confirm-positive'
          ? 'Решение 4B об удалении требует перепроверки 9B.'
          : 'Разрешены прямые решения 4B.'}
      </p>
      {snapshot.nodes ? (
        <div className="cohort-table-scroll">
          <table className="cohort-table">
            <caption>Доступность моделей на момент проверки</caption>
            <thead>
              <tr>
                <th scope="col">Модель</th>
                <th scope="col">Состояние</th>
                <th scope="col">Сигнал действовал до</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.nodes.map((node) => (
                <tr key={node.nodeId}>
                  <th scope="row">{names[node.nodeId]}</th>
                  <td>{states[node.state]}</td>
                  <td>{observationTime(node.validUntil)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Состояние отдельных моделей не установлено.</p>
      )}
      {snapshot.metrics ? (
        <>
          <h3>Попытки обработки моделями</h3>
          <p>
            С {observationTime(snapshot.metrics.observationStartedAt)} по{' '}
            {observationTime(snapshot.metrics.observedAt)}.
            {snapshot.metrics.availability === 'STALE' ? ' Счётчики устарели.' : ''}
          </p>
          <div className="cohort-table-scroll">
            <table className="cohort-table">
              <caption>
                Первичные проверки, перепроверки и повторные попытки за период процесса
              </caption>
              <thead>
                <tr>
                  <th scope="col">Модель</th>
                  <th scope="col">Ответы</th>
                  <th scope="col">Ошибки</th>
                  <th scope="col">Сглаженное время ответа</th>
                  <th scope="col">Последний ответ</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.metrics.diagnostics.nodes.map((node) => (
                  <tr key={node.nodeId}>
                    <th scope="row">{names[node.nodeId]}</th>
                    <td>{node.completedAttempts}</td>
                    <td>{node.failedAttempts}</td>
                    <td>
                      {node.ewmaDurationMs === null
                        ? 'Нет измерений'
                        : `${(node.ewmaDurationMs / 1000).toFixed(2)} с`}
                    </td>
                    <td>{observationTime(node.lastCompletedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="commercial-ai-metrics">
            <div>
              <dt>Перепроверки завершены</dt>
              <dd>{snapshot.metrics.diagnostics.consultations.completed}</dd>
            </div>
            <div>
              <dt>Без свободной 9B для перепроверки</dt>
              <dd>{snapshot.metrics.diagnostics.consultations.noCapacity}</dd>
            </div>
            <div>
              <dt>Не осталось времени на перепроверку</dt>
              <dd>{snapshot.metrics.diagnostics.consultations.budgetExhausted}</dd>
            </div>
          </dl>
          <p className="cohort-evidence-note">
            Без необходимой перепроверки решение остаётся неопределённым. Число попыток не равно
            числу сообщений или удалений.
          </p>
        </>
      ) : (
        <p>Статистика попыток моделей пока отсутствует.</p>
      )}
    </div>
  );
}

export function CommercialAiPoolDesk(props: { refreshToken: number }) {
  const view = useObservationSnapshot(load, props.refreshToken);
  return (
    <ObservationPanel title="Модели рекламного ИИ" {...view}>
      {view.snapshot && <CommercialAiPoolSnapshot snapshot={view.snapshot} />}
    </ObservationPanel>
  );
}
