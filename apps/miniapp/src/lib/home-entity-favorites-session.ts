import type {
  ChatSummary,
  ManagedEntityFavoriteLabelsResponse,
  ManagedEntityType,
} from '@maxim/contracts';
import {
  getManagedEntityNetworks,
  loadManagedEntityFavoriteAssignments,
} from './api/managed-entity-networks-client';
import { getManagedEntityFavoriteLabels } from './api/managed-entity-favorites-client';
import type { ApiTransport } from './api/transport';
import type { HomeEntityFavoritesWriteContext } from './home-entity-favorites-writes';
import {
  createEmptyHomeEntityFavoritesByType,
  readHomeEntityFavoriteLabels,
  readHomeEntityFavorites,
  reconcileHomeEntityFavoritesFromEntities,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  saveHomeEntityFavoriteLabels,
  saveHomeEntityFavorites,
} from './home-entity-favorites';
import type {
  HomeEntityFavoritesActions,
  HomeEntityFavoritesSnapshot,
  HomeEntityFavoritesTypeSnapshot,
} from './home-entity-favorites-types';

const initialType = (): HomeEntityFavoritesTypeSnapshot => ({
  compositionEpoch: 0,
  typeCompositionVersion: null,
  assignmentsComplete: false,
  hasAcknowledgedRowEdits: false,
  catalogue: null,
  catalogueStale: true,
  status: 'idle',
  error: null,
});

// FLAG: One instance belongs to one verified API/QueryClient credential boundary.
// Device cache is display-only; native composition is never imported into the server.
export class HomeEntityFavoritesSession {
  private snapshot: HomeEntityFavoritesSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly writeGeneration = { chat: 0, channel: 0 };
  private readonly readSequence = { chat: 0, channel: 0 };
  private readonly acceptedRead = { chat: 0, channel: 0 };
  private readonly assignmentRead = { chat: 0, channel: 0 };
  private readonly assignmentVersion: Record<ManagedEntityType, string | null> = {
    chat: null,
    channel: null,
  };
  private readonly awaitingWriteVersion = { chat: false, channel: false };
  private readonly writing = { chat: false, channel: false };
  private readonly protectedTypes = new Set<ManagedEntityType>();
  private readonly activeReads: Record<ManagedEntityType, Set<() => void>> = {
    chat: new Set(),
    channel: new Set(),
  };
  private labelsGeneration = 0;
  private labelsRequest = 0;
  private labelsWriting = false;

  constructor(
    private readonly api: ApiTransport,
    userId: string,
  ) {
    if (!userId.trim()) throw new Error('Verified favorites identity required');
    const scope = `u:${userId.trim()}`;
    const overrides = readHomeEntityFavoriteLabels(scope);
    this.snapshot = {
      actor: { userId: userId.trim(), scope },
      assignments: readHomeEntityFavorites(scope),
      labels: {
        overrides,
        resolved: resolveHomeEntityFavoriteLabels(overrides),
        revision: null,
        labelsEpoch: 0,
        serverConfirmed: false,
        status: 'idle',
        error: null,
      },
      byType: { chat: initialType(), channel: initialType() },
    };
  }

