import type { ReactNode } from 'react';
import { RefreshNotice } from '../../components/ui/refresh-notice';
import { StatusState } from '../../components/ui/status-state';
import { describeUserFacingError } from '../../lib/user-facing-error';
import type { usePublicationList } from './use-publication-list';

type FeedQuery = Pick<
  ReturnType<typeof usePublicationList>['currentListQuery'],
  | 'isLoading'
  | 'isError'
  | 'isRefetchError'
  | 'isFetchNextPageError'
  | 'isFetching'
  | 'error'
  | 'data'
  | 'refetch'
>;

export function PublicationFeedFeedback({
  query,
  children,
}: {
  query: FeedQuery;
  children: ReactNode;
}) {
  if (query.isLoading) return <StatusState tone="neutral" title="Загружаю публикации" />;
  if (query.isError && !query.data)
    return (
      <StatusState
        tone="danger"
        title="Не удалось загрузить"
        description={describeUserFacingError(query.error, 'Повторите ещё раз.')}
        action={
          <button
            type="button"
            className="button button--ghost"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Обновить
          </button>
        }
      />
    );
  return (
    <>
      {query.isRefetchError && !query.isFetchNextPageError ? (
        <RefreshNotice pending={query.isFetching} onRetry={() => void query.refetch()}>
          Не удалось обновить публикации. Показаны последние данные.
        </RefreshNotice>
      ) : null}
      {children}
    </>
  );
}
