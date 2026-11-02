import type { BroadcastImage, BroadcastLinkButton } from '@maxim/contracts';
import { channelPostSignatureSettingsSchema } from '@maxim/contracts/channel-post-signature';
import {
  MAX_PUBLICATION_IMAGES,
  publicationAssetSchema,
  publicationLatePolicySchema,
} from '@maxim/contracts/publication';
import { publisherEntityReadinessSchema } from '@maxim/contracts/publisher';
import { formatLocalDateTimeInputValue } from '../../lib/broadcast-schedule';
import { publicationPostPublishSchema } from '@maxim/contracts/publication';
import {
  createEmptyPublicationDraft,
  getPublicationTargetTitle,
  type PublicationDraft,
  PublicationTarget,
  PublicationTimingMode,
} from './publication-model';

const STORAGE_VERSION = 3;
const LEGACY_STORAGE_VERSIONS = new Set([1, 2]);
const STORAGE_KEY_PREFIX = 'maxim:publications-composer:v1';
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const ANONYMOUS_STORAGE_SCOPE = 'anonymous';
const DB_NAME = 'maxim-publications-composer';
const DB_VERSION = 2;
const STORE_NAME = 'drafts';
const MEDIA_STORE_NAME = 'media';
const MAX_FUTURE_SAVED_AT_SKEW_MS = 5 * 60_000;

export const PUBLICATION_DRAFT_TTL_MS = 14 * 24 * 60 * 60_000;

type DraftEnvelope = {
  version: 3;
  savedAt: string;
  draft: PublicationDraft;
  hasImages: boolean;
  imageCount: number;
};

type DraftMediaEnvelope = {
  version: 1;
  images: BroadcastImage[];
};

type DraftMediaCacheEntry = {
  images: readonly BroadcastImage[];
  stored: boolean;
};

const draftMediaCache = new Map<string, DraftMediaCacheEntry>();
const draftStorageQueues = new Map<string, Promise<void>>();

export type PublicationDraftLoadState = {
  draft: PublicationDraft | null;
  imagesNeedReselection: boolean;
  missingImageCount: number;
  savedAt: string | null;
  source: 'indexed' | 'local' | null;
};

type PublicationDraftCandidate = Exclude<PublicationDraftLoadState, { draft: null }> & {
  draft: PublicationDraft;
  savedAtMs: number;
};

export type PublicationDraftLoadResolution = PublicationDraftLoadState & {
  discardIndexed: boolean;
  discardLocal: boolean;
};

export function preparePublicationDraftForPersistence(draft: PublicationDraft): PublicationDraft {
  if (draft.mediaType !== 'video' || (!draft.mediaBase64 && !draft.mediaPayload)) {
    return draft;
  }

  return {
    ...draft,
    mediaPayload: null,
    mediaBase64: '',
  };
}

export function preparePublicationDraftForIndexedPersistence(draft: PublicationDraft): {
  draft: PublicationDraft;
  images: readonly BroadcastImage[];
  hasImages: boolean;
} {
  const persistedDraft = preparePublicationDraftForPersistence(draft);
  return {
    draft: { ...persistedDraft, images: [] },
    images: persistedDraft.images,
    hasImages: persistedDraft.images.length > 0,
  };
}

export function buildPublicationDraftStorageKey(userId?: string | null): string {
  const scope = userId?.trim() || ANONYMOUS_STORAGE_SCOPE;
  return `${STORAGE_KEY_PREFIX}:${encodeURIComponent(scope)}`;
}

function requirePublicationDraftUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Publication draft persistence requires an authenticated user.');
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readChannelOverview(value: unknown): PublicationTarget['channelOverview'] {
  if (
    !isObject(value) ||
    typeof value.commentsEnabled !== 'boolean' ||
    typeof value.postSuggestionsEnabled !== 'boolean'
  ) {
    return null;
  }

  return {
    commentsEnabled: value.commentsEnabled,
    postSuggestionsEnabled: value.postSuggestionsEnabled,
  };
}

