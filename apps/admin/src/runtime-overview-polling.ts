import { AdminApiError } from './api-response';

export type OverviewPollState<T> = {
  snapshot: T | null;
  loading: boolean;
  error: string;
  denied: boolean;
};

export type OverviewPollEnvironment = {
  visible(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  schedule(callback: () => void, delayMs: number): () => void;
};

const browserEnvironment: OverviewPollEnvironment = {
  visible: () => document.visibilityState !== 'hidden',
  onVisibilityChange(callback) {
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export function startOverviewPolling<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onChange: (state: OverviewPollState<T>) => void,
  environment: OverviewPollEnvironment = browserEnvironment,
) {
  let stopped = false;
  let denied = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let cancelNext: (() => void) | null = null;
  let cancelDeadline: (() => void) | null = null;
  let snapshot: T | null = null;
  let failures = 0;

  const clearRequest = () => {
    generation += 1;
    cancelDeadline?.();
    cancelDeadline = null;
    controller?.abort();
    controller = null;
  };
  const clearNext = () => {
    cancelNext?.();
    cancelNext = null;
  };
  const schedule = () => {
    if (stopped || denied || !environment.visible()) return;
    cancelNext = environment.schedule(
      () => {
        cancelNext = null;
        refresh();
      },
      Math.min(60_000, 15_000 * 2 ** failures),
    );
  };
  const fail = () => {
    failures = Math.min(failures + 1, 2);
    onChange({
      snapshot,
      loading: false,
      denied: false,
      error: snapshot
        ? 'Не удалось обновить наблюдения. Показан предыдущий снимок.'
        : 'Наблюдения временно недоступны. Повторю проверку.',
    });
    schedule();
  };
  function refresh() {
    if (stopped || denied || !environment.visible()) return;
    clearNext();
    clearRequest();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    onChange({ snapshot, loading: true, error: '', denied: false });
    cancelDeadline = environment.schedule(() => {
      clearRequest();
      fail();
    }, 12_000);
    void Promise.resolve()
      .then(() => load(requestController.signal))
      .then(
        (value) => {
          if (stopped || generation !== requestGeneration) return;
          cancelDeadline?.();
          cancelDeadline = null;
          controller = null;
          snapshot = value;
          failures = 0;
          onChange({ snapshot, loading: false, error: '', denied: false });
          schedule();
        },
        (cause: unknown) => {
          if (stopped || generation !== requestGeneration) return;
          cancelDeadline?.();
          cancelDeadline = null;
          controller = null;
          if (cause instanceof AdminApiError && [401, 403].includes(cause.status)) {
            // FLAG: Access loss clears evidence and ends reads until a new owner scope is mounted.
            denied = true;
            snapshot = null;
            clearNext();
            onChange({
              snapshot: null,
              loading: false,
              error: 'Нет доступа к наблюдениям.',
              denied,
            });
            return;
          }
          fail();
        },
      );
  }
  const unsubscribe = environment.onVisibilityChange(() => {
    clearNext();
    clearRequest();
    if (environment.visible()) refresh();
  });
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearNext();
      clearRequest();
      unsubscribe();
    },
  };
}
