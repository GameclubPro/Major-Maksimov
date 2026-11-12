import { type PublisherEntitiesSummary, type PublisherEntity } from '@maxim/contracts/publisher';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isInvalidPublisherEntitiesCursorError,
  listPublisherEntities,
  refreshPublisherEntities,
  runOrResumePublisherRefresh,
} from '../../lib/api/publisher-client';
import type { ApiTransport } from '../../lib/api/transport';
import { type PublicationEntityFilter, type PublicationTarget } from './publication-model';

const PUBLISHER_TARGET_PAGE_SIZE = 30;

export { isInvalidPublisherEntitiesCursorError };

export function publisherEntityToPublicationTarget(source: PublisherEntity): PublicationTarget {
  return {
    id: source.id,
    entityType: source.entityType,
    title: source.title.trim() || (source.entityType === 'channel' ? 'Канал' : 'Чат'),
    avatarUrl: source.avatarUrl,
    channelOverview: null,
    publisherChatCommentsEnabled:
      source.entityType === 'chat' &&
      source.moduleSettings.chatComments?.commentsEnabled === true &&
      source.moduleSettings.chatComments.commentsChatBroadcastsEnabled === true,
    publisherChannelCommentsEnabled:
      source.entityType === 'channel' &&
      source.moduleSettings.channelCommentsEnabled === true &&
      source.readiness.canUseChannelComments === true,
    publisherChannelSuggestionsEnabled:
      source.entityType === 'channel' && source.moduleSettings.channelSuggestionsEnabled === true,
    publisherChannelPostSignature:
      source.entityType === 'channel' ? (source.channelPostSignature ?? null) : null,
    readiness: source.readiness,
  };
}

export function usePublicationTargetSources(api: ApiTransport, enabled: boolean) {
  const queryClient = useQueryClient();
  const [publisherInputQuery, setPublisherInputQuery] = useState('');
  const [publisherQuery, setPublisherQuery] = useState('');
  const [publisherEntityFilter, setPublisherEntityFilter] =
    useState<PublicationEntityFilter>('all');
  const [publisherRechecking, setPublisherRechecking] = useState(false);
  const refreshAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    setPublisherRechecking(false);
    return () => {
      refreshAbort.current?.abort();
      refreshAbort.current = null;
    };
  }, [api, enabled]);
  const publisherSearchSettling = publisherInputQuery.trim() !== publisherQuery;
  const publisherEntityType = publisherEntityFilter === 'all' ? undefined : publisherEntityFilter;
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setPublisherQuery(publisherInputQuery.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [publisherInputQuery]);
  const publisherQueryKey = [
    'publications',
    'sources',
    'publisher',
    'cursor',
    { query: publisherQuery, entityType: publisherEntityType ?? null, readiness: null },
  ] as const;
  const publisher = useInfiniteQuery({
    queryKey: publisherQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listPublisherEntities(api, {
        pagination: 'cursor',
        limit: PUBLISHER_TARGET_PAGE_SIZE,
        query: publisherQuery,
        entityType: publisherEntityType,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const targets = useMemo(
    () =>
      enabled
        ? (publisher.data?.pages ?? [])
            .flatMap((page) => page.items)
            .map(publisherEntityToPublicationTarget)
        : [],
    [enabled, publisher.data?.pages],
  );
  const publisherSummary: PublisherEntitiesSummary | null =
    publisher.data?.pages[0]?.summary ?? null;
  const publisherHasData = publisher.data !== undefined;
  const publisherInitialError = publisher.isError && !publisherHasData;

  return {
    targets,
    publisherInputQuery,
    publisherEntityFilter,
    publisherSearchSettling,
    setPublisherInputQuery,
    setPublisherEntityFilter,
    publisherSummary,
    filteredTotal: publisher.data?.pages[0]?.filteredTotal ?? null,
    hasNextPage: enabled && Boolean(publisher.hasNextPage),
    fetchingNextPage: enabled && publisher.isFetchingNextPage,
    fetchNextPageError: enabled && publisher.isFetchNextPageError,
    fetchNextPage: async () => {
      const result = await publisher.fetchNextPage();
      if (result.isError && isInvalidPublisherEntitiesCursorError(result.error)) {
        await queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true });
      }
    },
    loading: enabled && publisher.isLoading,
    fetching: enabled && (publisher.isFetching || publisherRechecking),
    rechecking: enabled && publisherRechecking,
    hasError: enabled && publisherInitialError,
    refreshError: enabled && publisher.isRefetchError && !publisher.isFetchNextPageError,
    retryRead: () => publisher.refetch(),
    unavailable: enabled && publisherInitialError,
    ready: enabled && (publisher.isSuccess || publisherHasData),
    chatsFailed: false,
    refetch: () =>
      enabled
        ? queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true })
        : Promise.resolve(),
    recheck: async () => {
      if (!enabled || publisherRechecking) {
        return;
      }
      setPublisherRechecking(true);
      const controller = new AbortController();
      refreshAbort.current = controller;
      try {
        await runOrResumePublisherRefresh(
          api,
          'publication-target-catalog',
          () => refreshPublisherEntities(api),
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        try {
          if (!controller.signal.aborted) {
            await Promise.all([
              queryClient.resetQueries({ queryKey: publisherQueryKey, exact: true }),
              queryClient.invalidateQueries({ queryKey: ['publisher', 'entity'] }),
              queryClient.invalidateQueries({ queryKey: ['publications', 'list'] }),
              queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
            ]);
          }
        } finally {
          if (refreshAbort.current === controller) {
            refreshAbort.current = null;
            setPublisherRechecking(false);
          }
        }
      }
    },
  };
}
