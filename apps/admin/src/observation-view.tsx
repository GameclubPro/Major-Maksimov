import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AdminApiError } from './api-response';

export function useObservationSnapshot<T>(load: () => Promise<T>, refreshToken: number) {
  const scope = useMemo(() => ({}), [load, refreshToken]);
  const [result, setResult] = useState<{
    scope: object;
    snapshot: T | null;
    error: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void load().then(
      (snapshot) => {
        if (current) setResult({ scope, snapshot, error: '' });
      },
      (cause: unknown) => {
        if (!current) return;
        const error =
          cause instanceof AdminApiError && [401, 403].includes(cause.status)
            ? 'Нет доступа к наблюдениям.'
            : cause instanceof AdminApiError && cause.status === 404
              ? 'Запись не найдена.'
              : 'Не удалось проверить данные. Обновите наблюдения позже.';
        setResult({ scope, snapshot: null, error });
      },
    );
    return () => {
      current = false;
    };
  }, [scope, load]);
  // FLAG: A new request scope must never display the previous owner's or entity's evidence.
  return result?.scope === scope
    ? { snapshot: result.snapshot, error: result.error, loading: false }
    : { snapshot: null, error: '', loading: true };
}

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
export const observationTime = (value: string | null) =>
  value === null ? 'Не записано' : `${clock.format(new Date(value))} МСК`;
export const observationDuration = (value: number | null) =>
  value === null ? 'Нет измерений' : `${(value / 1000).toFixed(2)} с`;

export function ObservationWindow({
  snapshot,
}: {
  snapshot: {
    windowStartedAt: string;
    windowEndedAt: string;
    observedAt: string;
    sampleComplete: boolean;
    totalCountLowerBound: number;
  };
}) {
  return (
    <>
      <p>
        Интервал:{' '}
        <strong>
          {observationTime(snapshot.windowStartedAt)} — {observationTime(snapshot.windowEndedAt)}
        </strong>
      </p>
      <p>
        Состояния проверены: <strong>{observationTime(snapshot.observedAt)}</strong>
      </p>
      <p>
        {snapshot.sampleComplete
          ? 'Полная выборка интервала'
          : 'Неполная выборка: достигнут предел чтения'}
        . Записей:{' '}
        <strong>
          {snapshot.sampleComplete ? '' : 'не менее '}
          {snapshot.totalCountLowerBound}
        </strong>
        .
      </p>
      {snapshot.totalCountLowerBound === 0 && (
        <p role="status">
          За этот интервал новые записи не наблюдались. Пустая выборка не подтверждает выполнение
          действий.
        </p>
      )}
    </>
  );
}

export function ObservationPanel({
  title,
  loading,
  error,
  children,
}: {
  title: string;
  loading: boolean;
  error: string;
  children: ReactNode;
}) {
  return (
    <section className="cohort-desk" aria-label={title} aria-busy={loading}>
      <h2>{title}</h2>
      {loading && <p role="status">Читаю сохранённые наблюдения…</p>}
      {error && (
        <p role="alert" className="auth-alert">
          {error}
        </p>
      )}
      {children}
    </section>
  );
}