  getSnapshot = () => this.snapshot;
  getAssignmentReadSequence = (type: ManagedEntityType) => this.assignmentRead[type];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose() {
    this.lifetime.abort();
    this.listeners.clear();
  }
  private assertActive() {
    this.lifetime.signal.throwIfAborted();
  }
  private signal(signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const release = () => {
      this.lifetime.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
    };
    this.lifetime.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', release, { once: true });
    if (this.lifetime.signal.aborted || signal?.aborted) abort();
    return { signal: controller.signal, abort, release };
  }
  private abortTypeReads(type: ManagedEntityType) {
    for (const abort of this.activeReads[type]) abort();
    this.activeReads[type].clear();
  }
  private publish(next: HomeEntityFavoritesSnapshot) {
    this.assertActive();
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  private patchType(type: ManagedEntityType, patch: Partial<HomeEntityFavoritesTypeSnapshot>) {
    this.publish({
      ...this.snapshot,
      byType: { ...this.snapshot.byType, [type]: { ...this.snapshot.byType[type], ...patch } },
    });
  }
  private acceptVersion(type: ManagedEntityType, version: string) {
    const current = this.snapshot.byType[type];
    const changed =
      current.typeCompositionVersion !== null && current.typeCompositionVersion !== version;
    const increment = changed && !this.awaitingWriteVersion[type];
    this.awaitingWriteVersion[type] = false;
    return {
      typeCompositionVersion: version,
      compositionEpoch: current.compositionEpoch + (increment ? 1 : 0),
    };
  }
  private publishLabels(server: ManagedEntityFavoriteLabelsResponse) {
    const current = this.snapshot.labels;
    if ((server.revision ?? 0) < (current.revision ?? 0)) return;
    const overrides = sanitizeHomeEntityFavoriteLabels(server.labels);
    const changed =
      current.revision !== server.revision ||
      JSON.stringify(current.overrides) !== JSON.stringify(overrides);
    saveHomeEntityFavoriteLabels(this.snapshot.actor.scope, overrides);
    this.publish({
      ...this.snapshot,
      labels: {
        overrides,
        resolved: resolveHomeEntityFavoriteLabels(overrides),
        revision: server.revision,
        serverConfirmed: true,
        labelsEpoch: current.labelsEpoch + (changed ? 1 : 0),
        status: 'ready',
        error: null,
      },
    });
  }
  private beginRead(type: ManagedEntityType, signal?: AbortSignal) {
    this.assertActive();
    const binding = this.signal(signal);
    const combined = binding.signal;
    combined.throwIfAborted();
    this.activeReads[type].add(binding.abort);
    const generation = this.writeGeneration[type];
    const sequence = ++this.readSequence[type];
    this.patchType(type, { status: 'loading', error: null });
    return {
      signal: combined,
      release: () => {
        binding.release();
        this.activeReads[type].delete(binding.abort);
      },
      valid: () =>
        !combined.aborted &&
        generation === this.writeGeneration[type] &&
        sequence >= this.acceptedRead[type],
      accept: () => {
        this.acceptedRead[type] = sequence;
      },
      cancel: () => {
        if (
          !this.lifetime.signal.aborted &&
          generation === this.writeGeneration[type] &&
          sequence === this.readSequence[type]
        ) {
          const current = this.snapshot.byType[type];
          this.patchType(type, {
            status: current.typeCompositionVersion === null ? 'idle' : 'ready',
          });
        }
      },
    };
  }

  refreshCatalogue = async (type: ManagedEntityType, signal?: AbortSignal) => {
    const read = this.beginRead(type, signal);
    try {
      const catalogue = await getManagedEntityNetworks(this.api, type, read.signal);
      read.signal.throwIfAborted();
      if (!read.valid()) return;
      if (catalogue.entityType !== type) throw new Error('Неверный тип сетки.');
      read.accept();
      this.patchType(type, {
        ...this.acceptVersion(type, catalogue.compositionVersion),
        catalogue,
        hasAcknowledgedRowEdits: false,
        assignmentsComplete: this.assignmentVersion[type] === catalogue.compositionVersion,
        catalogueStale: false,
        status: 'ready',
        error: null,
      });
      // Catalogue labels are revisioned independently of membership. Older catalogues
      // cannot replace a rename that was already acknowledged in this session.
      if (
        catalogue.labelsRevision !== null &&
        catalogue.labelsRevision >= (this.snapshot.labels.revision ?? 0)
      ) {
        const labels = Object.fromEntries(
          catalogue.items.map((card) => [card.favoriteType, card.label]),
        );
        this.publishLabels({
          initialized: catalogue.labelsRevision !== null,
          labels: catalogue.labelsRevision === null ? {} : labels,
          revision: catalogue.labelsRevision,
        });
      }
    } catch (error) {
      if (read.signal.aborted) read.cancel();
      if (read.valid()) this.patchType(type, { status: 'error', error, catalogueStale: true });
      throw error;
    } finally {
      read.release();
    }
  };
  refreshAssignments = async (type: ManagedEntityType, signal?: AbortSignal) => {
    const read = this.beginRead(type, signal);
    try {
      const loaded = await loadManagedEntityFavoriteAssignments(this.api, type, read.signal);
      read.signal.throwIfAborted();
      if (!read.valid()) return;
      const assignments = createEmptyHomeEntityFavoritesByType();
      for (const item of loaded.items) {
        if (item.entityType !== type || item.favoriteType === null)
          throw new Error('Неполный состав сеток.');
        if (!assignments[item.favoriteType].includes(item.id))
          assignments[item.favoriteType].push(item.id);
      }
      read.accept();
      this.assignmentRead[type] += 1;
      this.protectedTypes.add(type);
      this.assignmentVersion[type] = loaded.compositionVersion;
      const version = this.acceptVersion(type, loaded.compositionVersion);
      const current = this.snapshot;
      const next = { ...current.assignments, [type]: assignments };
      saveHomeEntityFavorites(current.actor.scope, next);
      this.publish({
        ...current,
        assignments: next,
        byType: {
          ...current.byType,
          [type]: {
            ...current.byType[type],
            ...version,
            assignmentsComplete: true,
            hasAcknowledgedRowEdits: false,
            catalogueStale:
              current.byType[type].catalogue?.compositionVersion !== loaded.compositionVersion,
            status: 'ready',
            error: null,
          },
        },
      });
    } catch (error) {
      if (read.signal.aborted) read.cancel();
      if (read.valid()) this.patchType(type, { status: 'error', error, catalogueStale: true });
      throw error;
    } finally {
      read.release();
    }
  };
  refreshLabels = async (signal?: AbortSignal) => {
    this.assertActive();
    const binding = this.signal(signal);
    const combined = binding.signal;
    const generation = this.labelsGeneration;
    const request = ++this.labelsRequest;
    this.publish({
      ...this.snapshot,
      labels: { ...this.snapshot.labels, status: 'loading', error: null },
    });
    try {
      let labels = await getManagedEntityFavoriteLabels(this.api, { signal: combined });
      combined.throwIfAborted();
      if (!labels.initialized) {
        const { hydrateHomeEntityFavoriteLabelMigrationCandidate } =
          await import('./home-entity-favorite-label-migration');
        combined.throwIfAborted();
        if (generation !== this.labelsGeneration || request !== this.labelsRequest) return;
        const candidate = await hydrateHomeEntityFavoriteLabelMigrationCandidate(
          this.snapshot.actor.scope,
          { signal: combined, waitForNativeStorage: true },
        );
        combined.throwIfAborted();
        if (generation !== this.labelsGeneration || request !== this.labelsRequest) return;
        if (Object.keys(candidate).length > 0) {
          const { initializeManagedEntityFavoriteLabels } =
            await import('./home-entity-favorite-label-writes');
          combined.throwIfAborted();
          if (generation !== this.labelsGeneration || request !== this.labelsRequest) return;
          labels = await initializeManagedEntityFavoriteLabels(this.api, candidate, combined);
        }
        combined.throwIfAborted();
      }
      if (generation === this.labelsGeneration && request === this.labelsRequest)
        this.publishLabels(labels);
    } catch (error) {
      if (combined.aborted && !this.lifetime.signal.aborted && request === this.labelsRequest)
        this.publish({
          ...this.snapshot,
          labels: {
            ...this.snapshot.labels,
            status: this.snapshot.labels.serverConfirmed ? 'ready' : 'idle',
          },
        });
      if (
        !combined.aborted &&
        generation === this.labelsGeneration &&
        request === this.labelsRequest
      )
        this.publish({
          ...this.snapshot,
          labels: { ...this.snapshot.labels, status: 'error', error },
        });
      throw error;
    } finally {
      binding.release();
    }
  };
  reconcileLoadedEntities = (entities: {
    chats?: readonly ChatSummary[];
    channels?: readonly ChatSummary[];
  }) => {
    this.assertActive();
    const next = reconcileHomeEntityFavoritesFromEntities(this.snapshot.assignments, {
      chats: this.protectedTypes.has('chat') || this.writing.chat ? undefined : entities.chats,
      channels:
        this.protectedTypes.has('channel') || this.writing.channel ? undefined : entities.channels,
    });
    if (JSON.stringify(next) === JSON.stringify(this.snapshot.assignments)) return;
    saveHomeEntityFavorites(this.snapshot.actor.scope, next);
    this.publish({ ...this.snapshot, assignments: next });
  };
  private beginWrite(type: ManagedEntityType) {
    this.assertActive();
    if (this.writing[type]) throw new Error('Дождитесь сохранения состава.');
    this.writing[type] = true;
    this.writeGeneration[type] += 1;
    this.abortTypeReads(type);
  }
  private writeContext(): HomeEntityFavoritesWriteContext {
    return {
      api: this.api,
      signal: this.lifetime.signal,
      getSnapshot: this.getSnapshot,
      assertActive: () => this.assertActive(),
      acceptWrite: (type) => {
        this.assertActive();
        this.writeGeneration[type] += 1;
        this.abortTypeReads(type);
        this.assignmentVersion[type] = null;
        this.awaitingWriteVersion[type] = true;
        this.protectedTypes.add(type);
      },
      publish: (next) => this.publish(next),
      refresh: (type) => this.refreshAfterWrite(type),
    };
  }
  private async refreshAfterWrite(type: ManagedEntityType): Promise<'complete' | 'pending'> {
    try {
      await this.refreshAssignments(type);
      await this.refreshCatalogue(type);
      const current = this.snapshot.byType[type];
      return current.assignmentsComplete && !current.catalogueStale ? 'complete' : 'pending';
    } catch {
      return 'pending';
    }
  }
  private failedWrite(type: ManagedEntityType) {
    if (this.lifetime.signal.aborted) return;
    this.writeGeneration[type] += 1;
    this.abortTypeReads(type);
    this.assignmentVersion[type] = null;
    this.patchType(type, {
      catalogueStale: true,
      assignmentsComplete: false,
      hasAcknowledgedRowEdits: false,
    });
    // Read reconciliation only. A transport error never authorizes mutation replay.
    void this.refreshAfterWrite(type);
  }
  setFavorite: HomeEntityFavoritesActions['setFavorite'] = async (
    change,
    refresh = 'immediate',
  ) => {
    const type = change.entityType;
    const current = this.snapshot.byType[type];
    if (
      refresh === 'on-return' &&
      !current.assignmentsComplete &&
      !current.hasAcknowledgedRowEdits
    ) {
      throw new Error('Обновите состав перед изменением.');
    }
    const pendingChange = { ...change };
    this.beginWrite(type);
    try {
      const { setHomeEntityFavorite } = await import('./home-entity-favorites-writes');
      this.assertActive();
      return await setHomeEntityFavorite(this.writeContext(), pendingChange, refresh);
    } catch (error) {
      this.failedWrite(type);
      throw error;
    } finally {
      this.writing[type] = false;
    }
  };
  commitComposition: HomeEntityFavoritesActions['commitComposition'] = async ({
    entityType: type,
    changes,
  }) => {
    if (
      changes.length < 1 ||
      changes.length > 500 ||
      new Set(changes.map((change) => change.entityId)).size !== changes.length
    )
      throw new Error('За одно сохранение можно изменить до 500 сообществ.');
    const pendingChanges = changes.map((change) => ({ ...change }));
    this.beginWrite(type);
    try {
      const { commitHomeEntityNetworkComposition } = await import('./home-entity-favorites-writes');
      this.assertActive();
      return await commitHomeEntityNetworkComposition(this.writeContext(), type, pendingChanges);
    } catch (error) {
      this.failedWrite(type);
      throw error;
    } finally {
      this.writing[type] = false;
    }
  };
  saveLabels: HomeEntityFavoritesActions['saveLabels'] = async ({ baseLabels, draftLabels }) => {
    this.assertActive();
    if (this.labelsWriting) throw new Error('Дождитесь сохранения названий.');
    this.labelsWriting = true;
    this.labelsGeneration += 1;
    try {
      const { saveManagedEntityFavoriteLabelEdits } =
        await import('./home-entity-favorite-label-writes');
      this.assertActive();
      const response = await saveManagedEntityFavoriteLabelEdits(
        this.api,
        baseLabels,
        draftLabels,
        this.lifetime.signal,
      );
      this.assertActive();
      this.labelsGeneration += 1;
      this.publishLabels(response);
      return response;
    } finally {
      this.labelsWriting = false;
    }
  };
  readonly actions: HomeEntityFavoritesActions = {
    refreshCatalogue: this.refreshCatalogue,
    refreshAssignments: this.refreshAssignments,
    refreshLabels: this.refreshLabels,
    reconcileLoadedEntities: this.reconcileLoadedEntities,
    setFavorite: this.setFavorite,
    commitComposition: this.commitComposition,
    saveLabels: this.saveLabels,
  };
}
