import type { SafetyDeskRetentionRuntimeResponse } from '@maxim/contracts/safety-desk';
import { lazy, Suspense } from 'react';
import { RetentionDeskLoadBoundary } from './retention-desk-load-boundary';
import type { RetentionDeskControls } from './retention-desk-state';
import { Metric } from './safety-desk-ui';

const RetentionDesk = lazy(() =>
  import('./retention-desk').then((module) => ({ default: module.RetentionDesk })),
);

export function RetentionDeskPane({ controls }: { controls: RetentionDeskControls }) {
  return (
    <RetentionDeskLoadBoundary>
      <Suspense
        fallback={
          <p className="queue-empty" role="status">
            Загружаю раздел очистки…
          </p>
        }
      >
        <RetentionDesk
          refreshToken={controls.refreshToken}
          onSnapshot={controls.onSnapshot}
          onBusyChange={controls.onBusyChange}
        />
      </Suspense>
    </RetentionDeskLoadBoundary>
  );
}

export function RetentionRuntimeMetrics({
  runtime,
}: {
  runtime: SafetyDeskRetentionRuntimeResponse | null;
}) {
  const unavailable = runtime?.unavailableSources?.length ?? 0;
  const complete = runtime?.incomplete === false && unavailable === 0;
  const reviewCount =
    runtime?.items.filter((item) => item.hasTerminalReview || item.hasUnresolvedReceipt).length ??
    0;
  return (
    <>
      <Metric
        label="Чатов на странице"
        value={runtime ? String(runtime.items.length + unavailable) : '—'}
        tone="neutral"
      />
      <Metric
        label={complete ? 'Нужна проверка' : 'Проверка (по доступным)'}
        value={runtime && (runtime.items.length > 0 || complete) ? String(reviewCount) : '—'}
        tone="warning"
      />
      {unavailable > 0 && (
        <Metric label="Без диагностики" value={String(unavailable)} tone="warning" />
      )}
    </>
  );
}
