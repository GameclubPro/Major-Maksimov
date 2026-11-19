import type { PublisherPostImportWarning } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import { useEffect, useRef, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import {
  cancelPublisherPostImport,
  createPublisherPostImport,
  getActivePublisherPostImport,
  getPublisherPostImportByToken,
} from '../../lib/api/publisher-post-import-client';
import { maxImpact, maxNotify, openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { useToast } from '../../components/ui/toast';
import { createPublicationRequestId } from './publication-request-identity';
import { resolvePublisherPostImportDraftContext } from './publisher-post-import-model';
import type { PublisherPostImportStatusProps } from './publisher-post-import-status';
import {
  isPublisherDraftRouteId,
  isPublisherPostImportRouteToken,
  resolvePublisherPostImportRouteCleanup,
  STALE_IMPORT_ROUTE_KEYS,
} from './publisher-post-import-route';

const ACTIVE_IMPORT_QUERY_KEY = ['publisher', 'post-imports', 'active'] as const;
const SERVER_DRAFTS_QUERY_KEY = ['publications', 'list', 'drafts'] as const;

type ReplaceSearchParams = (next: URLSearchParams, options: { replace: boolean }) => void;

type PublisherPostImportControllerOptions = {
  api: ApiTransport;
  enabled: boolean;
  editorOpen: boolean;
  hydrated: boolean;
  openingDraft: boolean;
  searchParams: URLSearchParams;
  setSearchParams: ReplaceSearchParams;
  onOpenDraft: (
    publicationId: string,
    sessionId: string | null,
    omissions: PublisherPostImportOmission[],
    warnings?: PublisherPostImportWarning[],
  ) => void;
};

function tokenQueryKey(token: string) {
  return ['publisher', 'post-imports', 'token', token] as const;
}

export function usePublisherPostImportController({
  api,
  enabled,
  editorOpen,
  hydrated,
  openingDraft,
  searchParams,
  setSearchParams,
  onOpenDraft,
}: PublisherPostImportControllerOptions) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const autoOpenedImportRef = useRef<string | null>(null);
  const onOpenDraftRef = useRef(onOpenDraft);
  onOpenDraftRef.current = onOpenDraft;

  const routeToken = searchParams.get('import');
  const validRouteToken = isPublisherPostImportRouteToken(routeToken) ? routeToken : null;
  const activeImportQuery = useQuery({
    queryKey: ACTIVE_IMPORT_QUERY_KEY,
    queryFn: ({ signal }) => getActivePublisherPostImport(api, { signal }),
    enabled: enabled && !editorOpen && routeToken === null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.session?.status;
      return status === 'waiting' || status === 'processing' ? 1_200 : false;
    },
  });
  const routeImportQuery = useQuery({
    queryKey: tokenQueryKey(validRouteToken ?? ''),
    queryFn: ({ signal }) => getPublisherPostImportByToken(api, validRouteToken ?? '', { signal }),
    enabled: enabled && !editorOpen && validRouteToken !== null,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const status = query.state.data?.session?.status;
      return status === 'waiting' || status === 'processing' ? 1_200 : false;
    },
  });
  const displayedSession =
    routeToken !== null
      ? (routeImportQuery.data?.session ?? null)
      : (activeImportQuery.data?.session ?? null);

  useEffect(() => {
    if (
      enabled &&
      hydrated &&
      !editorOpen &&
      searchParams.get('create') === '1' &&
      !searchParams.has('import') &&
      !searchParams.has('draft')
    ) {
      setCreateSheetOpen(true);
    }
  }, [editorOpen, enabled, hydrated, searchParams]);

  const createMutation = useMutation({
    mutationFn: (requestId: string) =>
      createPublisherPostImport(api, { requestId, inputMode: 'message' }),
    onSuccess: (session) => {
      pendingRequestIdRef.current = null;
      setCreateSheetOpen(false);
      queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session });
      if (routeToken !== null && session.id !== displayedSession?.id) {
        removeRouteParams(searchParams, setSearchParams, ['import', 'draft']);
      }
      if (session.status === 'waiting') {
        if (!session.botUrl || !openMaxBotLinkAndClose(session.botUrl)) {
          pushToast({ tone: 'danger', title: 'Не удалось открыть диалог Публика' });
        }
      } else if (session.status === 'ready' && session.publicationId) {
        onOpenDraftRef.current(
          session.publicationId,
          session.id,
          session.omissions,
          session.warnings,
        );
      }
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось начать перенос'),
      });
      maxNotify('error');
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelPublisherPostImport(api),
    onSuccess: () => {
      queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
      pendingRequestIdRef.current = null;
      maxImpact('soft');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отменить перенос'),
      });
    },
  });

  useEffect(() => {
    if (!enabled || editorOpen) {
      return undefined;
    }
    const refresh = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: SERVER_DRAFTS_QUERY_KEY });
      if (validRouteToken) {
        void routeImportQuery.refetch();
      } else {
        void activeImportQuery.refetch();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [
    activeImportQuery.refetch,
    editorOpen,
    enabled,
    routeImportQuery.refetch,
    queryClient,
    validRouteToken,
  ]);

  useEffect(() => {
    if (!enabled || !hydrated || editorOpen) {
      return;
    }
    const draftId = searchParams.get('draft');
    if (routeToken === null && draftId === null) {
      autoOpenedImportRef.current = null;
      return;
    }
    const session = displayedSession;
    const cleanupKeys = resolvePublisherPostImportRouteCleanup({
      draftId,
      exactQueryResolved: routeImportQuery.isSuccess,
      hasExactSession: session !== null && session !== undefined,
      importToken: routeToken,
    });
    if (cleanupKeys.length > 0) {
      removeRouteParams(searchParams, setSearchParams, cleanupKeys);
      return;
    }
    const importLookupPending =
      isPublisherDraftRouteId(draftId) &&
      ((validRouteToken !== null && routeImportQuery.isPending) ||
        (routeToken === null && activeImportQuery.isPending));
    if (importLookupPending) {
      return;
    }
    const publicationId = isPublisherDraftRouteId(draftId)
      ? draftId
      : session?.status === 'ready' && session.publicationId
        ? session.publicationId
        : null;
    if (!publicationId || openingDraft) {
      return;
    }
    const autoOpenKey = `${routeToken ?? ''}:${publicationId}`;
    if (autoOpenedImportRef.current === autoOpenKey) {
      return;
    }
    autoOpenedImportRef.current = autoOpenKey;
    const context = resolvePublisherPostImportDraftContext(session, publicationId);
    onOpenDraftRef.current(
      publicationId,
      context.sessionId,
      context.omissions,
      context.sessionId ? session?.warnings : undefined,
    );
  }, [
    activeImportQuery.isPending,
    editorOpen,
    enabled,
    hydrated,
    openingDraft,
    displayedSession,
    routeImportQuery.isPending,
    routeImportQuery.isSuccess,
    routeToken,
    searchParams,
    setSearchParams,
    validRouteToken,
  ]);

  function showCreateSheet() {
    setCreateSheetOpen(true);
    maxImpact('soft');
  }

  function hideCreateSheet() {
    setCreateSheetOpen(false);
  }

  function closeCreateSheet(): boolean {
    if (createMutation.isPending) {
      return false;
    }
    setCreateSheetOpen(false);
    pendingRequestIdRef.current = null;
    clearCreateRoute();
    return true;
  }

  function startImport() {
    if (createMutation.isPending) {
      return;
    }
    const requestId = pendingRequestIdRef.current ?? createPublicationRequestId();
    pendingRequestIdRef.current = requestId;
    clearCreateRoute();
    createMutation.mutate(requestId);
    maxImpact('soft');
  }

  function clearCreateRoute() {
    if (searchParams.has('create')) {
      removeRouteParams(searchParams, setSearchParams, ['create']);
    }
  }

  async function finishPublishedImport() {
    queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
    await queryClient.invalidateQueries({ queryKey: ACTIVE_IMPORT_QUERY_KEY });
    if (validRouteToken) {
      queryClient.setQueryData(tokenQueryKey(validRouteToken), { session: null });
      await queryClient.invalidateQueries({ queryKey: tokenQueryKey(validRouteToken) });
    }
  }

  function dismissStaleImport() {
    removeRouteParams(searchParams, setSearchParams, STALE_IMPORT_ROUTE_KEYS);
    queryClient.setQueryData(ACTIVE_IMPORT_QUERY_KEY, { session: null });
    void queryClient.invalidateQueries({ queryKey: ACTIVE_IMPORT_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: SERVER_DRAFTS_QUERY_KEY });
  }

  const lookup = validRouteToken ? routeImportQuery : activeImportQuery;
  const statusProps: PublisherPostImportStatusProps = {
    readError:
      lookup.isError && !displayedSession ? 'Не удалось загрузить состояние переноса' : null,
    onReadRetry: () => void lookup.refetch(),
    session: displayedSession,
    drafts: [],
    busy: createMutation.isPending || cancelMutation.isPending || openingDraft,
    onOpenBot(botUrl) {
      if (!openMaxBotLinkAndClose(botUrl)) {
        pushToast({ tone: 'info', title: 'Не удалось открыть диалог Публика' });
      }
    },
    onOpenDraft(publicationId) {
      const context = resolvePublisherPostImportDraftContext(displayedSession, publicationId);
      onOpenDraftRef.current(
        publicationId,
        context.sessionId,
        context.omissions,
        context.sessionId ? displayedSession?.warnings : undefined,
      );
    },
    onRetry: startImport,
    onCancel: () => cancelMutation.mutate(),
  };

  return {
    closeCreateSheet,
    createPending: createMutation.isPending,
    createSheetOpen,
    dismissStaleImport,
    finishPublishedImport,
    hasImportRoute: searchParams.has('import') || searchParams.has('draft'),
    hideCreateSheet,
    showCreateSheet,
    startImport,
    statusProps,
  };
}

function removeRouteParams(
  searchParams: URLSearchParams,
  setSearchParams: ReplaceSearchParams,
  keys: readonly string[],
) {
  const next = new URLSearchParams(searchParams);
  keys.forEach((key) => next.delete(key));
  setSearchParams(next, { replace: true });
}
