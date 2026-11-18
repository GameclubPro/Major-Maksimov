import type { QueryClient } from '@tanstack/react-query';
import type { ApiTransport } from '../lib/api/transport';
import type { ManagedEntityStatsPreference } from '../lib/managed-entity-workspace';
import { channelStatsQueryKey, logsDashboardQueryKey } from '../lib/query-key-builders';
const DEFAULT_DASHBOARD_RANGE = '24h';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
export function prefetchChatEvents(
  api: ApiTransport,
  queryClient: QueryClient,
  chatId: string,
  preference: ManagedEntityStatsPreference,
) {
  if (preference.section === 'participants') {
    return;
  }

  const range = preference.range ?? DEFAULT_DASHBOARD_RANGE;
  const includeModerationPreview = preference.section === 'moderation';
  const includeActivityPreview = !includeModerationPreview;
  void queryClient
    .prefetchQuery({
      queryKey: logsDashboardQueryKey(
        chatId,
        range,
        includeActivityPreview,
        includeModerationPreview,
      ),
      queryFn: async ({ signal }) => {
        const client = await import('../lib/api/events-client');
        return includeModerationPreview
          ? client.getChatModerationDashboard(api, chatId, range, { signal })
          : client.getChatActivityDashboard(api, chatId, range, { signal });
      },
    })
    .catch(() => undefined);
}

export function prefetchChannelStats(
  api: ApiTransport,
  queryClient: QueryClient,
  chatId: string,
  preference: ManagedEntityStatsPreference,
) {
  const range = preference.range ?? DEFAULT_CHANNEL_STATS_RANGE;
  void queryClient
    .prefetchQuery({
      queryKey: channelStatsQueryKey(chatId, range, 'overview'),
      queryFn: async ({ signal }) => {
        const { getChannelStats } = await import('../lib/api/channel-stats-client');
        return getChannelStats(
          api,
          chatId,
          range,
          { signal },
          {
            includeActivityPreview: false,
            mode: 'overview',
          },
        );
      },
    })
    .catch(() => undefined);
}
