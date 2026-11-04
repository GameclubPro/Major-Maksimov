import type { ModerationFeedFilter } from '@maxim/contracts';

export type StatisticsRouteRange = '24h' | '7d' | '30d';
export type ChannelStatisticsSection = 'overview' | 'events';
export type ChatStatisticsSection = 'activity' | 'moderation' | 'participants';

export type ChannelStatisticsRouteQuery = {
  section: ChannelStatisticsSection;
  range: StatisticsRouteRange;
};

export type ChatStatisticsRouteQuery = {
  section: ChatStatisticsSection;
  range: StatisticsRouteRange;
};

type StatisticsRouteQuery = ChannelStatisticsRouteQuery | ChatStatisticsRouteQuery;

function parseRange(value: string | null, fallback: StatisticsRouteRange): StatisticsRouteRange {
  return value === '24h' || value === '7d' || value === '30d' ? value : fallback;
}

export function parseChannelStatisticsRouteQuery(search: string): ChannelStatisticsRouteQuery {
  const params = new URLSearchParams(search);

  return {
    section: params.get('section') === 'events' ? 'events' : 'overview',
    range: parseRange(params.get('range'), '7d'),
  };
}

export function parseChatStatisticsRouteQuery(search: string): ChatStatisticsRouteQuery {
  const params = new URLSearchParams(search);
  const section = params.get('section');

  return {
    section:
      section === 'events' || section === 'activity'
        ? 'activity'
        : section === 'participants'
          ? 'participants'
          : 'moderation',
    range: parseRange(params.get('range'), '24h'),
  };
}

export function buildStatisticsRouteSearch(
  currentSearch: string,
  query: StatisticsRouteQuery,
): string {
  const params = new URLSearchParams(currentSearch);
  params.set('section', query.section);
  params.set('range', query.range);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function readModerationRouteFilter(search: string): ModerationFeedFilter {
  const value = new URLSearchParams(search).get('filter');
  return value === 'COMMERCIAL' ||
    value === 'WARN' ||
    value === 'DELETE_MESSAGE' ||
    value === 'MUTE' ||
    value === 'BAN' ||
    value === 'UNMUTE' ||
    value === 'UNBAN'
    ? value
    : 'ALL';
}