function readPublisherReadiness(value: unknown): PublicationTarget['readiness'] {
  const parsed = publisherEntityReadinessSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readPublisherChannelPostSignature(
  value: unknown,
): PublicationTarget['publisherChannelPostSignature'] {
  const parsed = channelPostSignatureSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readTargets(value: unknown): PublicationTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.id !== 'string') {
      return [];
    }
    const entityType =
      item.entityType === 'channel' ? 'channel' : item.entityType === 'chat' ? 'chat' : null;
    if (!entityType) {
      return [];
    }
    return [
      {
        id: item.id,
        entityType,
        title: getPublicationTargetTitle({ entityType, title: readString(item.title) }),
        avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
        channelOverview:
          entityType === 'channel' ? readChannelOverview(item.channelOverview) : null,
        publisherChatCommentsEnabled:
          entityType === 'chat' && item.publisherChatCommentsEnabled === true,
        publisherChannelCommentsEnabled:
          entityType === 'channel' && item.publisherChannelCommentsEnabled === true,
        publisherChannelSuggestionsEnabled:
          entityType === 'channel' && item.publisherChannelSuggestionsEnabled === true,
        publisherChannelPostSignature:
          entityType === 'channel'
            ? readPublisherChannelPostSignature(item.publisherChannelPostSignature)
            : null,
        readiness: readPublisherReadiness(item.readiness),
      },
    ];
  });
}

function readImages(value: unknown): BroadcastImage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const base64 = readString(item.base64);
    const mimeType = readString(item.mimeType);
    if (!base64 || !mimeType) {
      return [];
    }
    return [{ base64, mimeType, fileName: readString(item.fileName) }];
  });
}

function readButtons(value: unknown): BroadcastLinkButton[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    isObject(item) ? [{ text: readString(item.text), url: readString(item.url) }] : [],
  );
}

function readTimingMode(value: unknown): PublicationTimingMode {
  return value === 'once' || value === 'schedule' ? value : 'now';
}

function readRecurrence(value: unknown): PublicationDraft['recurrence'] {
  const source = isObject(value) ? value : {};
  return {
    frequency: source.frequency === 'daily' ? 'daily' : 'weekly',
    interval:
      typeof source.interval === 'number' && Number.isInteger(source.interval)
        ? Math.max(1, Math.min(31, source.interval))
        : 1,
    weekdays: Array.isArray(source.weekdays)
      ? source.weekdays.filter(
          (item): item is number =>
            typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 7,
        )
      : [],
    times: Array.isArray(source.times)
      ? source.times.filter((item): item is string => typeof item === 'string')
      : ['10:00'],
    startsAt: typeof source.startsAt === 'string' ? source.startsAt : null,
    endsAt: typeof source.endsAt === 'string' ? source.endsAt : null,
    maxOccurrences:
      typeof source.maxOccurrences === 'number' && Number.isInteger(source.maxOccurrences)
        ? source.maxOccurrences
        : null,
  };
}

export function parsePublicationDraftEnvelope(value: unknown): PublicationDraft | null {
  if (
    !isObject(value) ||
    (value.version !== STORAGE_VERSION &&
      !(typeof value.version === 'number' && LEGACY_STORAGE_VERSIONS.has(value.version))) ||
    !isObject(value.draft)
  ) {
    return null;
  }
  const draft = value.draft;
  const cloudDraft =
    isObject(draft.cloudDraft) &&
    typeof draft.cloudDraft.id === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/u.test(draft.cloudDraft.id) &&
    Number.isSafeInteger(draft.cloudDraft.revision) &&
    (draft.cloudDraft.revision as number) > 0
      ? { id: draft.cloudDraft.id, revision: draft.cloudDraft.revision as number }
      : undefined;
  const cloudRequestId =
    typeof draft.cloudRequestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(draft.cloudRequestId)
      ? draft.cloudRequestId
      : undefined;
  const hasExplicitTimingFields =
    Object.prototype.hasOwnProperty.call(draft, 'onceDate') ||
    Object.prototype.hasOwnProperty.call(draft, 'onceTime');
  const timingMode = readTimingMode(draft.timingMode);
  const scheduleKind = draft.scheduleKind === 'recurrence' ? 'recurrence' : 'slots';
  const safeTimingDefaults = createEmptyPublicationDraft().recurrence;
  const scheduledSlots = Array.isArray(draft.scheduledSlots)
    ? draft.scheduledSlots.filter((item): item is string => typeof item === 'string')
    : [];
  const shouldRestoreLegacySlots =
    hasExplicitTimingFields ||
    timingMode === 'once' ||
    (timingMode === 'schedule' && scheduleKind === 'slots');
  const shouldRestoreLegacyRecurrence =
    hasExplicitTimingFields || (timingMode === 'schedule' && scheduleKind === 'recurrence');
  const storedOnceValue = scheduledSlots[0] ? formatLocalDateTimeInputValue(scheduledSlots[0]) : '';
  const [storedOnceDate = '', storedOnceTime = ''] = storedOnceValue.split('T');
  return {
    title: readString(draft.title),
    latePolicy: publicationLatePolicySchema.safeParse(draft.latePolicy).data,
    postPublish: publicationPostPublishSchema.safeParse(draft.postPublish ?? {}).data ?? {
      pin: 'none',
      deleteAfterMinutes: null,
    },
    text: readString(draft.text),
    textFormat: draft.textFormat === 'plain' ? 'plain' : 'markdown',
    images: readImages(draft.images),
    buttons: readButtons(draft.buttons),
    buttonEnabled: draft.buttonEnabled === true,
    targets: readTargets(draft.targets),
    timingMode,
    scheduleKind,
    scheduledSlots: shouldRestoreLegacySlots ? scheduledSlots : [],
    onceDate:
      hasExplicitTimingFields || timingMode === 'once'
        ? readString(draft.onceDate) || storedOnceDate
        : '',
    onceTime:
      hasExplicitTimingFields || timingMode === 'once'
        ? readString(draft.onceTime) || storedOnceTime
        : '',
    scheduleTimezone: readString(draft.scheduleTimezone) || 'Europe/Moscow',
    recurrence: shouldRestoreLegacyRecurrence
      ? readRecurrence(draft.recurrence)
      : safeTimingDefaults,
    mediaType: draft.mediaType === 'video' ? 'video' : null,
    mediaPayload: isObject(draft.mediaPayload) ? draft.mediaPayload : null,
    mediaBase64: readString(draft.mediaBase64),
    mediaMimeType: readString(draft.mediaMimeType),
    mediaFileName: readString(draft.mediaFileName),
    ...(cloudDraft ? { cloudDraft } : {}),
    ...(cloudRequestId ? { cloudRequestId } : {}),
    retainedAssets: Array.isArray(draft.retainedAssets)
      ? draft.retainedAssets.slice(0, MAX_PUBLICATION_IMAGES).flatMap((asset) => {
          const parsed = publicationAssetSchema.safeParse(asset);
          if (!parsed.success) return [];
          const source =
            isObject(asset) && typeof asset.sourcePublicationId === 'string'
              ? asset.sourcePublicationId.trim()
              : cloudDraft?.id;
          return [
            {
              ...parsed.data,
              ...(source && source.length <= 256 ? { sourcePublicationId: source } : {}),
            },
          ];
        })
      : [],
  };
}

function openDraftDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        request.result.createObjectStore(MEDIA_STORE_NAME);
      }
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    request.onsuccess = () => finish(request.result);
  });
}

async function readIndexedState(
  storageKey: string,
): Promise<{ envelope: unknown; mediaEnvelope: unknown }> {
  const db = await openDraftDb();
  if (!db) {
    return { envelope: null, mediaEnvelope: null };
  }
  try {
    return await new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME, MEDIA_STORE_NAME], 'readonly');
      const draftRequest = transaction.objectStore(STORE_NAME).get(storageKey);
      const mediaRequest = transaction.objectStore(MEDIA_STORE_NAME).get(storageKey);
      let envelope: unknown = null;
      let mediaEnvelope: unknown = null;
      draftRequest.onsuccess = () => {
        envelope = draftRequest.result;
      };
      mediaRequest.onsuccess = () => {
        mediaEnvelope = mediaRequest.result;
      };
      const finish = () => {
        db.close();
        resolve({ envelope, mediaEnvelope });
      };
      transaction.oncomplete = finish;
      transaction.onerror = finish;
      transaction.onabort = finish;
    });
  } catch {
    db.close();
    return { envelope: null, mediaEnvelope: null };
  }
}

function readDraftMediaEnvelope(value: unknown): BroadcastImage[] {
  if (!isObject(value) || value.version !== 1) {
    return [];
  }
  return readImages(value.images);
}

function readEnvelopeCandidate(params: {
  envelope: unknown;
  mediaEnvelope?: unknown;
  source: 'indexed' | 'local';
  nowMs: number;
}): { candidate: PublicationDraftCandidate | null; discard: boolean } {
  if (params.envelope === null || params.envelope === undefined) {
    return { candidate: null, discard: false };
  }
  if (!isObject(params.envelope)) {
    return { candidate: null, discard: true };
  }

  const draft = parsePublicationDraftEnvelope(params.envelope);
  const savedAt = readString(params.envelope.savedAt);
  const savedAtMs = Date.parse(savedAt);
  if (
    !draft ||
    !Number.isFinite(savedAtMs) ||
    savedAtMs > params.nowMs + MAX_FUTURE_SAVED_AT_SKEW_MS ||
    params.nowMs - savedAtMs > PUBLICATION_DRAFT_TTL_MS
  ) {
    return { candidate: null, discard: true };
  }

  const usesSeparateMedia = params.envelope.version === 2 || params.envelope.version === 3;
  let images = draft.images;
  let missingImageCount = 0;
  if (usesSeparateMedia) {
    const declaredImageCount =
      typeof params.envelope.imageCount === 'number' &&
      Number.isInteger(params.envelope.imageCount) &&
      params.envelope.imageCount >= 0 &&
      params.envelope.imageCount <= MAX_PUBLICATION_IMAGES
        ? params.envelope.imageCount
        : null;
    const hasImages = params.envelope.hasImages === true || (declaredImageCount ?? 0) > 0;
    images =
      params.source === 'indexed' && hasImages ? readDraftMediaEnvelope(params.mediaEnvelope) : [];
    const expectedImageCount = hasImages ? Math.max(1, declaredImageCount ?? images.length) : 0;
    images = images.slice(0, expectedImageCount);
    missingImageCount = Math.max(0, expectedImageCount - images.length);
  }

  return {
    candidate: {
      draft: { ...draft, images },
      imagesNeedReselection: missingImageCount > 0,
      missingImageCount,
      savedAt,
      savedAtMs,
      source: params.source,
    },
    discard: false,
  };
}

