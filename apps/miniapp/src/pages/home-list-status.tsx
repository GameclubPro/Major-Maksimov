import type { ManagedEntitiesRefreshState } from '@maxim/contracts';
import { StatusState } from '../components/ui/status-state';

type HomeListStatusProps =
  | { kind: 'transient'; retryAfterSec: number | null }
  | { kind: 'error'; description: string; onRetry: () => void }
  | {
      kind: 'discovery';
      tab: 'chat' | 'channel';
      refreshState: ManagedEntitiesRefreshState | null;
      hasLoadedFromServer: boolean;
    }
  | {
      kind: 'no-results';
      tab: 'chat' | 'channel';
      hasSearchQuery: boolean;
      hasAppliedFavoriteFilter: boolean;
      onReset: () => void;
    };

function formatRefreshProgress(refreshState: ManagedEntitiesRefreshState | null): string | null {
  if (
    typeof refreshState?.processedCandidates === 'number' &&
    typeof refreshState.totalCandidates === 'number' &&
    refreshState.totalCandidates >= refreshState.processedCandidates
  ) {
    return `${refreshState.processedCandidates} из ${refreshState.totalCandidates}`;
  }
  if (typeof refreshState?.progressPercent === 'number') {
    return `${refreshState.progressPercent}%`;
  }
  return null;
}

function buildPendingSyncDescription(options: {
  tab: 'chat' | 'channel';
  refreshState: ManagedEntitiesRefreshState | null;
  hasLoadedFromServer: boolean;
}): string {
  const entityPlural = options.tab === 'chat' ? 'чаты' : 'каналы';
  const progress = formatRefreshProgress(options.refreshState);
  if (progress) {
    return `Проверено ${progress}.`;
  }
  return options.hasLoadedFromServer ? `Ищем новые ${entityPlural}.` : `Ищем ваши ${entityPlural}.`;
}

export default function HomeListStatus(props: HomeListStatusProps) {
  if (props.kind === 'transient')
    return (
      <div className="chats-route-state chats-transient-state">
        <StatusState
          tone="warning"
          title="Пока не удалось обновить список"
          description={
            props.retryAfterSec
              ? `Повторим автоматически через ${props.retryAfterSec} с.`
              : 'Повторим автоматически.'
          }
        />
      </div>
    );
  if (props.kind === 'error')
    return (
      <div className="chats-route-state">
        <StatusState
          tone="danger"
          title="Не удалось загрузить список"
          description={props.description}
          action={
            <button type="button" className="button button--danger" onClick={props.onRetry}>
              Повторить
            </button>
          }
        />
      </div>
    );
  const tabLabel = props.tab === 'chat' ? 'Чаты' : 'Каналы';
  if (props.kind === 'discovery') {
    return (
      <div className="chats-route-state">
        <StatusState
          tone="neutral"
          title={`Ищем ${tabLabel.toLowerCase()}`}
          description={buildPendingSyncDescription(props)}
        />
      </div>
    );
  }
  const noResultsResetLabel =
    props.hasSearchQuery && props.hasAppliedFavoriteFilter
      ? 'Сбросить поиск и фильтр'
      : props.hasSearchQuery
        ? 'Очистить поиск'
        : 'Сбросить фильтр';
  return (
    <div className="chats-route-state">
      <StatusState
        tone="neutral"
        title={`${tabLabel} не найдены`}
        action={
          <button type="button" className="button button--ghost" onClick={props.onReset}>
            {noResultsResetLabel}
          </button>
        }
      />
    </div>
  );
}
