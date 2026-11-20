import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { setMaxClosingConfirmation } from '../../lib/max-bridge';
import {
  clearPublicationDraft,
  flushPublicationDraftStorage,
  loadPublicationDraft,
  savePublicationDraft,
  type PublicationDraftDeviceCopy,
} from './publication-draft-storage';
import {
  createEmptyPublicationDraft,
  isPublicationDraftEmpty,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';

type PublicationComposerState = {
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  hydrated: boolean;
  hasSavedDraft: boolean;
  imagesNeedReselection: boolean;
  missingImageCount: number;
  persistencePending: boolean;
  replaceDraft: (draft: PublicationDraft, missingImageCount?: number) => void;
  clearDraft: (targets?: PublicationTarget[]) => Promise<void>;
  discardMissingImages: () => void;
  resolveMissingImages: (currentImageCount: number) => void;
  flushDraft: () => Promise<PublicationDraftDeviceCopy>;
  deviceCopyIsCurrent: boolean;
};

export type PublicationImageRecoveryState = {
  missingImageCount: number;
  expectedImageCount: number | null;
};

export function createPublicationImageRecoveryState(
  missingImageCount: number,
  currentImageCount: number,
): PublicationImageRecoveryState {
  const normalizedMissingImageCount = Number.isSafeInteger(missingImageCount)
    ? Math.max(0, missingImageCount)
    : 0;
  const normalizedCurrentImageCount = Number.isSafeInteger(currentImageCount)
    ? Math.max(0, currentImageCount)
    : 0;
  return {
    missingImageCount: normalizedMissingImageCount,
    expectedImageCount:
      normalizedMissingImageCount > 0
        ? normalizedCurrentImageCount + normalizedMissingImageCount
        : null,
  };
}

export function resolvePublicationImageRecoveryState(
  recovery: PublicationImageRecoveryState,
  currentImageCount: number,
): PublicationImageRecoveryState {
  if (recovery.expectedImageCount === null) {
    return createPublicationImageRecoveryState(0, currentImageCount);
  }
  const normalizedCurrentImageCount = Number.isSafeInteger(currentImageCount)
    ? Math.max(0, currentImageCount)
    : 0;
  return createPublicationImageRecoveryState(
    Math.max(0, recovery.expectedImageCount - normalizedCurrentImageCount),
    normalizedCurrentImageCount,
  );
}

export function usePublicationComposer(
  editorOpen: boolean,
  persistenceEnabled = true,
  enabled = true,
  pendingWork = false,
  userId: string | null = null,
): PublicationComposerState {
  const [draft, setDraft] = useState<PublicationDraft>(() => createEmptyPublicationDraft());
  const [hydrated, setHydrated] = useState(false);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const [missingImageCount, setMissingImageCount] = useState(0);
  const [persistencePending, setPersistencePending] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const persistenceOperationRef = useRef<Promise<unknown>>(Promise.resolve());
  const [deviceCopy, setDeviceCopy] = useState<{
    draft: PublicationDraft;
    result: PublicationDraftDeviceCopy;
  } | null>(null);
  const mountedRef = useRef(true);
  const draftRef = useRef(draft);
  const missingImageCountRef = useRef(missingImageCount);
  const missingImageRecoveryRef = useRef<{ expectedImageCount: number } | null>(null);
  const hydratedRef = useRef(hydrated);
  const persistenceEnabledRef = useRef(persistenceEnabled);
  const normalizedUserId = enabled ? userId?.trim() || null : null;

  draftRef.current = draft;
  missingImageCountRef.current = missingImageCount;
  hydratedRef.current = hydrated;
  persistenceEnabledRef.current = persistenceEnabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateMissingImageRecovery = useCallback(
    (nextMissingImageCount: number, currentImageCount: number) => {
      const recovery = createPublicationImageRecoveryState(
        nextMissingImageCount,
        currentImageCount,
      );
      setMissingImageCount(recovery.missingImageCount);
      missingImageCountRef.current = recovery.missingImageCount;
      missingImageRecoveryRef.current =
        recovery.expectedImageCount === null
          ? null
          : { expectedImageCount: recovery.expectedImageCount };
    },
    [],
  );

  const replaceDraft = useCallback(
    (nextDraft: PublicationDraft, nextMissingImageCount = 0) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      updateMissingImageRecovery(nextMissingImageCount, nextDraft.images.length);
    },
    [updateMissingImageRecovery],
  );

  const trackPersistence = useCallback(<T>(operation: Promise<T>): Promise<T> => {
    persistenceOperationRef.current = operation;
    if (mountedRef.current) {
      setPersistencePending(true);
    }
    const settle = () => {
      if (mountedRef.current && persistenceOperationRef.current === operation) {
        setPersistencePending(false);
      }
    };
    void operation.then(settle, settle);
    return operation;
  }, []);

  const persistSnapshot = useCallback(
    async (
      snapshot: PublicationDraft,
      missingImages: number,
    ): Promise<PublicationDraftDeviceCopy> => {
      if (!normalizedUserId) {
        return 'unavailable';
      }
      const hasDraft = missingImages > 0 || !isPublicationDraftEmpty(snapshot);
      const operation = trackPersistence(
        hasDraft
          ? savePublicationDraft(snapshot, normalizedUserId, {
              missingImageCount: missingImages,
            })
          : clearPublicationDraft(normalizedUserId).then(() => 'complete' as const),
      );
      const result = await operation.catch(() => 'unavailable' as const);
      if (mountedRef.current && persistenceOperationRef.current === operation) {
        setHasSavedDraft(hasDraft && result !== 'unavailable');
        setDeviceCopy(hasDraft ? { draft: snapshot, result } : null);
      }
      return result;
    },
    [normalizedUserId, trackPersistence],
  );

  const flushDraft = useCallback(async (): Promise<PublicationDraftDeviceCopy> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (normalizedUserId && hydratedRef.current && persistenceEnabledRef.current) {
      return persistSnapshot(draftRef.current, missingImageCountRef.current);
    }
    await persistenceOperationRef.current.catch(() => undefined);
    if (normalizedUserId) {
      await flushPublicationDraftStorage(normalizedUserId).catch(() => undefined);
    }
    return 'unavailable';
  }, [normalizedUserId, persistSnapshot]);

  useEffect(() => {
    if (!enabled || !normalizedUserId) {
      replaceDraft(createEmptyPublicationDraft());
      setHasSavedDraft(false);
      setDeviceCopy(null);
      setHydrated(true);
      return undefined;
    }

    replaceDraft(createEmptyPublicationDraft());
    setHasSavedDraft(false);
    setDeviceCopy(null);
    setHydrated(false);
    let cancelled = false;
    void loadPublicationDraft(normalizedUserId)
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (stored.draft) {
          replaceDraft(stored.draft, stored.missingImageCount);
          setHasSavedDraft(stored.missingImageCount > 0 || !isPublicationDraftEmpty(stored.draft));
        }
        setHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedUserId, replaceDraft]);

  useEffect(() => {
    if (!enabled || !normalizedUserId || !hydrated || !persistenceEnabled) {
      return undefined;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistSnapshot(draft, missingImageCount);
    }, 350);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    draft,
    enabled,
    hydrated,
    missingImageCount,
    normalizedUserId,
    persistenceEnabled,
    persistSnapshot,
  ]);

  useEffect(() => {
    if (!enabled || !normalizedUserId) {
      return undefined;
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        void flushDraft();
      }
    };
    const flushOnPageHide = () => {
      void flushDraft();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, [enabled, flushDraft, normalizedUserId]);

  const imagesNeedReselection = missingImageCount > 0;
  const hasDraft = imagesNeedReselection || !isPublicationDraftEmpty(draft);
  const shouldProtectClose =
    enabled && ((editorOpen && (pendingWork || hasDraft)) || persistencePending);
  useEffect(() => {
    setMaxClosingConfirmation(shouldProtectClose);
    if (!shouldProtectClose) {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      void flushDraft();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      setMaxClosingConfirmation(false);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushDraft, shouldProtectClose]);

  const clearDraft = useCallback(
    async (targets: PublicationTarget[] = []) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      replaceDraft(createEmptyPublicationDraft(targets));
      setHasSavedDraft(false);
      setDeviceCopy(null);
      if (normalizedUserId) {
        await trackPersistence(clearPublicationDraft(normalizedUserId));
      }
    },
    [normalizedUserId, replaceDraft, trackPersistence],
  );

  const discardMissingImages = useCallback(() => {
    updateMissingImageRecovery(0, draftRef.current.images.length);
  }, [updateMissingImageRecovery]);

  const resolveMissingImages = useCallback(
    (currentImageCount: number) => {
      const expectedImageCount = missingImageRecoveryRef.current?.expectedImageCount ?? null;
      if (expectedImageCount === null) {
        return;
      }
      const recovery = resolvePublicationImageRecoveryState(
        {
          missingImageCount: missingImageCountRef.current,
          expectedImageCount,
        },
        currentImageCount,
      );
      updateMissingImageRecovery(recovery.missingImageCount, currentImageCount);
    },
    [updateMissingImageRecovery],
  );

  return {
    draft,
    setDraft,
    hydrated,
    hasSavedDraft,
    imagesNeedReselection,
    missingImageCount,
    persistencePending,
    deviceCopyIsCurrent: deviceCopy?.draft === draft && deviceCopy.result === 'complete',
    replaceDraft,
    clearDraft,
    discardMissingImages,
    resolveMissingImages,
    flushDraft,
  };
}
