import {
  managedEntityFavoriteTypeSchema,
  managedEntityNetworkEntriesQuerySchema,
  updateManagedEntityNetworkCompositionRequestSchema,
  updateManagedEntityFavoritesRequestSchema,
} from '@maxim/contracts/managed-entities';
import { HOME_ENTITY_FAVORITE_LABELS, HOME_ENTITY_FAVORITE_TYPES } from '../home-entity-favorites';
import { ApiRequestError } from '../api-request-error';
import { PREVIEW_NOT_HANDLED, type PreviewRequestContext } from './preview-transport-runtime';
import {
  getPreviewNetworkEntities,
  getPreviewNetworkVersion,
} from './preview-transport-network-state';

function conflict(code = 'MANAGED_ENTITY_NETWORK_COMPOSITION_CHANGED'): never {
  throw new ApiRequestError(
    409,
    JSON.stringify({ code }),
    'Состав уже изменился. Обновите данные.',
  );
}
function body(context: PreviewRequestContext): unknown {
  return JSON.parse(String(context.init.body ?? '{}'));
}

export async function handleNetworksPreviewRequest(context: PreviewRequestContext) {
  const { state, method, segments, url } = context;
  if (segments[0] === 'networks') {
    const { handleNetworkSettingsPreviewRequest } =
      await import('./preview-transport-network-settings');
    return handleNetworkSettingsPreviewRequest(context);
  }
  if (segments[0] !== 'managed-entities') return PREVIEW_NOT_HANDLED;
  if (segments[1] !== 'networks') {
    if (
      segments[3] !== 'favorites' ||
      method !== 'PUT' ||
      (segments[1] !== 'chat' && segments[1] !== 'channel')
    )
      return PREVIEW_NOT_HANDLED;
    const type = segments[1];
    const payload = updateManagedEntityFavoritesRequestSchema.parse(body(context));
    const row = getPreviewNetworkEntities(state, type).find(
      (item) => item.id === decodeURIComponent(segments[2] ?? ''),
    );
    if (!row) throw new ApiRequestError(404, '{}', 'Сообщество не найдено.');
    const actual = row.favoriteTypes?.[0] ?? null;
    const desired = payload.favoriteTypes[0] ?? null;
    if (actual !== payload.expectedFavoriteType && actual !== desired)
      conflict('MANAGED_ENTITY_FAVORITE_CONFLICT');
    row.favoriteTypes = desired ? [desired] : [];
    return { entityType: type, entityId: row.id, favoriteTypes: row.favoriteTypes };
  }
  const type = segments[2];
  if (type !== 'chat' && type !== 'channel') return PREVIEW_NOT_HANDLED;
  const rows = getPreviewNetworkEntities(state, type);
  if (segments.length === 3 && method === 'GET')
    return {
      entityType: type,
      compositionVersion: getPreviewNetworkVersion(state, type),
      labelsRevision: state.favoriteLabelsRevision,
      items: HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => ({
        favoriteType,
        label: state.favoriteLabels[favoriteType] ?? HOME_ENTITY_FAVORITE_LABELS[favoriteType],
        entityCount: rows.filter((row) => row.favoriteTypes?.[0] === favoriteType).length,
        compositionVersion: getPreviewNetworkVersion(state, type, favoriteType),
      })),
    };
  if (segments[3] === 'entities' && method === 'GET') {
    const query = managedEntityNetworkEntriesQuerySchema.parse(
      Object.fromEntries(url.searchParams),
    );
    const version = getPreviewNetworkVersion(state, type, query.favoriteType);
    let offset = 0;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(atob(query.cursor)) as {
          version: string;
          type: string;
          offset: number;
          favoriteType?: string;
          favoritesOnly: boolean;
          search: string;
        };
        if (
          cursor.version !== version ||
          cursor.type !== type ||
          cursor.favoriteType !== query.favoriteType ||
          cursor.favoritesOnly !== query.favoritesOnly ||
          cursor.search !== query.search ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          conflict();
        offset = cursor.offset;
      } catch {
        conflict();
      }
    }
    const filtered = rows
      .filter(
        (row) =>
          (!query.favoriteType || row.favoriteTypes?.[0] === query.favoriteType) &&
          (!query.favoritesOnly || Boolean(row.favoriteTypes?.length)) &&
          (!query.search ||
            row.title
              .toLocaleLowerCase('ru-RU')
              .includes(query.search.toLocaleLowerCase('ru-RU')) ||
            row.id.includes(query.search)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const next = offset + query.limit;
    return {
      entityType: type,
      compositionVersion: version,
      items: filtered.slice(offset, next).map((row) => ({
        id: row.id,
        entityType: type,
        title: row.title,
        avatarUrl: row.avatarUrl ?? null,
        favoriteType: row.favoriteTypes?.[0] ?? null,
      })),
      nextCursor:
        next < filtered.length
          ? btoa(
              JSON.stringify({
                type,
                version,
                offset: next,
                favoriteType: query.favoriteType,
                favoritesOnly: query.favoritesOnly,
                search: query.search,
              }),
            )
          : null,
    };
  }
  if (segments[3] === 'composition' && method === 'PUT') {
    const payload = updateManagedEntityNetworkCompositionRequestSchema.parse(body(context));
    for (const change of payload.changes) {
      const row = rows.find((item) => item.id === change.entityId);
      if (!row) throw new ApiRequestError(403, '{}', 'Сообщество недоступно.');
      const actual = row.favoriteTypes?.[0] ?? null;
      if (actual !== change.expectedFavoriteType && actual !== change.favoriteType)
        conflict('MANAGED_ENTITY_FAVORITE_CONFLICT');
    }
    for (const change of payload.changes)
      rows.find((item) => item.id === change.entityId)!.favoriteTypes = change.favoriteType
        ? [change.favoriteType]
        : [];
    return { entityType: type, changes: payload.changes };
  }
  if (segments[3] === 'stats' && method === 'GET') {
    const category = managedEntityFavoriteTypeSchema.parse(url.searchParams.get('favoriteType'));
    const { handleNetworkStatisticsPreviewRequest } =
      await import('./preview-transport-network-statistics');
    return handleNetworkStatisticsPreviewRequest(context, type, category);
  }
  return PREVIEW_NOT_HANDLED;
}
