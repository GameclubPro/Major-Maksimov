import { useEffect, useRef } from 'react';
import type { ChatClosureStatus, ChatClosureSummary } from '@maxim/contracts/settings';
import { useQuery } from '@tanstack/react-query';
import type { ApiTransport } from '../../lib/api/transport';
import { getChatClosureSummary, getSettingsScreen } from '../../lib/api/chat-settings-client';
import {
  getApiErrorStatus,
  isTerminalApiClientError,
  shouldRetryTransientApiError,
} from '../../lib/api-retry';
import { getNavigationAllowlistRefreshInterval } from './settings-link-allowlist';

const NIGHT_REFRESH_FALLBACK_MS = 5 * 60_000;

export function getNightStatusRefreshDelay(
  nextTransitionAt: string | null | undefined,
  observedAt: number,
) {
  const boundary = nextTransitionAt ? Date.parse(nextTransitionAt) : NaN;
  const delay = boundary - observedAt;
  return Number.isFinite(delay) && delay > 0
    ? Math.min(NIGHT_REFRESH_FALLBACK_MS, Math.max(1_000, delay + 250))
    : NIGHT_REFRESH_FALLBACK_MS;
}

export const chatClosureQueryKey = (chatId: string | undefined, principal?: string | null) =>
  ['chat-closure-status', chatId, principal ?? null] as const;

export function useChatClosureSummary({
  api,
  chatId,
  principal,
  enabled,
}: {
  api: ApiTransport;
  chatId: string | undefined;
  principal?: string | null;
  enabled: boolean;
}) {
  const query = useQuery({
    queryKey: chatClosureQueryKey(chatId, principal),
    enabled: Boolean(chatId && enabled),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<ChatClosureSummary | ChatClosureStatus | null> => {
      try {
        return await getChatClosureSummary(api, chatId!, signal);
      } catch (error) {
        // FLAG: A newer mini app can open against a previous API image during rollback.
        // Only an absent endpoint permits the existing admin-protected full-screen read.
        if (getApiErrorStatus(error) !== 404) throw error;
        return (await getSettingsScreen(api, chatId!, { signal })).closure ?? null;
      }
    },
  });
  const terminal = isTerminalApiClientError(query.error);
  const lastRequested = useRef(-Infinity);
  const refetch = query.refetch;
  const observed = query.data?.observedAt;
  const boundary = query.data?.nextTransitionAt;
  useEffect(() => {
    if (!chatId || !enabled || terminal) return;
    const refresh = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastRequested.current < 750) return;
      lastRequested.current = Date.now();
      void refetch({ cancelRefetch: false, throwOnError: false });
    };
    // FLAG: Use the saved server clock and the client's elapsed time since receipt. A phone
    // clock in a different timezone or with significant skew cannot move the saved boundary.
    const timer = setTimeout(
      refresh,
      getNightStatusRefreshDelay(boundary, Date.parse(observed ?? '')),
    );
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [
    chatId,
    principal,
    enabled,
    terminal,
    boundary,
    observed,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    refetch,
  ]);
  return query;
}

export function useSettingsScreenQuery({
  api,
  chatId,
  handoffRequested = false,
  expandedSections,
}: {
  api: ApiTransport;
  chatId: string | undefined;
  handoffRequested?: boolean;
  expandedSections: Record<'links' | 'duplicates' | 'night', boolean>;
}) {
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: ({ signal }) =>
      getSettingsScreen(api, chatId ?? '', { signal, prefetch: handoffRequested }),
    enabled: Boolean(chatId),
    refetchOnMount: 'always',
    refetchOnWindowFocus: expandedSections.links,
    refetchInterval: (current) => {
      const expiry = expandedSections.links
        ? getNavigationAllowlistRefreshInterval(current.state.data?.domains)
        : false;
      return expandedSections.duplicates ? Math.min(60_000, expiry || Infinity) : expiry;
    },
    ...(handoffRequested
      ? {
          retry: (failureCount: number, error: unknown) =>
            shouldRetryTransientApiError(failureCount, error, 7),
          retryDelay: (failureCount: number) => Math.min(800 + failureCount * 400, 2600),
        }
      : {}),
  });
  return query;
}
