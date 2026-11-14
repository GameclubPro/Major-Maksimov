import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import { savePublicationDraft } from './publication-draft-storage';
import { PublicationDraftAutosave, type DraftSaveState } from './publication-draft-autosave';
import type { PublicationDraft } from './publication-model';

export function usePublicationCloudDraft(options: {
  api: ApiTransport;
  userId: string;
  sessionKey: object | null;
  enabled: boolean;
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  persistLocal: boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<DraftSaveState>({ status: 'idle', error: null });
  const controller = useMemo(() => {
    if (!options.sessionKey) return null;
    return new PublicationDraftAutosave(latest.current.draft, {
      save: async (id, request) =>
        (await import('../../lib/api/publication-drafts-client')).saveServerPublicationDraft(
          options.api,
          id,
          request,
        ),
      remove: async (id, request) =>
        (await import('../../lib/api/publication-drafts-client')).deleteServerPublicationDraft(
          options.api,
          id,
          request,
        ),
      find: async (id) =>
        (await import('../../lib/api/publication-drafts-client')).findServerPublicationDraft(
          options.api,
          id,
        ),
      get: async (id) =>
        (await import('../../lib/api/publication-drafts-client')).getServerPublicationDraft(
          options.api,
          id,
        ),
      persist: (draft) =>
        latest.current.persistLocal
          ? savePublicationDraft(draft, options.userId)
          : Promise.resolve(),
      changed: (draft) => latest.current.setDraft(draft),
      stateChanged: setState,
      canSave: () => latest.current.enabled,
    });
  }, [options.api, options.sessionKey, options.userId]);
  controller?.setSnapshot(options.draft);
  useEffect(() => {
    controller?.activate();
    setState({ status: 'idle', error: null });
    return () => controller?.dispose();
  }, [controller]);
  useEffect(() => {
    if (
      !controller ||
      !options.enabled ||
      state.status === 'conflict' ||
      state.status === 'unavailable' ||
      state.status === 'error' ||
      !controller.dirty
    )
      return;
    const timer = window.setTimeout(() => {
      void controller.flush().catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [controller, options.draft, options.enabled, state.status]);
  const flush = useCallback(() => {
    if (controller && !latest.current.enabled)
      return Promise.reject(new Error('Завершите подготовку или восстановление медиа.'));
    return controller ? controller.flush() : Promise.resolve(latest.current.draft);
  }, [controller]);
  return {
    ...state,
    flush,
    discard: () => controller?.discard(),
    reload: () => controller?.reload(),
    saveCopy: () => controller?.saveCopy(),
    markConflict: (error: unknown) => controller?.markConflict(error),
    dirty: controller?.dirty ?? false,
  };
}
