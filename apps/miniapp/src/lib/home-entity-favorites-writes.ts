import type { ManagedEntityNetworkCompositionChange, ManagedEntityType } from '@maxim/contracts';
import { updateManagedEntityFavorites } from './api/managed-entity-favorites-write-client';
import { updateManagedEntityNetworkComposition } from './api/managed-entity-network-composition-write-client';
import type { ApiTransport } from './api/transport';
import { saveHomeEntityFavorites, setHomeEntityFavoriteTypes } from './home-entity-favorites';
import type {
  HomeEntityFavoritesActions,
  HomeEntityFavoritesSnapshot,
} from './home-entity-favorites-types';

export interface HomeEntityFavoritesWriteContext {
  api: ApiTransport;
  signal: AbortSignal;
  getSnapshot(): HomeEntityFavoritesSnapshot;
  assertActive(): void;
  acceptWrite(type: ManagedEntityType): void;
  publish(next: HomeEntityFavoritesSnapshot): void;
  refresh(type: ManagedEntityType): Promise<'complete' | 'pending'>;
}

function acknowledge(
  context: HomeEntityFavoritesWriteContext,
  type: ManagedEntityType,
  changes: readonly ManagedEntityNetworkCompositionChange[],
  hasAcknowledgedRowEdits = false,
) {
  context.acceptWrite(type);
  let assignments = context.getSnapshot().assignments;
  for (const change of changes)
    assignments = setHomeEntityFavoriteTypes(
      assignments,
      type,
      change.entityId,
      change.favoriteType ? [change.favoriteType] : [],
    );
  saveHomeEntityFavorites(context.getSnapshot().actor.scope, assignments);
  const current = context.getSnapshot();
  context.publish({
    ...current,
    assignments,
    byType: {
      ...current.byType,
      [type]: {
        ...current.byType[type],
        compositionEpoch: current.byType[type].compositionEpoch + 1,
        assignmentsComplete: false,
        hasAcknowledgedRowEdits,
        catalogueStale: true,
        error: null,
      },
    },
  });
}

export async function setHomeEntityFavorite(
  context: HomeEntityFavoritesWriteContext,
  change: Parameters<HomeEntityFavoritesActions['setFavorite']>[0],
  refresh: 'immediate' | 'on-return',
) {
  const type = change.entityType;
  const response = await updateManagedEntityFavorites(
    context.api,
    type,
    change.entityId,
    change.favoriteType ? [change.favoriteType] : [],
    change.expectedFavoriteType,
    { signal: context.signal },
  );
  context.assertActive();
  if (
    response.entityType !== type ||
    response.entityId !== change.entityId ||
    response.favoriteTypes.length > 1 ||
    (response.favoriteTypes[0] ?? null) !== change.favoriteType
  )
    throw new Error('Неверный ответ сохранения.');
  // Only the acknowledged row is current until the network catalogue is read again.
  acknowledge(context, type, [change], refresh === 'on-return');
  return { response, refresh: refresh === 'on-return' ? refresh : await context.refresh(type) };
}

export async function commitHomeEntityNetworkComposition(
  context: HomeEntityFavoritesWriteContext,
  type: ManagedEntityType,
  changes: readonly ManagedEntityNetworkCompositionChange[],
) {
  const response = await updateManagedEntityNetworkComposition(
    context.api,
    type,
    [...changes],
    context.signal,
  );
  context.assertActive();
  if (response.entityType !== type) throw new Error('Неверный ответ сохранения.');
  acknowledge(context, type, response.changes);
  return { response, refresh: await context.refresh(type) };
}
