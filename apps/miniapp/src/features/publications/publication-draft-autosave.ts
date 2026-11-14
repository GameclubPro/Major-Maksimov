import type {
  PublicationDraftResponse,
  SavePublicationDraftRequest,
} from '@maxim/contracts/publication-draft';
import {
  draftFromServer,
  publicationDraftTextFingerprint,
  samePublicationDraftMedia,
  serverDraftRequest,
  withSavedPublicationMedia,
} from './publication-cloud-draft-model';
import {
  createEmptyPublicationDraft,
  isPublicationDraftEmpty,
  type PublicationDraft,
} from './publication-model';
import type { PublicationActionRequest } from '@maxim/contracts/publication';
import { createPublicationRequestId } from './publication-request-identity';

export type DraftSaveStatus =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'error'
  | 'conflict'
  | 'unavailable';
export type DraftSaveState = { status: DraftSaveStatus; error: unknown };
type PendingSave = {
  id: string | null;
  request: SavePublicationDraftRequest;
  snapshot: PublicationDraft;
};
type Dependencies = {
  save: (
    id: string | null,
    request: SavePublicationDraftRequest,
  ) => Promise<PublicationDraftResponse>;
  remove: (id: string, request: PublicationActionRequest) => Promise<void>;
  find: (requestId: string) => Promise<PublicationDraftResponse>;
  get: (id: string) => Promise<PublicationDraftResponse>;
  persist: (draft: PublicationDraft) => Promise<void>;
  changed: (draft: PublicationDraft) => void;
  stateChanged: (state: DraftSaveState) => void;
  canSave: () => boolean;
};

function statusCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
}
function conflict(): Error {
  return Object.assign(new Error('Найден сохранённый вариант черновика.'), { status: 409 });
}
function equal(left: PublicationDraft | null, right: PublicationDraft): boolean {
  return Boolean(
    left &&
    samePublicationDraftMedia(left, right) &&
    publicationDraftTextFingerprint(left) === publicationDraftTextFingerprint(right),
  );
}

// FLAG: A failed write retains its exact snapshot and nonce until its result is known.
export class PublicationDraftAutosave {
  private current: PublicationDraft;
  private saved: PublicationDraft | null = null;
  private pending: PendingSave | null = null;
  private operation: Promise<PublicationDraft> | null = null;
  private recoveryId: string | null;
  private active = true;
  private state: DraftSaveState = { status: 'idle', error: null };

