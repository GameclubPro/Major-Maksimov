import type { BroadcastImage, BroadcastLinkButton } from '@maxim/contracts';
import {
  areAutoReplyDraftsEqual,
  AUTO_REPLY_MAX_IMAGES,
  createEmptyAutoReplyDraft,
  normalizeAutoReplyDraft,
  type AutoReplyAssetMetadata,
  type AutoReplyDraft,
} from '../pages/publisher-auto-replies-page-model';
import {
  readLocalMirrorItemState,
  readNativeStorageItemState,
  removeLocalMirrorItem,
  removeNativeStorageItem,
  type StorageItemReadResult,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from './native-storage';

const AUTO_REPLY_DRAFT_VERSION = 3;
const AUTO_REPLY_DRAFT_DB_NAME = 'maxim-publisher-auto-replies';
const AUTO_REPLY_DRAFT_DB_VERSION = 1;
const AUTO_REPLY_DRAFT_STORE_NAME = 'drafts';
const AUTO_REPLY_DRAFT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

type StoredAutoReplyDraft = Omit<AutoReplyDraft, 'images'> & { images: BroadcastImage[] };

type AutoReplyDraftEnvelope = {
  version: typeof AUTO_REPLY_DRAFT_VERSION;
  savedAt: string;
  imagesComplete?: boolean;
  imageCount?: number;
  deleted?: boolean;
  draft?: StoredAutoReplyDraft;
};

type AutoReplyDraftStorageSource = 'indexed' | 'local' | 'native';

type AutoReplyDraftCandidate = {
  draft: AutoReplyDraft | null;
  deleted: boolean;
  imageCount: number;
  imagesComplete: boolean;
  savedAt: string;
  savedAtMs: number;
  source: AutoReplyDraftStorageSource;
  version: number;
};

type AutoReplyDraftCandidateRead = {
  candidate: AutoReplyDraftCandidate | null;
  discard: boolean;
  readable: boolean;
};

type AutoReplyDraftEnvelopeRead =
  | { status: 'found'; value: unknown }
  | { status: 'missing' | 'unavailable' | 'error' };

type AutoReplyDraftDbOpenResult =
  | { status: 'available'; db: IDBDatabase }
  | { status: 'unavailable' | 'error' };

const autoReplyDraftStorageQueues = new Map<string, Promise<unknown>>();
let lastAutoReplyDraftMutationMs = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAssetMetadata(value: unknown): AutoReplyAssetMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    return id && mimeType.startsWith('image/') ? [{ id, mimeType, fileName }] : [];
  });
}

function readImages(value: unknown): BroadcastImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const base64 = typeof item.base64 === 'string' ? item.base64.trim() : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    return base64 && mimeType.startsWith('image/') ? [{ base64, mimeType, fileName }] : [];
  });
}

function readButtons(value: unknown): BroadcastLinkButton[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== 'string' || typeof item.url !== 'string') {
      return [];
    }
    return [{ text: item.text, url: item.url }];
  });
}

