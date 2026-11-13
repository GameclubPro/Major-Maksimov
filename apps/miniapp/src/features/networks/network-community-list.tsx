import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkEntry,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from '../../lib/api/transport';
import { getManagedEntityNetworkEntries } from '../../lib/api/managed-entity-networks-client';
import { EntityAvatar } from '../../components/ui/entity-avatar';
import { Spinner } from '../../components/ui/spinner';
import { ApiRequestError } from '../../lib/api-request-error';
import type { NetworkRecipientSelection } from './network-route-state';

export type NetworkEntriesState = {
  items: ManagedEntityNetworkEntry[];
  version: string | null;
  nextCursor: string | null;
  pageCount: number;
  loading: boolean;
  error: string | null;
  accessDenied: boolean;
};
export const NETWORK_ENTITY_SEARCH_MAX_LENGTH = 100;
const empty = (): NetworkEntriesState => ({
  items: [],
  version: null,
  nextCursor: null,
  pageCount: 0,
  loading: true,
  error: null,
  accessDenied: false,
});
class NetworkListReadError extends Error {}

export function useNetworkEntries({
  api,
  scopeKey,
  entityType,
  favoriteType,
  search = '',
  compositionEpoch,
  initialPageCount = 1,
  enabled = true,
}: {
  api: ApiTransport;
  scopeKey: string;
  entityType: ManagedEntityType;
  favoriteType?: ManagedEntityFavoriteType;
  search?: string;
  compositionEpoch: number;
  initialPageCount?: number;
  enabled?: boolean;
}) {
  const identity = JSON.stringify([
    scopeKey,
    entityType,
    favoriteType ?? null,
    search,
    compositionEpoch,
  ]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ identity: string; value: NetworkEntriesState }>(() => ({
    identity,
    value: empty(),
  }));
  const active = useRef<{
    identity: string;
    controller: AbortController;
    value: NetworkEntriesState;
    cursors: Set<string>;
    pending: boolean;
  } | null>(null);
  const load = useCallback(
    async (session: NonNullable<typeof active.current>) => {
      if (session.pending || session.controller.signal.aborted) return false;
      session.pending = true;
      session.value = { ...session.value, loading: true, error: null };
      setState({ identity: session.identity, value: session.value });
      try {
        const page = await getManagedEntityNetworkEntries(api, entityType, {
          favoriteType,
          search,
          cursor: session.value.nextCursor ?? undefined,
          limit: 50,
          signal: session.controller.signal,
        });
        if (active.current !== session || session.controller.signal.aborted) return false;
        if (
          page.entityType !== entityType ||
          (session.value.version && page.compositionVersion !== session.value.version)
        )
          throw new NetworkListReadError('Состав изменился. Обновите список.');
        const ids = new Set(session.value.items.map((item) => item.id));
        for (const item of page.items) {
          if (
            item.entityType !== entityType ||
            (favoriteType && item.favoriteType !== favoriteType) ||
            ids.has(item.id)
          )
            throw new NetworkListReadError('Список изменился. Обновите его целиком.');
          ids.add(item.id);
        }
        if (page.nextCursor && session.cursors.has(page.nextCursor))
          throw new NetworkListReadError('Не удалось загрузить продолжение списка.');
        if (page.nextCursor) session.cursors.add(page.nextCursor);
        session.value = {
          items: [...session.value.items, ...page.items],
          version: page.compositionVersion,
          nextCursor: page.nextCursor,
          pageCount: session.value.pageCount + 1,
          loading: false,
          error: null,
          accessDenied: false,
        };
        setState({ identity: session.identity, value: session.value });
        return true;
      } catch (error) {
        if (active.current !== session || session.controller.signal.aborted) return false;
        const status = error instanceof ApiRequestError ? error.status : null;
        const accessDenied = status === 401 || status === 403;
        const invalidated = accessDenied || status === 409 || error instanceof NetworkListReadError;
        const message =
          status === 401
            ? 'Сессия истекла. Откройте приложение заново.'
            : status === 403
              ? 'Доступ к сообществам изменился. Обновите список.'
              : status === 409
                ? 'Состав изменился. Обновите список.'
                : error instanceof ApiRequestError
                  ? 'Не удалось загрузить сообщества. Попробуйте ещё раз.'
                  : error instanceof NetworkListReadError
                    ? error.message
                    : 'Не удалось загрузить сообщества.';
        // FLAG: A denied or invalidated page cannot leave old recipients available for selection.
        session.value = {
          ...(invalidated ? empty() : session.value),
          loading: false,
          error: message,
          accessDenied,
        };
        setState({ identity: session.identity, value: session.value });
        return false;
      } finally {
        session.pending = false;
      }
    },
    [api, entityType, favoriteType, search],
  );
  useEffect(() => {
    if (!enabled) return;
    const session = {
      identity,
      controller: new AbortController(),
      value: empty(),
      cursors: new Set<string>(),
      pending: false,
    };
    active.current = session;
    setState({ identity, value: session.value });
    void (async () => {
      for (let index = 0; index < initialPageCount; index += 1) {
        if (!(await load(session)) || !session.value.nextCursor) break;
      }
    })();
    return () => {
      session.controller.abort();
      if (active.current === session) active.current = null;
    };
  }, [identity, initialPageCount, load, retry, enabled]);
  const value = state.identity === identity ? state.value : empty();
  return {
    ...value,
    loadMore: () => {
      if (active.current?.value.nextCursor) void load(active.current);
    },
    refresh: () => setRetry((value) => value + 1),
  };
}

export function NetworkCommunityList({
  entries,
  selection,
  onToggle,
}: {
  entries: ReturnType<typeof useNetworkEntries>;
  selection: NetworkRecipientSelection;
  onToggle: (id: string) => void;
}) {
  const selected = new Set(selection.mode === 'selected' ? selection.entityIds : []);
  return (
    <div className="network-community-list" aria-busy={entries.loading}>
      {entries.items.map((item) => (
        <label className="network-community-row" key={item.id} data-network-entity-id={item.id}>
          <input
            type="checkbox"
            aria-label={`Выбрать ${item.title}`}
            checked={selection.mode === 'category' || selected.has(item.id)}
            disabled={
              selection.mode === 'category' || (selected.size >= 500 && !selected.has(item.id))
            }
            onChange={() => onToggle(item.id)}
          />
          <EntityAvatar
            title={item.title}
            entityId={item.id}
            entityType={item.entityType}
            avatarUrl={item.avatarUrl}
          />
          <span className="network-community-row__text">
            <strong>{item.title}</strong>
            <small>{item.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
          </span>
        </label>
      ))}
      {!entries.loading && !entries.error && entries.items.length === 0 ? (
        <div className="networks-empty">
          <strong>В этой сетке пока пусто</strong>
          <p>Добавьте сообщества через «Изменить состав».</p>
        </div>
      ) : null}
      {entries.loading ? (
        <div className="networks-loading" role="status">
          <Spinner />
          <span>Загружаем сообщества…</span>
        </div>
      ) : null}
      {entries.error ? (
        <div className="networks-notice" role="alert">
          <p>{entries.error}</p>
          <button type="button" onClick={entries.refresh}>
            Обновить список
          </button>
        </div>
      ) : null}
      {entries.nextCursor && !entries.loading && !entries.error ? (
        <button type="button" className="networks-more" onClick={entries.loadMore}>
          Показать ещё
        </button>
      ) : null}
    </div>
  );
}
