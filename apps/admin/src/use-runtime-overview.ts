import { useEffect, useMemo, useRef, useState } from 'react';
import type { SafetyDeskOverviewResponse } from '@maxim/contracts/safety-desk';
import { SafetyDeskApiClient } from './safety-desk-api-client';
import { startOverviewPolling, type OverviewPollState } from './runtime-overview-polling';

const api = new SafetyDeskApiClient();

export type OverviewAccessScope = { denied: boolean };

export function useRuntimeOverview(
  accessCode: string,
  refreshToken: number,
  accessScope: OverviewAccessScope,
) {
  const scope = useMemo(() => ({}), [accessCode, accessScope]);
  const [result, setResult] = useState<{
    scope: object;
    state: OverviewPollState<SafetyDeskOverviewResponse>;
  } | null>(null);
  const active = useRef<{ refresh(): void; stop(): void } | null>(null);
  const previousRefresh = useRef(refreshToken);
  useEffect(() => {
    // FLAG: A denied owner session stays denied when navigation remounts the overview.
    if (accessScope.denied) {
      setResult({
        scope,
        state: {
          snapshot: null,
          loading: false,
          denied: true,
          error: 'Нет доступа к наблюдениям.',
        },
      });
      return;
    }
    const poll = startOverviewPolling(
      (signal) => api.fetchRuntimeOverview(accessCode, signal),
      (state) => {
        if (state.denied) accessScope.denied = true;
        setResult({ scope, state });
      },
    );
    active.current = poll;
    return () => {
      poll.stop();
      if (active.current === poll) active.current = null;
    };
  }, [scope, accessCode, accessScope]);
  useEffect(() => {
    if (previousRefresh.current === refreshToken) return;
    previousRefresh.current = refreshToken;
    active.current?.refresh();
  }, [refreshToken]);
  // FLAG: Synchronous scope comparison hides the previous owner's snapshot before effects run.
  return result?.scope === scope
    ? result.state
    : { snapshot: null, error: '', loading: true, denied: false };
}