function readPhrases(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseAutoReplyDraftEnvelope(value: unknown): AutoReplyDraft | null {
  if (
    !isRecord(value) ||
    (value.version !== AUTO_REPLY_DRAFT_VERSION && value.version !== 2) ||
    !isRecord(value.draft)
  ) {
    return null;
  }

  const fallback = createEmptyAutoReplyDraft();
  const draft = value.draft;
  return normalizeAutoReplyDraft({
    phrases:
      value.version === 2
        ? typeof draft.phrase === 'string'
          ? [draft.phrase]
          : []
        : readPhrases(draft.phrases),
    matchInContext:
      value.version === AUTO_REPLY_DRAFT_VERSION && typeof draft.matchInContext === 'boolean'
        ? draft.matchInContext
        : false,
    fuzzyMatch:
      value.version === AUTO_REPLY_DRAFT_VERSION && typeof draft.fuzzyMatch === 'boolean'
        ? draft.fuzzyMatch
        : false,
    text: typeof draft.text === 'string' ? draft.text : '',
    images: readImages(draft.images),
    retainedAssets: readAssetMetadata(draft.retainedAssets),
    buttons: readButtons(draft.buttons),
    cooldownSeconds:
      typeof draft.cooldownSeconds === 'number' ? draft.cooldownSeconds : fallback.cooldownSeconds,
    enabled: typeof draft.enabled === 'boolean' ? draft.enabled : fallback.enabled,
  });
}

function requireStorageScope(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Auto-reply draft persistence requires ${label}.`);
  }
  return normalized;
}

export function getAutoReplyDraftStorageKey(
  userId: string,
  chatId: string,
  ruleId?: string | null,
): string {
  const userScope = requireStorageScope(userId, 'an authenticated user');
  const chatScope = requireStorageScope(chatId, 'a chat');
  const scope = ruleId?.trim() || 'new';
  return `maxim:publisher-auto-reply:v3:${encodeURIComponent(userScope)}:${encodeURIComponent(chatScope)}:${encodeURIComponent(scope)}`;
}

function getLegacyAutoReplyDraftStorageKey(chatId: string, ruleId?: string | null): string {
  const scope = ruleId?.trim() || 'new';
  return `maxim:publisher-auto-reply:${encodeURIComponent(chatId)}:${encodeURIComponent(scope)}`;
}

function nextAutoReplyDraftSavedAt(): string {
  const nowMs = Date.now();
  if (lastAutoReplyDraftMutationMs > nowMs + AUTO_REPLY_DRAFT_MAX_FUTURE_SKEW_MS) {
    lastAutoReplyDraftMutationMs = nowMs;
  }
  lastAutoReplyDraftMutationMs = Math.max(nowMs, lastAutoReplyDraftMutationMs + 1);
  return new Date(lastAutoReplyDraftMutationMs).toISOString();
}

function enqueueAutoReplyDraftStorageMutation<T>(
  key: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = autoReplyDraftStorageQueues.get(key) ?? Promise.resolve();
  const queued = previous.then(mutation, mutation);
  autoReplyDraftStorageQueues.set(key, queued);
  const clearQueue = () => {
    if (autoReplyDraftStorageQueues.get(key) === queued) {
      autoReplyDraftStorageQueues.delete(key);
    }
  };
  void queued.then(clearQueue, clearQueue);
  return queued;
}

function openAutoReplyDraftDb(): Promise<AutoReplyDraftDbOpenResult> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ status: 'unavailable' });
  }

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      const indexedDb = window.indexedDB;
      if (!indexedDb) {
        resolve({ status: 'unavailable' });
        return;
      }
      request = indexedDb.open(AUTO_REPLY_DRAFT_DB_NAME, AUTO_REPLY_DRAFT_DB_VERSION);
    } catch (error: unknown) {
      resolve({
        status:
          error instanceof DOMException && error.name === 'SecurityError' ? 'unavailable' : 'error',
      });
      return;
    }
    let settled = false;
    const finish = (result: AutoReplyDraftDbOpenResult) => {
      if (settled) {
        if (result.status === 'available') {
          result.db.close();
        }
        return;
      }
      settled = true;
      resolve(result);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUTO_REPLY_DRAFT_STORE_NAME)) {
        request.result.createObjectStore(AUTO_REPLY_DRAFT_STORE_NAME);
      }
    };
    request.onerror = () => finish({ status: 'error' });
    request.onblocked = () => finish({ status: 'error' });
    request.onsuccess = () => finish({ status: 'available', db: request.result });
  });
}

async function readIndexedEnvelope(key: string): Promise<AutoReplyDraftEnvelopeRead> {
  const opened = await openAutoReplyDraftDb();
  if (opened.status !== 'available') {
    return opened;
  }
  const { db } = opened;

  try {
    return await new Promise((resolve) => {
      const transaction = db.transaction(AUTO_REPLY_DRAFT_STORE_NAME, 'readonly');
      const request = transaction.objectStore(AUTO_REPLY_DRAFT_STORE_NAME).get(key);
      let settled = false;
      let value: unknown;
      const finish = (result: AutoReplyDraftEnvelopeRead) => {
        if (settled) return;
        settled = true;
        db.close();
        resolve(result);
      };
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () => finish({ status: 'error' });
      transaction.oncomplete = () =>
        finish(value === undefined ? { status: 'missing' } : { status: 'found', value });
      transaction.onerror = () => finish({ status: 'error' });
      transaction.onabort = () => finish({ status: 'error' });
    });
  } catch {
    db.close();
    return { status: 'error' };
  }
}

async function writeIndexedDraft(
  key: string,
  envelope: AutoReplyDraftEnvelope | null,
): Promise<boolean> {
  const opened = await openAutoReplyDraftDb();
  if (opened.status !== 'available') return false;
  const { db } = opened;
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(AUTO_REPLY_DRAFT_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AUTO_REPLY_DRAFT_STORE_NAME);
      if (envelope) store.put(envelope, key);
      else store.delete(key);
      const finish = (saved: boolean) => {
        db.close();
        resolve(saved);
      };
      transaction.oncomplete = () => finish(true);
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    });
  } catch {
    db.close();
    return false;
  }
}

function serializeNativeEnvelope(envelope: AutoReplyDraftEnvelope): string {
  const imageCount = envelope.imageCount ?? envelope.draft?.images.length ?? 0;
  return JSON.stringify({
    ...envelope,
    imageCount,
    imagesComplete:
      envelope.deleted === true ||
      (envelope.imagesComplete === true && (envelope.draft?.images.length ?? 0) === 0),
    ...(envelope.draft ? { draft: { ...envelope.draft, images: [] } } : {}),
  });
}

function parseSerializedEnvelope(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readAutoReplyDraftCandidate(
  value: unknown,
  source: AutoReplyDraftStorageSource,
  nowMs: number,
  status: AutoReplyDraftEnvelopeRead['status'],
): AutoReplyDraftCandidateRead {
  if (status === 'error' || status === 'unavailable') {
    return { candidate: null, discard: false, readable: false };
  }
  if (value === null || value === undefined) {
    return { candidate: null, discard: false, readable: true };
  }
  if (!isRecord(value)) {
    return { candidate: null, discard: true, readable: true };
  }
  const savedAt = typeof value.savedAt === 'string' ? value.savedAt : '';
  const savedAtMs = Date.parse(savedAt);
  if (!Number.isFinite(savedAtMs) || savedAtMs > nowMs + AUTO_REPLY_DRAFT_MAX_FUTURE_SKEW_MS) {
    return { candidate: null, discard: true, readable: true };
  }
  if (value.version === AUTO_REPLY_DRAFT_VERSION && value.deleted === true) {
    return {
      candidate: {
        draft: null,
        deleted: true,
        imageCount: 0,
        imagesComplete: true,
        savedAt,
        savedAtMs,
        source,
        version: value.version,
      },
      discard: false,
      readable: true,
    };
  }
  const draft = parseAutoReplyDraftEnvelope(value);
  const storedImageCount =
    typeof value.imageCount === 'number' &&
    Number.isSafeInteger(value.imageCount) &&
    value.imageCount >= 0
      ? value.imageCount
      : (draft?.images.length ?? 0);
  return draft
    ? {
        candidate: {
          draft,
          deleted: false,
          imageCount: Math.min(
            AUTO_REPLY_MAX_IMAGES,
            Math.max(storedImageCount, draft.images.length),
          ),
          imagesComplete:
            value.imagesComplete === true || (source === 'indexed' && value.version === 2),
          savedAt,
          savedAtMs,
          source,
          version: typeof value.version === 'number' ? value.version : -1,
        },
        discard: false,
        readable: true,
      }
    : { candidate: null, discard: true, readable: true };
}

function inferEnvelopeRead(value: unknown, status?: AutoReplyDraftEnvelopeRead['status']) {
  return status ?? (value === null || value === undefined ? 'missing' : 'found');
}

export function resolveAutoReplyDraftLoadState(params: {
  indexedEnvelope: unknown;
  localEnvelope: unknown;
  nativeEnvelope: unknown;
  indexedStatus?: AutoReplyDraftEnvelopeRead['status'];
  localStatus?: AutoReplyDraftEnvelopeRead['status'];
  nativeStatus?: AutoReplyDraftEnvelopeRead['status'];
  nowMs?: number;
}): {
  draft: AutoReplyDraft | null;
  deleted: boolean;
  source: AutoReplyDraftStorageSource | null;
  savedAt: string | null;
  imagesComplete: boolean;
  missingImageCount: number;
  replicasToRepair: AutoReplyDraftStorageSource[];
} {
  const nowMs = params.nowMs ?? Date.now();
  const reads: Record<AutoReplyDraftStorageSource, AutoReplyDraftCandidateRead> = {
    indexed: readAutoReplyDraftCandidate(
      params.indexedEnvelope,
      'indexed',
      nowMs,
      inferEnvelopeRead(params.indexedEnvelope, params.indexedStatus),
    ),
    local: readAutoReplyDraftCandidate(
      params.localEnvelope,
      'local',
      nowMs,
      inferEnvelopeRead(params.localEnvelope, params.localStatus),
    ),
    native: readAutoReplyDraftCandidate(
      params.nativeEnvelope,
      'native',
      nowMs,
      inferEnvelopeRead(params.nativeEnvelope, params.nativeStatus),
    ),
  };
  const candidates = Object.values(reads)
    .map((read) => read.candidate)
    .filter((candidate): candidate is AutoReplyDraftCandidate => candidate !== null);
  const sourceRank: Record<AutoReplyDraftStorageSource, number> = {
    indexed: 3,
    local: 2,
    native: 1,
  };
  candidates.sort((left, right) => {
    const savedAtDiff = right.savedAtMs - left.savedAtMs;
    if (savedAtDiff !== 0) {
      return savedAtDiff;
    }
    if (left.deleted !== right.deleted) {
      return Number(right.deleted) - Number(left.deleted);
    }
    return sourceRank[right.source] - sourceRank[left.source];
  });
  const selected = candidates[0] ?? null;
  const replicasToRepair = (Object.keys(reads) as AutoReplyDraftStorageSource[]).filter(
    (source) => {
      const read = reads[source];
      if (!read.readable) {
        return false;
      }
      if (!selected) {
        return read.discard;
      }
      const candidate = read.candidate;
      if (!candidate || candidate.version !== AUTO_REPLY_DRAFT_VERSION) {
        return true;
      }
      if (candidate.savedAtMs !== selected.savedAtMs || candidate.deleted !== selected.deleted) {
        return true;
      }
      if (selected.deleted || !selected.draft || !candidate.draft) {
        return false;
      }
      const expectedDraft =
        source === 'indexed' ? selected.draft : { ...selected.draft, images: [] };
      return !areAutoReplyDraftsEqual(candidate.draft, expectedDraft);
    },
  );
  return {
    draft: selected?.draft ?? null,
    deleted: selected?.deleted ?? false,
    source: selected?.source ?? null,
    savedAt: selected?.savedAt ?? null,
    imagesComplete: selected?.imagesComplete ?? false,
    missingImageCount:
      selected && !selected.deleted && !selected.imagesComplete
        ? Math.max(1, selected.imageCount - (selected.draft?.images.length ?? 0))
        : 0,
    replicasToRepair,
  };
}

function parseMirroredEnvelopeRead(read: StorageItemReadResult): AutoReplyDraftEnvelopeRead {
  return read.status === 'found'
    ? { status: 'found', value: parseSerializedEnvelope(read.value) }
    : read;
}

async function readAutoReplyDraftReplicas(key: string): Promise<{
  indexed: AutoReplyDraftEnvelopeRead;
  local: AutoReplyDraftEnvelopeRead;
  native: AutoReplyDraftEnvelopeRead;
}> {
  let [indexed, nativeStorageRead] = await Promise.all([
    readIndexedEnvelope(key),
    readNativeStorageItemState(key),
  ]);
  let local = parseMirroredEnvelopeRead(readLocalMirrorItemState(key));
  let native = parseMirroredEnvelopeRead(nativeStorageRead);

  if (indexed.status === 'error' || local.status === 'error' || native.status === 'error') {
    [indexed, nativeStorageRead] = await Promise.all([
      indexed.status === 'error' ? readIndexedEnvelope(key) : Promise.resolve(indexed),
      native.status === 'error'
        ? readNativeStorageItemState(key)
        : Promise.resolve(nativeStorageRead),
    ]);
    local =
      local.status === 'error' ? parseMirroredEnvelopeRead(readLocalMirrorItemState(key)) : local;
    native = native.status === 'error' ? parseMirroredEnvelopeRead(nativeStorageRead) : native;
  }

  if (indexed.status === 'error' || local.status === 'error' || native.status === 'error') {
    throw new Error('Auto-reply draft storage could not be read safely.');
  }
  return { indexed, local, native };
}

async function clearLegacyAutoReplyDraft(chatId: string, ruleId?: string | null): Promise<void> {
  const legacyKey = getLegacyAutoReplyDraftStorageKey(chatId, ruleId);
  removeLocalMirrorItem(legacyKey);
  await enqueueAutoReplyDraftStorageMutation(legacyKey, async () => {
    await Promise.allSettled([
      removeNativeStorageItem(legacyKey),
      writeIndexedDraft(legacyKey, null),
    ]);
  });
}

export async function loadAutoReplyDraft(
  userId: string,
  chatId: string,
  ruleId?: string | null,
): Promise<AutoReplyDraft | null> {
  return (await loadAutoReplyDraftState(userId, chatId, ruleId)).draft;
}

export async function loadAutoReplyDraftState(
  userId: string,
  chatId: string,
  ruleId?: string | null,
): Promise<{ draft: AutoReplyDraft | null; imagesComplete: boolean; missingImageCount: number }> {
  const key = getAutoReplyDraftStorageKey(userId, chatId, ruleId);
  await clearLegacyAutoReplyDraft(chatId, ruleId);
  return enqueueAutoReplyDraftStorageMutation(key, async () => {
    const {
      indexed: indexedRead,
      local: localRead,
      native: nativeRead,
    } = await readAutoReplyDraftReplicas(key);
    const resolved = resolveAutoReplyDraftLoadState({
      indexedEnvelope: indexedRead.status === 'found' ? indexedRead.value : null,
      indexedStatus: indexedRead.status,
      localEnvelope: localRead.status === 'found' ? localRead.value : null,
      localStatus: localRead.status,
      nativeEnvelope: nativeRead.status === 'found' ? nativeRead.value : null,
      nativeStatus: nativeRead.status,
    });
    if (!resolved.savedAt) {
      if (resolved.replicasToRepair.includes('local')) {
        removeLocalMirrorItem(key);
      }
      await Promise.allSettled([
        ...(resolved.replicasToRepair.includes('native') ? [removeNativeStorageItem(key)] : []),
        ...(resolved.replicasToRepair.includes('indexed') ? [writeIndexedDraft(key, null)] : []),
      ]);
      return { draft: null, imagesComplete: true, missingImageCount: 0 };
    }

    lastAutoReplyDraftMutationMs = Math.max(
      lastAutoReplyDraftMutationMs,
      Date.parse(resolved.savedAt),
    );
    const canonicalEnvelope: AutoReplyDraftEnvelope = resolved.deleted
      ? {
          version: AUTO_REPLY_DRAFT_VERSION,
          savedAt: resolved.savedAt,
          imagesComplete: true,
          imageCount: 0,
          deleted: true,
        }
      : {
          version: AUTO_REPLY_DRAFT_VERSION,
          savedAt: resolved.savedAt,
          imagesComplete: resolved.imagesComplete,
          imageCount: resolved.missingImageCount + (resolved.draft?.images.length ?? 0),
          draft: resolved.draft!,
        };
    const serializedEnvelope = serializeNativeEnvelope(canonicalEnvelope);
    if (resolved.replicasToRepair.includes('local')) {
      writeLocalMirrorItem(key, serializedEnvelope);
    }
    await Promise.allSettled([
      ...(resolved.replicasToRepair.includes('native')
        ? [writeNativeStorageItem(key, serializedEnvelope)]
        : []),
      ...(resolved.replicasToRepair.includes('indexed')
        ? [
            writeIndexedDraft(
              key,
              resolved.deleted || resolved.imagesComplete ? canonicalEnvelope : null,
            ),
          ]
        : []),
    ]);
    return {
      draft: resolved.draft,
      imagesComplete: resolved.imagesComplete,
      missingImageCount: resolved.missingImageCount,
    };
  });
}

export function saveAutoReplyDraft(
  userId: string,
  chatId: string,
  ruleId: string | null | undefined,
  draft: AutoReplyDraft,
  options: { imagesComplete?: boolean; imageCount?: number } = {},
): Promise<boolean> {
  if (typeof window === 'undefined') {
    return Promise.resolve(false);
  }

  const key = getAutoReplyDraftStorageKey(userId, chatId, ruleId);
  const normalizedDraft = normalizeAutoReplyDraft(draft);
  const imagesComplete = options.imagesComplete ?? true;
  const envelope: AutoReplyDraftEnvelope = {
    version: AUTO_REPLY_DRAFT_VERSION,
    savedAt: nextAutoReplyDraftSavedAt(),
    imagesComplete,
    imageCount: Math.min(
      AUTO_REPLY_MAX_IMAGES,
      Math.max(options.imageCount ?? normalizedDraft.images.length, normalizedDraft.images.length),
    ),
    draft: normalizedDraft,
  };
  const nativeEnvelope = serializeNativeEnvelope(envelope);
  writeLocalMirrorItem(key, nativeEnvelope);
  return enqueueAutoReplyDraftStorageMutation(key, async () => {
    writeLocalMirrorItem(key, nativeEnvelope);
    const [indexedSaved, native] = await Promise.all([
      imagesComplete ? writeIndexedDraft(key, envelope) : Promise.resolve(false),
      writeNativeStorageItem(key, nativeEnvelope).then(() => readNativeStorageItemState(key)),
    ]);
    if (indexedSaved) return true;
    if (!imagesComplete || normalizedDraft.images.length > 0) return false;
    const local = readLocalMirrorItemState(key);
    return (
      (local.status === 'found' && local.value === nativeEnvelope) ||
      (native.status === 'found' && native.value === nativeEnvelope)
    );
  });
}

export async function clearAutoReplyDraft(
  userId: string,
  chatId: string,
  ruleId?: string | null,
): Promise<void> {
  const key = getAutoReplyDraftStorageKey(userId, chatId, ruleId);
  const tombstone: AutoReplyDraftEnvelope = {
    version: AUTO_REPLY_DRAFT_VERSION,
    savedAt: nextAutoReplyDraftSavedAt(),
    imagesComplete: true,
    imageCount: 0,
    deleted: true,
  };
  const serializedTombstone = serializeNativeEnvelope(tombstone);
  writeLocalMirrorItem(key, serializedTombstone);
  await enqueueAutoReplyDraftStorageMutation(key, async () => {
    writeLocalMirrorItem(key, serializedTombstone);
    await Promise.allSettled([
      writeNativeStorageItem(key, serializedTombstone),
      writeIndexedDraft(key, tombstone),
    ]);
  });
  await clearLegacyAutoReplyDraft(chatId, ruleId);
}