  constructor(
    draft: PublicationDraft,
    private readonly dependencies: Dependencies,
  ) {
    this.current = draft;
    this.recoveryId = !draft.cloudDraft ? (draft.cloudRequestId ?? null) : null;
  }
  setSnapshot(draft: PublicationDraft) {
    this.current = draft;
  }
  activate() {
    this.active = true;
  }
  getSnapshot() {
    return this.current;
  }
  dispose() {
    this.active = false;
  }
  markConflict(error: unknown) {
    this.report('conflict', error);
  }
  get dirty() {
    return (
      !equal(this.saved, this.current) &&
      (Boolean(this.current.cloudDraft) || !isPublicationDraftEmpty(this.current))
    );
  }
  private report(status: DraftSaveStatus, error: unknown = null) {
    this.state = { status, error };
    if (this.active) this.dependencies.stateChanged(this.state);
  }
  private replace(draft: PublicationDraft) {
    this.current = draft;
    if (this.active) this.dependencies.changed(draft);
  }
  flush(): Promise<PublicationDraft> {
    if (this.operation) return this.operation;
    if (this.state.status === 'conflict' || this.state.status === 'unavailable')
      return Promise.reject(this.state.error);
    this.operation = this.run().finally(() => {
      this.operation = null;
    });
    return this.operation;
  }
  private async run(): Promise<PublicationDraft> {
    try {
      if (this.recoveryId) {
        this.report('saving');
        let recovered: PublicationDraftResponse | null = null;
        try {
          recovered = await this.dependencies.find(this.recoveryId);
        } catch (error) {
          if (statusCode(error) !== 404) throw error;
        }
        if (recovered) {
          this.replace({
            ...this.current,
            cloudDraft: { id: recovered.publication.id, revision: recovered.publication.version },
          });
          throw conflict();
        }
        this.recoveryId = null;
      }
      while (this.active && this.dependencies.canSave() && (this.pending || this.dirty)) {
        this.report('saving');
        if (!this.pending) {
          const requestId = this.current.cloudDraft
            ? createPublicationRequestId()
            : (this.current.cloudRequestId ?? createPublicationRequestId());
          if (!this.current.cloudDraft && !this.current.cloudRequestId)
            this.replace({ ...this.current, cloudRequestId: requestId });
          const snapshot = this.current;
          this.pending = {
            snapshot,
            id: snapshot.cloudDraft?.id ?? null,
            request: serverDraftRequest(snapshot, requestId, snapshot.cloudDraft?.revision),
          };
        }
        const pending = this.pending;
        await this.dependencies.persist(pending.snapshot);
        const response = await this.dependencies.save(pending.id, pending.request);
        if (!this.active) return this.current;
        const identity = { id: response.publication.id, revision: response.publication.version };
        // FLAG: Rebase links to the newly saved draft and share one media snapshot;
        // separate equivalent arrays would keep reference-based autosave dirty forever.
        const savedMedia = response.publication.content.media.map((asset) => ({
          ...asset,
          sourcePublicationId: identity.id,
        }));
        const acknowledged = {
          ...withSavedPublicationMedia(pending.snapshot, savedMedia),
          cloudDraft: identity,
        };
        this.saved = acknowledged;
        this.pending = null;
        const current =
          this.dependencies.canSave() && samePublicationDraftMedia(this.current, pending.snapshot)
            ? withSavedPublicationMedia(this.current, savedMedia)
            : this.current;
        this.replace({ ...current, cloudDraft: identity });
        await this.dependencies.persist(this.current);
      }
      this.report(this.dirty ? 'pending' : this.current.cloudDraft ? 'saved' : 'idle');
      return this.current;
    } catch (error) {
      if ([400, 403, 404, 422].includes(statusCode(error) ?? 0)) this.pending = null;
      this.report(
        statusCode(error) === 409
          ? 'conflict'
          : statusCode(error) === 404
            ? 'unavailable'
            : 'error',
        error,
      );
      throw error;
    }
  }
  async discard(): Promise<void> {
    if (this.operation) await this.operation.catch(() => undefined);
    // FLAG: Do not orphan an unacknowledged create or erase another device's revision.
    if (this.pending || this.recoveryId) {
      if (this.state.status === 'conflict') throw this.state.error;
      throw new Error('Повторите сохранение, затем удалите черновик.');
    }
    const identity = this.current.cloudDraft;
    if (identity) {
      await this.dependencies.remove(identity.id, {
        requestId: createPublicationRequestId(),
        expectedRevision: identity.revision,
      });
    }
    if (!this.active) return;
    this.saved = null;
    this.replace(createEmptyPublicationDraft());
    await this.dependencies.persist(this.current);
    this.report('idle');
  }
  async reload(): Promise<void> {
    if (this.operation) await this.operation.catch(() => undefined);
    const id = this.current.cloudDraft?.id;
    const response = id
      ? await this.dependencies.get(id)
      : this.current.cloudRequestId
        ? await this.dependencies.find(this.current.cloudRequestId)
        : null;
    if (!response) throw new Error('Черновик не найден.');
    if (!this.active) return;
    this.pending = null;
    this.recoveryId = null;
    const draft = draftFromServer(response);
    this.saved = draft;
    this.replace(draft);
    await this.dependencies.persist(draft);
    this.report('saved');
  }
  async saveCopy(): Promise<PublicationDraft> {
    if (this.operation) await this.operation.catch(() => undefined);
    this.pending = null;
    this.recoveryId = null;
    this.saved = null;
    this.replace({ ...this.current, cloudDraft: undefined, cloudRequestId: undefined });
    this.report('pending');
    return this.flush();
  }
}
