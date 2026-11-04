import type { SafetyDeskCommercialAiResponse } from '@maxim/contracts/safety-desk';
import { safetyDeskApiClient } from './safety-desk-api-client';
import { ObservationPanel, observationTime, useObservationSnapshot } from './observation-view';
import { CommercialAiPoolDesk } from './commercial-ai-pool-desk';

const load = () => safetyDeskApiClient.fetchCommercialAiRuntime();
const modes: Record<SafetyDeskCommercialAiResponse['mode'], string> = {
  OFF: 'Выключен',
  OBSERVE: 'Наблюдение без удаления',
  DELETE_ONLY: 'Удаление рекламы',
};
const availability: Record<
  SafetyDeskCommercialAiResponse['availability'],
  { title: string; detail: string; tone: 'neutral' | 'fresh' | 'warning' }
> = {
  DISABLED: {
    title: 'Выключен в настройках',
    detail: 'Сохранённые результаты относятся к предыдущей работе процесса.',
    tone: 'neutral',
  },
  OBSERVING: {
    title: 'Настроен режим наблюдения',
    detail: 'Удаление отключено. Работа модели этим снимком не подтверждается.',
    tone: 'neutral',
  },
  FRESH: {
    title: 'Сигнал был свежим на момент снимка',
    detail: 'Сигнал процесса не подтверждает доступность модели.',
    tone: 'fresh',
  },
  STALE: {
    title: 'Сигнал процесса устарел',
    detail: 'Показан последний сохранённый снимок. Текущая работа не подтверждена.',
    tone: 'warning',
  },
  MISSING: {
    title: 'Нет наблюдений',
    detail: 'Сохранённый снимок процесса отсутствует.',
    tone: 'warning',
  },
  INVALID: {
    title: 'Некорректные наблюдения',
    detail: 'Сохранённые данные не прошли проверку. Состояние процесса неизвестно.',
    tone: 'warning',
  },
  UNAVAILABLE: {
    title: 'Наблюдения недоступны',
    detail: 'Не удалось прочитать сохранённое состояние. Обновите наблюдения позже.',
    tone: 'warning',
  },
};
const admissions: Record<SafetyDeskCommercialAiResponse['admission'], string> = {
  UNKNOWN: 'Неизвестен',
  READY: 'Ограничения ресурсов не обнаружены',
  GOVERNOR_PAUSED: 'Пауза из-за нагрузки на основные задачи',
  HEADROOM_PAUSED: 'Пауза из-за нехватки свободных ресурсов',
};
const otherOutcomes = {
  deleteNotAdmitted: 'Удаление не допущено',
  registrationUnknown: 'Исход регистрации удаления неизвестен',
  capacitySkipped: 'Пропущено: достигнут предел параллельной обработки',
  unavailableSkipped: 'Пропущено: классификатор недоступен',
  sourceExpired: 'Истёк срок обработки сообщения',
  pressureSkipped: 'Пропущено: нагрузка на сервер',
  dependencyUnavailable: 'Недоступны зависимости',
  other: 'Прочие исходы',
} as const;
const pendingDiscards = {
  expired: 'Истёк срок ожидания',
  foreignWorker: 'Ожидание от другого процесса',
  invalidPending: 'Некорректная запись ожидания',
} as const;

export function CommercialAiSnapshot({ snapshot }: { snapshot: SafetyDeskCommercialAiResponse }) {
  const state = availability[snapshot.availability];
  return (
    <div className="commercial-ai-snapshot">
      <div className={`commercial-ai-state commercial-ai-state--${state.tone}`} role="status">
        <strong>{state.title}</strong>
        <p>{state.detail}</p>
        <p>
          Снимок сформирован: {observationTime(snapshot.generatedAt)}. Данные обновляются кнопкой
          «Обновить».
        </p>
      </div>
      <dl className="commercial-ai-overview">
        <div>
          <dt>Режим в настройках</dt>
          <dd>{modes[snapshot.mode]}</dd>
        </div>
        <div>
          <dt>Последний сигнал процесса</dt>
          <dd>{observationTime(snapshot.heartbeatAt)}</dd>
        </div>
        <div>
          <dt>Последний учтённый результат</dt>
          <dd>{observationTime(snapshot.lastRecordedResultAt)}</dd>
        </div>
        <div>
          <dt>В работе на момент снимка</dt>
          <dd>{snapshot.active ?? 'Нет данных'}</dd>
        </div>
      </dl>
      <div className="commercial-ai-admission">
        <strong>
          Последняя проверка допуска на момент снимка: {admissions[snapshot.admission]}
        </strong>
        <p>Проверено: {observationTime(snapshot.admissionObservedAt)}</p>
      </div>
      <section aria-label="Накопленные результаты процесса">
        <h3>Накопленные результаты процесса</h3>
        <p>
          {snapshot.observationStartedAt === null
            ? 'Начало периода не записано.'
            : `Начало периода: ${observationTime(snapshot.observationStartedAt)}.`}{' '}
          Снимок: {observationTime(snapshot.observedAt)}.
        </p>
        {snapshot.outcomes === null ? (
          <p>Счётчики результатов отсутствуют.</p>
        ) : (
          <>
            <dl className="commercial-ai-metrics">
              <div>
                <dt>Решение «Оставить»</dt>
                <dd>{snapshot.outcomes.kept}</dd>
              </div>
              <div>
                <dt>Неуверенный ответ</dt>
                <dd>{snapshot.outcomes.unsure}</dd>
              </div>
              <div>
                <dt>Зарегистрировано намерений удаления</dt>
                <dd>{snapshot.outcomes.deleteRegistered}</dd>
              </div>
            </dl>
            <details>
              <summary>Пропуски и другие исходы</summary>
              <div className="cohort-table-scroll">
                <table className="cohort-table">
                  <caption>Исходы за тот же период процесса</caption>
                  <thead>
                    <tr>
                      <th scope="col">Исход</th>
                      <th scope="col">Количество</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Object.keys(otherOutcomes) as Array<keyof typeof otherOutcomes>).map(
                      (key) => (
                        <tr key={key}>
                          <th scope="row">{otherOutcomes[key]}</th>
                          <td>{snapshot.outcomes![key]}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        <p className="cohort-evidence-note">
          Регистрация намерения не подтверждает удаление сообщения. Подтверждённые удаления и доля
          проверенного трафика в этом снимке не установлены.
        </p>
      </section>
      <details>
        <summary>Отброшенные ожидания</summary>
        <p>
          Накоплено в хранилище ожиданий, включая предыдущие процессы. Начало периода неизвестно;
          эти значения не складываются с результатами процесса.
        </p>
        {snapshot.pendingDiscards === null ? (
          <p>Счётчики ожиданий отсутствуют.</p>
        ) : (
          <div className="cohort-table-scroll">
            <table className="cohort-table">
              <caption>Причины удаления записей ожидания</caption>
              <thead>
                <tr>
                  <th scope="col">Причина</th>
                  <th scope="col">Количество</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(pendingDiscards) as Array<keyof typeof pendingDiscards>).map(
                  (key) => (
                    <tr key={key}>
                      <th scope="row">{pendingDiscards[key]}</th>
                      <td>{snapshot.pendingDiscards![key]}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

export function CommercialAiDesk(props: { refreshToken: number }) {
  const view = useObservationSnapshot(load, props.refreshToken);
  return (
    <>
      <ObservationPanel title="Рекламный ИИ" {...view}>
        {view.snapshot && <CommercialAiSnapshot snapshot={view.snapshot} />}
      </ObservationPanel>
      <CommercialAiPoolDesk {...props} />
    </>
  );
}
