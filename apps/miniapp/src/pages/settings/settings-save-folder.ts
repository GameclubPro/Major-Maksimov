import type { ManagedEntityFavoriteType } from '@maxim/contracts/managed-entities';
import {
  HOME_ENTITY_FAVORITE_TYPES,
  type HomeEntityFavorites,
} from '../../lib/home-entity-favorites';
import { readManagedEntityWorkspaceState } from '../../lib/managed-entity-workspace';

export function resolveSettingsSaveFavoriteType(
  chatId: string,
  routeState: unknown,
  favorites: HomeEntityFavorites,
): ManagedEntityFavoriteType | null {
  const types = HOME_ENTITY_FAVORITE_TYPES.filter((type) => favorites.chat[type].includes(chatId));
  const workspace = readManagedEntityWorkspaceState(routeState);
  const filter =
    workspace?.entityType === 'chat' && workspace.entityId === chatId
      ? workspace.homeSnapshot?.filter
      : null;
  if (filter && filter !== 'all') return types.includes(filter) ? filter : null;
  return types.length === 1 ? types[0]! : null;
}
