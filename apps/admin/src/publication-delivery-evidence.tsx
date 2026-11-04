import type { SafetyDeskPublicationDeliveryEvidenceResponse } from '@maxim/contracts/safety-desk';
import { useMemo } from 'react';
import { safetyDeskApiClient } from './safety-desk-api-client';
import {
  ObservationPanel,
  observationTime,
  observationDuration,
  useObservationSnapshot,
} from './observation-view';

type Evidence = SafetyDeskPublicationDeliveryEvidenceResponse;
export const deliveryStatusLabels: Record<Evidence['storedStatus'], string> = {
  PENDING: 'Ожидает',
  SENDING: 'Отправляется',
  SENT: 'Отправлено',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Исход неизвестен',
  CANCELED: 'Отменено',
};
export const deliveryReceiptLabels: Record<Evidence['recipient']['state'], string> = {
  saved: 'Квитанция сохранена',
  missing: 'Квитанция не найдена',
  legacy_unproven: 'Историческое подтверждение недостаточно',
  invalid_evidence: 'Данные квитанции не согласуются',
};
export const deliveryVerificationLabels: Record<Evidence['verification']['state'], string> = {
  automated_stable: 'Сохранены повторные проверки присутствия в MAX',
  operator_confirmed: 'Подтверждено оператором',
  legacy_unproven: 'Историческая проверка недостаточна',
  pending: 'Проверка не завершена',
  not_recorded: 'Проверка не записана',
  invalid_evidence: 'Данные проверки не согласуются',
};
export const deliveryWaitLabels: Record<Evidence['waiting']['reasons'][number], string> = {
  scheduled_not_due: 'Назначенное время ещё не наступило',
  deadline_elapsed: 'Срок исполнения истёк',
  deadline_unknown: 'Срок исполнения не подтверждён',
  local_capacity: 'Ожидание локального лимита',
  max_rate_limit: 'Ожидание после ограничения MAX',
  circuit_open: 'Пауза запросов после ошибок',
  other_capacity_reason: 'Другое ограничение отправки',
  retry_not_due: 'Назначенная попытка ещё не наступила',
  retry_due: 'Время назначенной попытки наступило',
  actor_access_required: 'Требуется проверка прав автора',
  target_setup_required: 'Требуется настройка получателя',
  publisher_unavailable: 'Публик недоступен',
  other_blocker: 'Другое препятствие',
  lease_active: 'Сохранён действующий захват',
  lease_stale: 'Срок сохранённого захвата истёк',
  lease_invalid: 'Данные захвата не согласуются',
  receipt_verification_wait: 'Ожидание назначенной проверки присутствия',
  receipt_verification_due: 'Наступило время проверки присутствия',
  verification_not_enrolled: 'Проверка присутствия не назначена',
  post_action_wait: 'Ожидание действия после отправки',
  post_action_due: 'Наступило время действия после отправки',
  post_action_unknown: 'Исход действия после отправки неизвестен',
  effect_unknown: 'Исход отправки неизвестен',
  unspecified_pending: 'Причина ожидания не записана',
};
const actionLabels: Record<Evidence['action']['state'], string> = {
  confirmed: 'Отправка подтверждена в журнале действий',
  acknowledged: 'Есть подтверждение MAX; завершение не доказано',
  unknown: 'Исход отправки неизвестен',
  pending: 'Ожидает исполнения',
  stopped: 'Исполнение остановлено',
  not_recorded: 'Связанный результат не записан',
  invalid_evidence: 'Данные журнала не согласуются',
};
const postActionLabels: Record<Evidence['waiting']['postActions']['pin'], string> = {
  NONE: 'Не назначено',
  PENDING: 'Ожидает',
  RUNNING: 'Выполняется',
  DONE: 'Завершено',
  FAILED: 'Ошибка',
  AMBIGUOUS: 'Исход неизвестен',
  SKIPPED: 'Пропущено',
};

