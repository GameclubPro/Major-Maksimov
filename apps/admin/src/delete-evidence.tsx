import type { SafetyDeskDeleteEvidenceResponse } from '@maxim/contracts/safety-desk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError } from './api-response';
import { safetyDeskApiClient } from './safety-desk-api-client';

type NoticeEvidence = SafetyDeskDeleteEvidenceResponse['followups']['items'][number]['explanation'];
const noticeLabels: Record<NoticeEvidence['state'], string> = {
  confirmed: 'Отправка подтверждена MAX',
  unknown: 'Исход отправки неизвестен',
  pending: 'Ожидает исполнения',
  stopped: 'Исполнение остановлено',
  not_recorded: 'Связанная квитанция не найдена',
  invalid_evidence: 'Данные подтверждения не согласуются',
};
const deletionLabels: Record<SafetyDeskDeleteEvidenceResponse['deletion']['outcome'], string> = {
  confirmed: 'Удаление подтверждено MAX',
  acknowledged: 'MAX подтвердил запрос; проверка удаления не завершена',
  already_absent: 'Отсутствие сообщения подтверждено',
  unknown: 'Исход удаления неизвестен',
  pending: 'Удаление ожидает исполнения',
  stopped: 'Исполнение удаления остановлено',
  observed: 'Записано наблюдение',
};
const evidenceClock = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function deleteEvidenceErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.status === 401 || error.status === 403)
      return 'Нет доступа к подтверждениям удаления.';
    if (error.status === 404) return 'Запись удаления не найдена.';
  }
  return 'Не удалось загрузить подтверждения. Повторите загрузку позже.';
}

export function DeleteEvidence({ intentId }: { intentId: string }) {
  const [snapshot, setSnapshot] = useState<SafetyDeskDeleteEvidenceResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const scope = useMemo(() => ({}), [intentId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    ++sequence.current;
    setSnapshot(null);
    setError('');
    setLoading(false);
    return () => {
      ++sequence.current;
    };
  }, [scope]);

  async function load() {
    if (loading) return;
    const request = ++sequence.current;
    const current = () => request === sequence.current && scope === currentScope.current;
    setLoading(true);
    setSnapshot(null);
    setError('');
    try {
      const result = await safetyDeskApiClient.fetchDeleteEvidence(intentId);
      if (current()) setSnapshot(result);
    } catch (cause) {
      if (current()) setError(deleteEvidenceErrorMessage(cause));
    } finally {
      if (current()) setLoading(false);
    }
  }

  return (
    <section className="delete-section" aria-label="Подтверждения результата" aria-busy={loading}>
      <div className="delete-section__head">
        <h3>Подтверждения результата</h3>
        <button
          className="ghost-action"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Загружаю…' : snapshot ? 'Обновить подтверждения' : 'Проверить подтверждения'}
        </button>
      </div>
      {error && (
        <p className="auth-alert" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Читаю сохранённые подтверждения выбранного удаления…</p>}
      {!snapshot && !loading && !error && (
        <p>Проверка загружает сохранённые результаты удаления и связанных уведомлений.</p>
      )}
      {snapshot && (
        <>
          <p>
            <strong>{deletionLabels[snapshot.deletion.outcome]}</strong>
          </p>
          <dl className="delete-timeline">
            <div>
              <dt>Снимок подтверждений</dt>
              <dd>{time(snapshot.observedAt)}</dd>
            </div>
            <div>
              <dt>Удаление принято</dt>
              <dd>{time(snapshot.deletion.createdAt)}</dd>
            </div>
            <div>
              <dt>Первое исполнение</dt>
              <dd>{time(snapshot.deletion.firstAttemptAt)}</dd>
            </div>
            <div>
              <dt>Ответ MAX / проверка отсутствия</dt>
              <dd>{time(snapshot.deletion.acknowledgedAt)}</dd>
            </div>
            <div>
              <dt>Завершение сохранено</dt>
              <dd>{time(snapshot.deletion.completedAt)}</dd>
            </div>
          </dl>
          <p>
            {snapshot.originCoverage === 'partial'
              ? 'Для части причин сохранена связь с исходным событием. Каждая связь проверяется отдельно.'
              : 'Связь с исходным входящим событием не сохранена. Результат относится к выбранному удалению.'}
          </p>
          {snapshot.reasons.items
            .filter((reason) => reason.origin && reason.origin.state !== 'not_recorded')
            .map((reason) => (
              <article className="delete-section" key={reason.reasonKey}>
                <strong>{reason.ruleCode}</strong>
                <p>
                  {reason.origin?.state === 'linked'
                    ? `Исходное событие и исполнитель подтверждены. Событие принято: ${time(reason.origin.acceptedAt)}.`
                    : reason.origin?.state === 'source_unavailable'
                      ? 'Связь сохранена, но исходное событие уже недоступно для проверки.'
                      : 'Данные связи с исходным событием не согласуются.'}
                </p>
                <p>Запись связи сама по себе не подтверждает удаление.</p>
              </article>
            ))}
          <p>
            {snapshot.reasons.items.filter((reason) => reason.decisionRecorded).length} из{' '}
            {snapshot.reasons.items.length} показанных причин имеют связанную запись действия.
          </p>
          {!snapshot.reasons.sampleComplete && <p>Показаны первые 32 причины; список неполный.</p>}
          {!snapshot.followups.sampleComplete && (
            <p>Показаны первые 32 продолжения; список неполный.</p>
          )}
          {snapshot.followups.items.length === 0 ? (
            <p>Связанные продолжения не найдены. Это не доказывает отсутствие других действий.</p>
          ) : (
            <div className="delete-reason-list">
              {snapshot.followups.items.map((followup) => (
                <article key={followup.id}>
                  <strong>{followup.ruleCode}</strong>
                  <p>
                    {followup.decisionRecorded
                      ? 'Решение о санкции записано.'
                      : 'Связанное решение о санкции не подтверждено.'}
                  </p>
                  <p>
                    Объяснение: {noticeLabels[followup.explanation.state]}
                    {followup.explanation.completedAt
                      ? ` · ${time(followup.explanation.completedAt)}`
                      : ''}
                    .
                  </p>
                  <p>
                    Уведомление о санкции: {noticeLabels[followup.sanctionNotice.state]}
                    {followup.sanctionNotice.completedAt
                      ? ` · ${time(followup.sanctionNotice.completedAt)}`
                      : ''}
                    .
                  </p>
                </article>
              ))}
            </div>
          )}
          <p>
            Отсутствующая квитанция не доказывает отсутствие отправки. Подтверждение MAX не
            доказывает отображение в клиенте. При неизвестном исходе автоматический повтор
            недоступен.
          </p>
        </>
      )}
    </section>
  );
}

function time(value: string | null): string {
  return value ? `${evidenceClock.format(new Date(value))} МСК` : 'Не записано';
}
