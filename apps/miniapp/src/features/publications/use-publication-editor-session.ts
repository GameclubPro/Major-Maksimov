import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { PublicationSummary } from '@maxim/contracts/publication';
import type { PublisherPostImportOmission } from '@maxim/contracts/publisher';
import type { ApiTransport } from '../../lib/api/transport';
import { getPublication } from '../../lib/api/publication-client';
import { useToast } from '../../components/ui/toast';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { maxImpact } from '../../lib/max-bridge';
import { usePublicationComposer } from './use-publication-composer';
import { usePublicationCloudDraft } from './use-publication-cloud-draft';
import { usePublicationEditorAutofocus } from './use-publication-editor-autofocus';
import { usePublisherPostImportController } from './use-publisher-post-import-controller';
import { isPublisherDraftRouteId } from './publisher-post-import-route';
import { stripPublisherOnlyPublicationRouteParams } from './publication-page-options';
import { draftFromServer } from './publication-cloud-draft-model';
import { resolvePublicationDraftLatePolicy } from './publication-late-policy-presentation';
import {
  shouldPersistPublicationDraft,
  type PublicationEditorContext,
  type PublicationDraft,
  createEmptyPublicationDraft,
  createPublicationDuplicateDraft,
  createPublicationDraftFromDetails,
  canPreservePublicationSchedule,
  getPublicationActionCapabilities,
  rebasePublicationDraft,
  publicationDraftNeedsVideoReselection,
  hasPublicationDraftChanges,
  isIsolatedPublicationEditor,
} from './publication-model';