export function resolvePublicationDraftLoadState(params: {
  indexedEnvelope: unknown;
  indexedMediaEnvelope?: unknown;
  localEnvelope: unknown;
  nowMs?: number;
}): PublicationDraftLoadResolution {
  const nowMs = params.nowMs ?? Date.now();
  const indexed = readEnvelopeCandidate({
    envelope: params.indexedEnvelope,
    mediaEnvelope: params.indexedMediaEnvelope,
    source: 'indexed',
    nowMs,
  });
  const local = readEnvelopeCandidate({
    envelope: params.localEnvelope,
    source: 'local',
    nowMs,
  });
  const candidates = [indexed.candidate, local.candidate].filter(
    (candidate): candidate is PublicationDraftCandidate => candidate !== null,
  );
  candidates.sort((left, right) => {
    const savedAtDiff = right.savedAtMs - left.savedAtMs;
    if (savedAtDiff !== 0) {
      return savedAtDiff;
    }
    if (left.imagesNeedReselection !== right.imagesNeedReselection) {
      return Number(left.imagesNeedReselection) - Number(right.imagesNeedReselection);
    }
    return left.source === 'indexed' ? -1 : 1;
  });
  const selected = candidates[0] ?? null;

  return {
    draft: selected?.draft ?? null,
    imagesNeedReselection: selected?.imagesNeedReselection ?? false,
    missingImageCount: selected?.missingImageCount ?? 0,
    savedAt: selected?.savedAt ?? null,
    source: selected?.source ?? null,
    discardIndexed:
      indexed.discard ||
      Boolean(
        selected?.source === 'local' &&
        indexed.candidate &&
        indexed.candidate.savedAtMs < selected.savedAtMs,
      ),
    discardLocal:
      local.discard ||
      Boolean(
        selected?.source === 'indexed' &&
        local.candidate &&
        local.candidate.savedAtMs < selected.savedAtMs,
      ),
  };
}

async function writeIndexedState(
  storageKey: string,
  envelope: DraftEnvelope | null,
  mediaUpdate?: readonly BroadcastImage[] | null,
): Promise<boolean> {
  const db = await openDraftDb();
  if (!db) {
    return false;
  }
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction([STORE_NAME, MEDIA_STORE_NAME], 'readwrite');
      const draftStore = transaction.objectStore(STORE_NAME);
      const mediaStore = transaction.objectStore(MEDIA_STORE_NAME);
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        db.close();
        resolve(success);
      };

      if (envelope) {
        draftStore.put(envelope, storageKey);
      } else {
        draftStore.delete(storageKey);
        mediaStore.delete(storageKey);
      }
      if (envelope && mediaUpdate !== undefined) {
        if (mediaUpdate && mediaUpdate.length > 0) {
          const mediaEnvelope: DraftMediaEnvelope = {
            version: 1,
            images: [...mediaUpdate],
          };
          mediaStore.put(mediaEnvelope, storageKey);
        } else {
          mediaStore.delete(storageKey);
        }
      }
      transaction.oncomplete = () => finish(true);
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    });
  } catch {
    db.close();
    return false;
  }
}

function enqueueDraftStorageMutation(
  storageKey: string,
  mutation: () => Promise<void>,
): Promise<void> {
  const previous = draftStorageQueues.get(storageKey) ?? Promise.resolve();
  const queued = previous.then(mutation, mutation);
  draftStorageQueues.set(storageKey, queued);
  const clearQueue = () => {
    if (draftStorageQueues.get(storageKey) === queued) {
      draftStorageQueues.delete(storageKey);
    }
  };
  void queued.then(clearQueue, clearQueue);
  return queued;
}

