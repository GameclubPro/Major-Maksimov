import type { ManagedEntityFavoriteLabelsResponse } from '@maxim/contracts';
import { ApiRequestError } from './api-request-error';
import { getManagedEntityFavoriteLabels } from './api/managed-entity-favorites-client';
import { updateManagedEntityFavoriteLabels } from './api/managed-entity-favorites-write-client';
import type { ApiTransport } from './api/transport';
import {
  FavoriteLabelConflictError,
  FavoriteLabelDuplicateError,
} from './home-entity-favorites-types';
import {
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  type HomeEntityFavoriteLabelOverrides,
} from './home-entity-favorites';

export function mergeHomeEntityFavoriteLabelEdits(
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  latestServerLabels: HomeEntityFavoriteLabelOverrides,
): HomeEntityFavoriteLabelOverrides {
  const base = resolveHomeEntityFavoriteLabels(sanitizeHomeEntityFavoriteLabels(baseLabels));
  const draft = resolveHomeEntityFavoriteLabels(sanitizeHomeEntityFavoriteLabels(draftLabels));
  const next = sanitizeHomeEntityFavoriteLabels(latestServerLabels);
  const latest = resolveHomeEntityFavoriteLabels(next);

  for (const favoriteType of HOME_ENTITY_FAVORITE_TYPES) {
    if (draft[favoriteType] === base[favoriteType]) {
      continue;
    }
    if (
      latest[favoriteType] !== base[favoriteType] &&
      latest[favoriteType] !== draft[favoriteType]
    ) {
      throw new FavoriteLabelConflictError(next, latest[favoriteType]);
    }
    if (draft[favoriteType] === HOME_ENTITY_FAVORITE_LABELS[favoriteType]) {
      delete next[favoriteType];
    } else {
      next[favoriteType] = draft[favoriteType];
    }
  }

  assertUniqueChangedLabels(latest, resolveHomeEntityFavoriteLabels(next));
  return sanitizeHomeEntityFavoriteLabels(next);
}

function assertUniqueChangedLabels(
  previous: ReturnType<typeof resolveHomeEntityFavoriteLabels>,
  next: ReturnType<typeof resolveHomeEntityFavoriteLabels>,
) {
  const key = (label: string) =>
    label.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
  for (const type of HOME_ENTITY_FAVORITE_TYPES) {
    if (previous[type] === next[type]) continue;
    if (
      HOME_ENTITY_FAVORITE_TYPES.some(
        (other) => other !== type && key(next[other]) === key(next[type]),
      )
    ) {
      throw new FavoriteLabelDuplicateError(next[type]);
    }
  }
}

export function isHomeEntityFavoriteLabelsRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 409 &&
    error.code === 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT'
  );
}

export async function saveHomeEntityFavoriteLabelEditsWithConflictRetry(
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  loadLatest: () => Promise<ManagedEntityFavoriteLabelsResponse>,
  replace: (
    labels: HomeEntityFavoriteLabelOverrides,
    expectedRevision: number | null,
  ) => Promise<ManagedEntityFavoriteLabelsResponse>,
): Promise<ManagedEntityFavoriteLabelsResponse> {
  let latest = await loadLatest();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const labels = latest.initialized
      ? mergeHomeEntityFavoriteLabelEdits(baseLabels, draftLabels, latest.labels)
      : sanitizeHomeEntityFavoriteLabels(draftLabels);
    if (!latest.initialized) {
      assertUniqueChangedLabels(
        resolveHomeEntityFavoriteLabels(baseLabels),
        resolveHomeEntityFavoriteLabels(labels),
      );
    }
    try {
      return await replace(labels, latest.revision);
    } catch (error: unknown) {
      if (attempt !== 0 || !isHomeEntityFavoriteLabelsRevisionConflict(error)) {
        throw error;
      }
      latest = await loadLatest();
    }
  }

  throw new Error('Не удалось согласовать актуальные названия категорий.');
}

export function initializeManagedEntityFavoriteLabels(
  api: ApiTransport,
  labels: HomeEntityFavoriteLabelOverrides,
  signal?: AbortSignal,
) {
  return updateManagedEntityFavoriteLabels(api, labels, { mode: 'initialize', signal });
}

export function saveManagedEntityFavoriteLabelEdits(
  api: ApiTransport,
  baseLabels: HomeEntityFavoriteLabelOverrides,
  draftLabels: HomeEntityFavoriteLabelOverrides,
  signal?: AbortSignal,
) {
  return saveHomeEntityFavoriteLabelEditsWithConflictRetry(
    baseLabels,
    draftLabels,
    () => getManagedEntityFavoriteLabels(api, { signal }),
    (labels, expectedRevision) =>
      updateManagedEntityFavoriteLabels(api, labels, { expectedRevision, signal }),
  );
}