export function PublicationDeliveryEvidence({
  deliveryId,
  request,
}: {
  deliveryId: string;

  request: number;
}) {
  const load = useMemo(
    () => () => safetyDeskApiClient.fetchPublicationDeliveryEvidence(deliveryId),
    [deliveryId],
  );
  const view = useObservationSnapshot(load, request);
  const snapshot = view.snapshot;
  return (
    <ObservationPanel title="Подтверждения доставки" {...view}>
      <p>
        Запись: <code>{deliveryId}</code>
      </p>
      {snapshot && (
        <>
          <p>
            <strong>{actionLabels[snapshot.action.state]}</strong>
          </p>
          <p>
            Состояние записи: {deliveryStatusLabels[snapshot.storedStatus]}. С учётом сохранённых
            подтверждений: {deliveryStatusLabels[snapshot.effectiveStatus]}.
          </p>
          <p>
            {snapshot.binding === 'exact'
              ? 'Связь с получателем и сохранённой версией публикации проверена.'
              : snapshot.binding === 'not_recorded'
                ? 'Связь с версией публикации не записана.'
                : 'Связь с версией публикации не согласуется.'}
          </p>
          <p>
            {deliveryReceiptLabels[snapshot.recipient.state]}.{' '}
            {deliveryVerificationLabels[snapshot.verification.state]}.
          </p>
          {snapshot.recipient.agreesWithAction === false && (
            <p role="alert" className="auth-alert">
              Квитанция получателя расходится с журналом действий. Результат требует проверки.
            </p>
          )}
          <dl className="delete-timeline">
            <div>
              <dt>Снимок</dt>
              <dd>{observationTime(snapshot.observedAt)}</dd>
            </div>
            <div>
              <dt>Получатель записан</dt>
              <dd>{observationTime(snapshot.acceptedAt)}</dd>
            </div>
            <div>
              <dt>Начало внешнего действия</dt>
              <dd>{observationTime(snapshot.action.dispatchStartedAt)}</dd>
            </div>
            <div>
              <dt>Завершение в журнале</dt>
              <dd>{observationTime(snapshot.action.journalCompletedAt)}</dd>
            </div>
            <div>
              <dt>Сохранённое время отправки</dt>
              <dd>{observationTime(snapshot.recipient.savedSendAt)}</dd>
            </div>
            <div>
              <dt>Проверка присутствия</dt>
              <dd>{observationTime(snapshot.verification.observedAt)}</dd>
            </div>
            <div>
              <dt>Следующая назначенная попытка</dt>
              <dd>{observationTime(snapshot.waiting.nextAttemptAt)}</dd>
            </div>
            <div>
              <dt>С первой отсрочки</dt>
              <dd>{observationDuration(snapshot.waiting.ageSinceFirstDeferralMs)}</dd>
            </div>
          </dl>
          <p>
            Сохранённое время отправки не является временем записи квитанции. Возраст первой
            отсрочки не равен суммарному времени ожидания.
          </p>
          <h3>Сохранённые причины ожидания</h3>
          {snapshot.waiting.reasons.length ? (
            <ul>
              {snapshot.waiting.reasons.map((reason) => (
                <li key={reason}>{deliveryWaitLabels[reason]}</li>
              ))}
            </ul>
          ) : (
            <p>Причины не записаны.</p>
          )}
          {snapshot.waiting.recipientBlocker && (
            <p>Получатель: {deliveryWaitLabels[snapshot.waiting.recipientBlocker]}.</p>
          )}
          {snapshot.waiting.parentBlocker && (
            <p>Общий запуск: {deliveryWaitLabels[snapshot.waiting.parentBlocker]}.</p>
          )}
          <p>
            Закрепление: {postActionLabels[snapshot.waiting.postActions.pin]}. Удаление по таймеру:{' '}
            {postActionLabels[snapshot.waiting.postActions.deletion]}.
          </p>
          <p>
            Назначенное действие после отправки:{' '}
            {observationTime(snapshot.waiting.postActions.nextAt)}.
          </p>
          <p>
            Это сохранённые данные, а не проверка текущих прав или активности обработчика.
            Отображение сообщения в клиенте не проверено. Автоматический повтор из этой панели
            недоступен.
          </p>
        </>
      )}
    </ObservationPanel>
  );
}