function readLocalEnvelope(storageKey: string): unknown {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeLocalEnvelope(storageKey: string, envelope: DraftEnvelope): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    // IndexedDB remains the primary storage in quota-limited WebViews.
  }
}

function removeLocalEnvelope(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable inside a WebView.
  }
}

async function clearUnscopedPublicationDrafts(): Promise<void> {
  const anonymousStorageKey = buildPublicationDraftStorageKey(null);
  removeLocalEnvelope(LEGACY_STORAGE_KEY);
  removeLocalEnvelope(anonymousStorageKey);
  await Promise.all([
    writeIndexedState(LEGACY_STORAGE_KEY, null),
    writeIndexedState(anonymousStorageKey, null),
  ]);
  draftMediaCache.delete(LEGACY_STORAGE_KEY);
  draftMediaCache.delete(anonymousStorageKey);
}

export async function loadPublicationDraft(userId: string): Promise<PublicationDraftLoadState> {
  const storageKey = buildPublicationDraftStorageKey(requirePublicationDraftUserId(userId));
  await draftStorageQueues.get(storageKey);
  await clearUnscopedPublicationDrafts();
  const [indexedState, localEnvelope] = await Promise.all([
    readIndexedState(storageKey),
    Promise.resolve(readLocalEnvelope(storageKey)),
  ]);
  const resolved = resolvePublicationDraftLoadState({
    indexedEnvelope: indexedState.envelope,
    indexedMediaEnvelope: indexedState.mediaEnvelope,
    localEnvelope,
  });

  if (resolved.discardIndexed) {
    await writeIndexedState(storageKey, null);
  }
  if (resolved.discardLocal) {
    removeLocalEnvelope(storageKey);
  }
  if (resolved.source === 'indexed' && resolved.draft && !resolved.imagesNeedReselection) {
    draftMediaCache.set(storageKey, { images: resolved.draft.images, stored: true });
  } else {
    draftMediaCache.delete(storageKey);
  }

  return {
    draft: resolved.draft,
    imagesNeedReselection: resolved.imagesNeedReselection,
    missingImageCount: resolved.missingImageCount,
    savedAt: resolved.savedAt,
    source: resolved.source,
  };
}

export async function savePublicationDraft(
  draft: PublicationDraft,
  userId: string,
  options: { missingImageCount?: number; nowMs?: number } = {},
): Promise<void> {
  const storageKey = buildPublicationDraftStorageKey(requirePublicationDraftUserId(userId));
  const persisted = preparePublicationDraftForIndexedPersistence(draft);
  const requestedMissingImageCount =
    typeof options.missingImageCount === 'number' && Number.isSafeInteger(options.missingImageCount)
      ? Math.max(0, options.missingImageCount)
      : 0;
  const missingImageCount = Math.min(
    requestedMissingImageCount,
    Math.max(0, MAX_PUBLICATION_IMAGES - persisted.images.length),
  );
  const imagesNeedReselection = missingImageCount > 0;
  const hasImages = persisted.hasImages || imagesNeedReselection;
  const envelope: DraftEnvelope = {
    version: STORAGE_VERSION,
    savedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    draft: persisted.draft,
    hasImages,
    imageCount: persisted.images.length + missingImageCount,
  };
  writeLocalEnvelope(storageKey, envelope);

  await enqueueDraftStorageMutation(storageKey, async () => {
    const cachedMedia = draftMediaCache.get(storageKey);
    const mediaChanged =
      imagesNeedReselection || !cachedMedia?.stored || cachedMedia.images !== persisted.images;
    const indexedWriteSucceeded = await writeIndexedState(
      storageKey,
      envelope,
      mediaChanged ? persisted.images : undefined,
    );
    if (indexedWriteSucceeded) {
      draftMediaCache.set(storageKey, { images: persisted.images, stored: true });
    }
    if (!indexedWriteSucceeded) {
      draftMediaCache.delete(storageKey);
    }
  });
}

export async function clearPublicationDraft(userId: string): Promise<void> {
  const storageKey = buildPublicationDraftStorageKey(requirePublicationDraftUserId(userId));
  removeLocalEnvelope(storageKey);
  await enqueueDraftStorageMutation(storageKey, async () => {
    await writeIndexedState(storageKey, null);
    draftMediaCache.delete(storageKey);
  });
}

export async function flushPublicationDraftStorage(userId: string): Promise<void> {
  const storageKey = buildPublicationDraftStorageKey(requirePublicationDraftUserId(userId));
  await draftStorageQueues.get(storageKey);
}
