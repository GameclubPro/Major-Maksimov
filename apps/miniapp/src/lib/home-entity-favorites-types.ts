import type {
  ChatSummary,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityFavoriteType,
  ManagedEntityFavoritesResponse,
  ManagedEntityNetworkCompositionChange,
  ManagedEntityNetworkCompositionResponse,
  ManagedEntityNetworksResponse,
  ManagedEntityType,
} from '@maxim/contracts';
import type {
  HomeEntityFavoriteLabelOverrides,
  HomeEntityFavorites,
} from './home-entity-favorites';

export type ManagedEntityNetworkKey = {
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
};
export type HomeEntityFavoritesLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type HomeEntityFavoriteWriteResult<T> = {
  response: T;
  refresh: 'complete' | 'pending' | 'on-return';
};
export type HomeEntityFavoritesTypeSnapshot = {
  compositionEpoch: number;
  typeCompositionVersion: string | null;
  assignmentsComplete: boolean;
  hasAcknowledgedRowEdits: boolean;
  catalogue: ManagedEntityNetworksResponse | null;
  catalogueStale: boolean;
  status: HomeEntityFavoritesLoadStatus;
  error: unknown | null;
};
export type HomeEntityFavoritesSnapshot = {
  actor: { userId: string; scope: string };
  assignments: HomeEntityFavorites;
  labels: {
    overrides: HomeEntityFavoriteLabelOverrides;
    resolved: Record<ManagedEntityFavoriteType, string>;
    revision: number | null;
    labelsEpoch: number;
    serverConfirmed: boolean;
    status: HomeEntityFavoritesLoadStatus;
    error: unknown | null;
  };
  byType: Record<ManagedEntityType, HomeEntityFavoritesTypeSnapshot>;
};
export type HomeEntityFavoritesActions = {
  refreshCatalogue(type: ManagedEntityType, signal?: AbortSignal): Promise<void>;
  refreshAssignments(type: ManagedEntityType, signal?: AbortSignal): Promise<void>;
  refreshLabels(signal?: AbortSignal): Promise<void>;
  reconcileLoadedEntities(entities: {
    chats?: readonly ChatSummary[];
    channels?: readonly ChatSummary[];
  }): void;
  setFavorite(
    change: ManagedEntityNetworkCompositionChange & { entityType: ManagedEntityType },
    refresh?: 'immediate' | 'on-return',
  ): Promise<HomeEntityFavoriteWriteResult<ManagedEntityFavoritesResponse>>;
  commitComposition(input: {
    entityType: ManagedEntityType;
    changes: readonly ManagedEntityNetworkCompositionChange[];
  }): Promise<HomeEntityFavoriteWriteResult<ManagedEntityNetworkCompositionResponse>>;
  saveLabels(input: {
    baseLabels: HomeEntityFavoriteLabelOverrides;
    draftLabels: HomeEntityFavoriteLabelOverrides;
  }): Promise<ManagedEntityFavoriteLabelsResponse>;
};
export class FavoriteLabelConflictError extends Error {
  constructor(
    readonly latestLabels: HomeEntityFavoriteLabelOverrides,
    readonly currentLabel: string,
  ) {
    super(`Название уже изменилось на «${currentLabel}».`);
  }
}

export class FavoriteLabelDuplicateError extends Error {
  constructor(readonly label: string) {
    super(`Название «${label}» уже занято.`);
  }
}