export function usePublicationEditorSession({
  api,
  userId,
  isPublisherProfile,
  mediaPreparing,
  videoPreparing,
  onOpen,
}: {
  api: ApiTransport;
  userId: string;
  isPublisherProfile: boolean;
  mediaPreparing: boolean;
  videoPreparing: boolean;
  onOpen(): void;
}) {
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorContext, setEditorContext] = useState<PublicationEditorContext | null>(null);

  const [editorClosePending, setEditorClosePending] = useState(false);
  const isEditor = isPublisherProfile && editorContext !== null;
  const persistenceEnabled = shouldPersistPublicationDraft(editorContext?.kind ?? null);
  const {
    draft,
    setDraft,
    hydrated,
    hasSavedDraft,
    imagesNeedReselection,
    missingImageCount,
    replaceDraft,
    clearDraft,
    discardMissingImages,
    resolveMissingImages,
    flushDraft,
  } = usePublicationComposer(
    isEditor,
    persistenceEnabled,
    isPublisherProfile,
    mediaPreparing || videoPreparing,
    userId,
  );
  const savedCreateDraftRef = useRef<{
    draft: PublicationDraft;
    missingImageCount: number;
  } | null>(null);
  const isolatedDraftBaselineRef = useRef<PublicationDraft | null>(null);
  const initialComposeRouteAppliedRef = useRef(false);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const editorReturnPublicationIdRef = useRef<string | null>(null);
  const editorTitleRef = useRef<HTMLHeadingElement | null>(null);
  const [buttonsOpen, setButtonsOpen] = useState(false);
  const [previewTargetKey, setPreviewTargetKey] = useState<string | null>(null);
  const [importOmissions, setImportOmissions] = useState<PublisherPostImportOmission[]>([]);
  const [fieldError, setFieldError] = useState('');
  const [validationStarted, setValidationStarted] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);
  const [timingPreparing, setTimingPreparing] = useState(false);
  const [pendingConflict, setPendingConflict] = useState(false);
  const [pendingEditorClose, setPendingEditorClose] = useState(false);
  const [pendingDraftClear, setPendingDraftClear] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [cloudReloadConfirm, setCloudReloadConfirm] = useState(false);
  const [revisionConflictPublicationId, setRevisionConflictPublicationId] = useState<string | null>(
    null,
  );

  const cloudDraft = usePublicationCloudDraft({
    api,
    userId,
    draft,
    setDraft,
    persistLocal: persistenceEnabled,
    sessionKey: isEditor && editorContext?.kind !== 'edit' ? editorContext : null,
    enabled:
      hydrated &&
      !draftsOpen &&
      !pendingDraftClear &&
      !mediaPreparing &&
      !videoPreparing &&
      !imagesNeedReselection &&
      !publicationDraftNeedsVideoReselection(draft),
  });

  const discardDraftMutation = useMutation({
    mutationFn: async () => {
      const id = draft.cloudDraft?.id;
      await cloudDraft.discard();
      return id;
    },
    onSuccess: (id) => {
      setPendingDraftClear(false);
      setImportOmissions([]);
      setFieldError('');
      setValidationStarted(false);
      if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
        finishIsolatedPublication(id ?? '');
      } else {
        void clearDraft();
      }
    },
  });

  const openPublicationMutation = useMutation({
    mutationFn: ({
      publicationId,
      mode,
      sessionId,
      omissions,
    }: {
      publicationId: string;
      mode: 'edit' | 'duplicate' | 'import' | 'draft' | 'draft-copy';
      sessionId?: string | null;
      omissions?: PublisherPostImportOmission[];
    }) =>
      (mode === 'draft' || mode === 'draft-copy' || mode === 'import'
        ? import('../../lib/api/publication-drafts-client')
            .then((client) => client.getServerPublicationDraft(api, publicationId))
            .then((response) => ({
              details: response.publication,
              serverDraft: draftFromServer(response),
            }))
        : getPublication(api, publicationId).then((details) => ({ details, serverDraft: null }))
      ).then(({ details, serverDraft }) => {
        if (mode === 'import' && details.lifecycle !== 'DRAFT') {
          throw new Error('Этот черновик уже опубликован');
        }
        return {
          details,
          serverDraft,
          mode,
          sessionId: sessionId ?? null,
          omissions: omissions ?? [],
        };
      }),
    onSuccess: ({ details, serverDraft, mode, sessionId, omissions }) => {
      savedCreateDraftRef.current = { draft, missingImageCount };
      const sourceDraft = serverDraft ?? createPublicationDraftFromDetails(details);
      const isolatedDraft =
        mode === 'duplicate' || mode === 'draft-copy'
          ? {
              ...createPublicationDuplicateDraft(sourceDraft),
              cloudDraft: undefined,
              cloudRequestId: undefined,
            }
          : sourceDraft;
      isolatedDraftBaselineRef.current = isolatedDraft;
      replaceDraft(isolatedDraft);
      setEditorContext(
        mode === 'edit'
          ? {
              kind: 'edit',
              publicationId: details.id,
              expectedRevision: details.version,
              editScope: getPublicationActionCapabilities(details).editScope,
            }
          : mode === 'draft'
            ? { kind: 'draft', publicationId: details.id, expectedRevision: details.version }
            : mode === 'import'
              ? {
                  kind: 'import',
                  publicationId: details.id,
                  expectedRevision: details.version,
                  sessionId,
                }
              : { kind: 'duplicate' },
      );
      setImportOmissions(mode === 'import' ? omissions : []);
      onOpen();
      setDraftsOpen(false);
      setPendingEditorClose(false);
      setFieldError('');
      setValidationStarted(false);
      setComposeRoute(true, {
        importDraftId: mode === 'import' ? details.id : null,
      });
    },
    onError: (error, variables) => {
      if (variables.mode === 'import') {
        postImport.dismissStaleImport();
      }
      editorReturnFocusRef.current = null;
      editorReturnPublicationIdRef.current = null;
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось открыть публикацию'),
      });
    },
  });
  const postImport = usePublisherPostImportController({
    api,
    enabled: isPublisherProfile,
    editorOpen: isEditor,
    hydrated,
    openingDraft: openPublicationMutation.isPending,
    searchParams,
    setSearchParams,
    onOpenDraft: openImportedDraft,
  });
  const refreshEditedPublicationMutation = useMutation({
    mutationFn: (publicationId: string) => getPublication(api, publicationId),
    onSuccess: (details) => {
      const latestDraft = createPublicationDraftFromDetails(details);
      const baseline = isolatedDraftBaselineRef.current;
      setDraft((current) =>
        baseline ? rebasePublicationDraft(baseline, current, latestDraft) : latestDraft,
      );
      isolatedDraftBaselineRef.current = latestDraft;
      setEditorContext((current) =>
        current?.kind === 'import'
          ? {
              ...current,
              publicationId: details.id,
              expectedRevision: details.version,
            }
          : {
              kind: 'edit',
              publicationId: details.id,
              expectedRevision: details.version,
              editScope: current?.kind === 'edit' ? current.editScope : null,
            },
      );
      setRevisionConflictPublicationId(null);
      setFieldError('');
      setValidationStarted(false);
      pushToast({ tone: 'info', title: 'Правки перенесены в актуальную версию' });
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обновить публикацию'),
      }),
  });

  useEffect(() => {
    document.body.classList.toggle('publications-editor-open', isEditor);
    const bottomNav = document.querySelector<HTMLElement>('.app-shell > .bottom-nav');
    const previousBottomNavInert = bottomNav?.inert ?? false;
    const previousBottomNavAriaHidden = bottomNav?.getAttribute('aria-hidden') ?? null;
    if (isEditor && bottomNav) {
      bottomNav.inert = true;
      bottomNav.setAttribute('aria-hidden', 'true');
    }

    return () => {
      document.body.classList.remove('publications-editor-open');
      if (!bottomNav) {
        return;
      }
      bottomNav.inert = previousBottomNavInert;
      if (previousBottomNavAriaHidden === null) {
        bottomNav.removeAttribute('aria-hidden');
      } else {
        bottomNav.setAttribute('aria-hidden', previousBottomNavAriaHidden);
      }
    };
  }, [isEditor]);

  useEffect(() => {
    if (!isPublisherProfile || !hydrated || initialComposeRouteAppliedRef.current) {
      return;
    }
    initialComposeRouteAppliedRef.current = true;
    if (searchParams.get('compose') === '1' && !postImport.hasImportRoute) {
      setEditorContext({ kind: 'create' });
      setImportOmissions([]);
    }
  }, [hydrated, isPublisherProfile, postImport.hasImportRoute, searchParams]);

  useEffect(() => {
    const next = isPublisherProfile ? null : stripPublisherOnlyPublicationRouteParams(searchParams);
    if (!next) {
      return;
    }
    setSearchParams(next, { replace: true });
  }, [isPublisherProfile, searchParams, setSearchParams]);

  usePublicationEditorAutofocus(isEditor, editorTitleRef);
  function setComposeRoute(open: boolean, options: { importDraftId?: string | null } = {}) {
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    if (!open) {
      next.delete('import');
      next.delete('draft');
    } else if (isPublisherDraftRouteId(options.importDraftId)) {
      next.set('draft', options.importDraftId);
    }
    if (open) {
      next.set('compose', '1');
    } else {
      next.delete('compose');
    }
    setSearchParams(next, { replace: true });
  }

  function rememberEditorReturnFocus(publicationId: string | null = null) {
    editorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editorReturnPublicationIdRef.current = publicationId;
  }

  function restoreEditorReturnFocus() {
    const previousFocus = editorReturnFocusRef.current;
    const publicationId = editorReturnPublicationIdRef.current;
    editorReturnFocusRef.current = null;
    editorReturnPublicationIdRef.current = null;
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) {
        previousFocus.focus();
        return;
      }
      if (!publicationId) {
        return;
      }
      const card = Array.from(
        document.querySelectorAll<HTMLElement>('.publication-feed-card[data-publication-id]'),
      ).find((candidate) => candidate.dataset.publicationId === publicationId);
      card
        ?.querySelector<HTMLElement>(
          '.publication-feed-card__menu-trigger, .publication-feed-card__surface',
        )
        ?.focus();
    });
  }

  function openPublicationEditor(publication: PublicationSummary, mode: 'edit' | 'duplicate') {
    if (!isPublisherProfile) {
      return;
    }
    rememberEditorReturnFocus(publication.id);
    openPublicationMutation.mutate({ publicationId: publication.id, mode });
  }

  function openImportedDraft(
    publicationId: string,
    sessionId: string | null = null,
    omissions: PublisherPostImportOmission[] = [],
  ) {
    if (!isPublisherProfile || !hydrated || openPublicationMutation.isPending) {
      return;
    }
    if (!editorReturnFocusRef.current) {
      rememberEditorReturnFocus(publicationId);
    }
    openPublicationMutation.mutate({ publicationId, mode: 'import', sessionId, omissions });
  }

  function requestCreateEditor() {
    if (!isPublisherProfile) {
      return;
    }
    rememberEditorReturnFocus();
    postImport.showCreateSheet();
  }

  function closeCreateSheet() {
    if (!postImport.closeCreateSheet()) {
      return;
    }
    editorReturnFocusRef.current = null;
    editorReturnPublicationIdRef.current = null;
  }

  function openCreateEditor() {
    if (!isPublisherProfile) {
      return;
    }
    if (!editorReturnFocusRef.current) {
      rememberEditorReturnFocus();
    }
    postImport.hideCreateSheet();
    setEditorContext({ kind: 'create' });
    setImportOmissions([]);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(true);
    maxImpact('soft');
  }

  function requestCloseEditor(preserveDraft: boolean, isBusy: boolean) {
    if (isBusy) {
      return;
    }
    setEditorClosePending(true);
    void cloudDraft
      .flush()
      .then(async (snapshot) => {
        if (editorContext?.kind !== 'edit') {
          replaceDraft(snapshot, missingImageCount);
          if (
            savedCreateDraftRef.current?.draft.cloudDraft?.id === snapshot.cloudDraft?.id &&
            snapshot.cloudDraft
          )
            savedCreateDraftRef.current = { draft: snapshot, missingImageCount };
        }
        await flushDraft();
        const baseline = isolatedDraftBaselineRef.current;
        if (
          editorContext?.kind === 'edit' &&
          baseline &&
          hasPublicationDraftChanges(baseline, draft)
        ) {
          setPendingEditorClose(true);
          return;
        }
        closeEditor(preserveDraft);
      })
      .catch(async () => {
        await flushDraft();
        if (persistenceEnabled) {
          closeEditor(true);
          pushToast({
            tone: 'info',
            title: 'Не удалось сохранить изменения',
          });
        } else {
          setPendingEditorClose(true);
        }
      })
      .finally(() => setEditorClosePending(false));
  }

  function closeEditor(preserveDraft: boolean) {
    if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
      restoreCreateDraftAndClose();
      return;
    }
    setEditorContext(null);
    setImportOmissions([]);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setPendingEditorClose(false);
    setPendingDraftClear(false);
    setRevisionConflictPublicationId(null);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(false);
    if (!preserveDraft) {
      savedCreateDraftRef.current = null;
    }
    isolatedDraftBaselineRef.current = null;
    restoreEditorReturnFocus();
  }

  function restoreCreateDraftAndClose() {
    const savedCreateDraft = savedCreateDraftRef.current;
    replaceDraft(
      savedCreateDraft?.draft ?? createEmptyPublicationDraft(),
      savedCreateDraft?.missingImageCount ?? 0,
    );
    savedCreateDraftRef.current = null;
    isolatedDraftBaselineRef.current = null;
    setEditorContext(null);
    setImportOmissions([]);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setPendingEditorClose(false);
    setPendingDraftClear(false);
    setRevisionConflictPublicationId(null);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(false);
    restoreEditorReturnFocus();
  }

  function forgetDeletedDraft(publicationId: string) {
    if (savedCreateDraftRef.current?.draft.cloudDraft?.id === publicationId)
      savedCreateDraftRef.current = null;
    if (draft.cloudDraft?.id === publicationId) void clearDraft();
  }

  // FLAG: A published isolated draft cannot restore the same cloud draft as a pending create.
  function finishIsolatedPublication(publicationId: string) {
    if (savedCreateDraftRef.current?.draft.cloudDraft?.id === publicationId)
      savedCreateDraftRef.current = null;
    restoreCreateDraftAndClose();
  }
  return {
    editorContext,
    isEditor,
    draft,
    setDraft,
    hydrated,
    hasSavedDraft,
    imagesNeedReselection,
    missingImageCount,
    replaceDraft,
    clearDraft,
    discardMissingImages,
    resolveMissingImages,
    editorClosePending,
    setEditorClosePending,
    editorTitleRef,
    buttonsOpen,
    setButtonsOpen,
    previewTargetKey,
    setPreviewTargetKey,
    importOmissions,
    setImportOmissions,
    fieldError,
    setFieldError,
    validationStarted,
    setValidationStarted,
    pendingReview,
    setPendingReview,
    timingPreparing,
    setTimingPreparing,
    pendingConflict,
    setPendingConflict,
    pendingEditorClose,
    setPendingEditorClose,
    pendingDraftClear,
    setPendingDraftClear,
    draftsOpen,
    setDraftsOpen,
    cloudReloadConfirm,
    setCloudReloadConfirm,
    revisionConflictPublicationId,
    setRevisionConflictPublicationId,
    cloudDraft,
    discardDraftMutation,
    forgetDeletedDraft,
    openPublicationMutation,
    postImport,
    refreshEditedPublicationMutation,
    rememberEditorReturnFocus,
    openPublicationEditor,
    requestCreateEditor,
    closeCreateSheet,
    openCreateEditor,
    requestCloseEditor,
    closeEditor,
    restoreCreateDraftAndClose,
    finishIsolatedPublication,
    canPreservePublicationSchedule: (snapshot: PublicationDraft = draft) =>
      canPreservePublicationSchedule(editorContext, isolatedDraftBaselineRef.current, snapshot),
    getEffectiveLatePolicy: (snapshot: PublicationDraft = draft) =>
      resolvePublicationDraftLatePolicy(
        snapshot,
        isolatedDraftBaselineRef.current,
        editorContext?.kind === 'edit',
        canPreservePublicationSchedule(editorContext, isolatedDraftBaselineRef.current, snapshot),
      ),
  };
}
