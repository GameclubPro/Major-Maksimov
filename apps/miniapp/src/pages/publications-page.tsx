import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import { PublicationLatePolicyFields } from '../features/publications/publication-late-policy-fields';
import { SearchField } from '../components/ui/search-field';
import { formatPublicationLatePolicy } from '../features/publications/publication-late-policy-presentation';
import { usePublicationEditorSession } from '../features/publications/use-publication-editor-session';
import { usePublicationActions } from '../features/publications/use-publication-actions';
import {
  PublicationActionSheet,
  PublicationDeliveryActionSheets,
} from '../features/publications/publication-action-sheets';
import { usePublicationList } from '../features/publications/use-publication-list';
import { usePublicationCalendar } from '../features/publications/use-publication-calendar';
import { publicationQueryKeys as queryKeys } from '../features/publications/publication-query-keys';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type PublicationSummary } from '@maxim/contracts/publication';
import type { MiniappProfile } from '@maxim/contracts/publisher';

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  BroadcastPublishBar,
  type BroadcastPublishIssueAction,
} from '../components/broadcast-publish-bar';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { PublicationHubHeader } from '../features/publications/publication-hub-header';
import {
  formatDraftTiming,
  formatLoadedCount,
  formatPublicationSchedule,
  formatPublicationTargets,
  formatTargetSummary,
  getLifecycleTone,
  getRecurrenceError,
} from '../features/publications/publication-page-formatters';
import {
  LEGACY_PUBLICATION_KIND_FILTERS as LEGACY_KIND_FILTERS,
  LEGACY_PUBLICATION_VIEW_OPTIONS as LEGACY_VIEW_OPTIONS,
  PUBLICATION_ENTITY_FILTERS as ENTITY_FILTERS,
  PUBLICATION_STATUS_FILTERS as STATUS_FILTERS_BY_VIEW,
  PUBLICATION_VIEW_OPTIONS as VIEW_OPTIONS,
} from '../features/publications/publication-page-options';
import { PublicationFeedCard } from '../features/publications/publication-feed-card';
import { PublicationCreateSheet } from '../features/publications/publication-create-sheet';
import { PublicationButtonsSheet } from '../features/publications/publication-buttons-sheet';
import { formatTimezoneLabel } from '../lib/timezone-label';
import {
  buildPublicationSaveFeedback,
  buildPublicationSystemButtons,
  buildTestPublicationRequest,
  canReviewPublicationScheduleDecision,
  hasPublicationScheduleError,
  getPublicationEditorTitle,
  createEmptyPublicationDraft,
  getPublicationActionCapabilities,
  getPublicationActionableDelivery,
  getPublicationEditActionLabel,
  getPublicationCancelActionLabel,
  getPublicationExplicitSlotsLimitFeedback,
  getPublicationFeedStatusLabel,
  getPublicationPrimaryActionLabel,
  getPublicationOnceSlot,
  getPublicationTargetKey,
  hasSamePublicationTargetMetadata,
  getPublicationTimingIssue,
  isIsolatedPublicationEditor,
  isPublicationRevisionConflictError,
  PUBLICATION_TEXT_MAX_LENGTH,
  PUBLICATION_MIN_SCHEDULE_DELAY_MS,
  publicationDraftNeedsVideoReselection,
  shouldReviewPublicationScheduleConflict,
  type PublicationEntityFilter,
  type PublicationStatusFilter,
  type PublicationTimingMode,
} from '../features/publications/publication-model';
import {
  LegacyPublicationsEntry,
  LegacyPublicationsList,
} from '../features/publications/legacy-publications-panel';
import {
  PUBLICATION_TEST_RESULT_PENDING_FEEDBACK,
  isPublicationTestResultPendingError,
} from '../features/publications/publication-request-identity';
import {
  resolvePublicationSaveRequestContext,
  preparePublicationSave,
} from '../features/publications/publication-save-request';
import { PublisherPostImportStatus } from '../features/publications/publisher-post-import-status';
import { PublicationTargetNotices } from '../features/publications/publication-target-notices';
import { PublicationTargetPicker } from '../features/publications/publication-target-picker';
import * as publicationTargetRecheck from '../features/publications/publication-target-recheck';
import { useInitialPublicationTargetRoute } from '../features/publications/use-initial-publication-target-route';
import { usePublicationRequestIds } from '../features/publications/use-publication-request-ids';
import { usePublicationTargetSources } from '../features/publications/use-publication-target-sources';
import {
  hasUnavailablePublisherDraftTargets,
  usePublisherDraftTargetHydration,
} from '../features/publications/use-publisher-draft-target-hydration';
import { usePublisherTargetErrorFeedback } from '../features/publications/use-publisher-target-error-feedback';
import { testPublication } from '../lib/api/publication-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
} from '../lib/broadcast-link-buttons';
import {
  uploadPublicationVideo,
  type PublicationVideoUploadProgress,
} from '../lib/api/publication-video-upload';
import { resolveBroadcastScheduleTimezone } from '../lib/broadcast-schedule';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import { maxImpact, maxNotify } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/publications-page.css';
import '../styles/publisher-publications-workspace.css';
import '../features/publications/publication-draft-resume.css';
import '../features/publications/publication-workbench.css';
import { PublicationPostPublishFields } from '../features/publications/publication-post-publish-fields';
import { publicationPostPublishLabels } from '../features/publications/publication-post-actions-presentation';
import { savePublicationWithAccessRefresh } from '../features/publications/publication-save-access-refresh';
import { useLocalPublicationVideoPreview } from '../features/publications/use-local-publication-video-preview';
import { PublicationDeliveryNote } from '../features/publications/publication-delivery-note';
import {
  PublicationDraftSaveIndicator,
  PublicationDraftStatus,
} from '../features/publications/publication-draft-status';

const LazyPublicationDraftsSheet = lazy(() =>
  import('../features/publications/publication-drafts-sheet').then((module) => ({
    default: module.PublicationDraftsSheet,
  })),
);
const LazyPublicationReviewSheet = lazy(() =>
  import('../features/publications/publication-review-sheet').then((module) => ({
    default: module.PublicationReviewSheet,
  })),
);

const LazyPublicationDetailsSheet = lazy(() =>
  import('../features/publications/publication-details-sheet').then((module) => ({
    default: module.PublicationDetailsSheet,
  })),
);
const LazyPublicationRecurrenceFields = lazy(() =>
  import('../features/publications/publication-recurrence-fields').then((module) => ({
    default: module.PublicationRecurrenceFields,
  })),
);
const LazyPublicationOnceFields = lazy(() =>
  import('../features/publications/publication-zoned-fields').then((module) => ({
    default: module.PublicationOnceFields,
  })),
);
const LazyPublicationContentEditorSection = lazy(() =>
  import('../features/publications/publication-content-editor-section').then((module) => ({
    default: module.PublicationContentEditorSection,
  })),
);
const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);

export function PublicationsPage({
  api,
  profile = 'moderation',
  userId,
}: {
  api: ApiTransport;
  profile?: MiniappProfile;
  userId: string;
}) {
  const isPublisherProfile = profile === 'publisher';
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const requestIds = usePublicationRequestIds();
  const [searchParams] = useSearchParams();
  const [mediaPreparing, setMediaPreparing] = useState(false);
  const [videoPreparing, setVideoPreparing] = useState(false);
  const [refreshingSaveAccess, setRefreshingSaveAccess] = useState(false);
  const saveAbort = useRef<AbortController | null>(null);
  useEffect(() => () => saveAbort.current?.abort(), [api, userId]);
  const publicationActions = usePublicationActions(api, requestIds);
  const {
    setActionTarget,
    detailsTarget,
    setDetailsTarget,
    ambiguousTarget,
    setAmbiguousTarget,
    retryChoiceTarget,
    actionMutation,
    retryMutation,
    resolveAmbiguousMutation,
    requestPublicationRetry,
  } = publicationActions;

  const editorSession = usePublicationEditorSession({
    api,
    userId,
    isPublisherProfile,
    mediaPreparing,
    videoPreparing,
    onOpen: () => setDetailsTarget(null),
  });
  const {
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
    openPublicationMutation,
    postImport,
    refreshEditedPublicationMutation,
    rememberEditorReturnFocus,
    openPublicationEditor,
    requestCreateEditor,
    closeCreateSheet,
    openCreateEditor,
    closeEditor,
    restoreCreateDraftAndClose,
  } = editorSession;
  const [videoUploadProgress, setVideoUploadProgress] =
    useState<PublicationVideoUploadProgress | null>(null);
  const videoUploadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => videoUploadAbortRef.current?.abort(), []);

  const {
    view,
    query,
    setQuery,
    entityFilter,
    setEntityFilter,
    statusFilter,
    setStatusFilter,
    filtersOpen,
    setFiltersOpen,
    legacyView,
    setLegacyView,
    legacyQuery,
    setLegacyQuery,
    legacyKindFilter,
    setLegacyKindFilter,
    legacyEntityFilter,
    setLegacyEntityFilter,
    legacyFiltersOpen,
    setLegacyFiltersOpen,
    isLegacyView,
    currentQuery,
    schedulesQuery,
    historyQuery,
    legacyListQuery,
    currentItems,
    scheduleItems,
    historyItems,
    legacyItems,
    showLegacyEntry,
    legacyEntryCount,
    legacyActiveCount,
    legacyHistoryCount,
    legacyProbeHasError,
    legacyCurrentTotal,
    visibleItems,
    currentListQuery,
    setLegacyRoute,
    openLegacyView,
    closeLegacyView,
    changeView,
    setPublicationHubRoute,
  } = usePublicationList(api, isPublisherProfile, isEditor);
  const isEditorKeyboardOpen = useKeyboardOpen(96, isEditor);
  const contentSectionRef = useRef<HTMLElement | null>(null);
  const targetsSectionRef = useRef<HTMLElement | null>(null);
  const timingSectionRef = useRef<HTMLElement | null>(null);
  const { previews: assetPreviews, rememberVideo } = useLocalPublicationVideoPreview({
    api,
    userId,
    session: isEditor ? editorContext : null,
    publicationId:
      draft.cloudDraft?.id ??
      (editorContext?.kind === 'edit' || editorContext?.kind === 'import'
        ? editorContext.publicationId
        : null),
    assets: draft.retainedAssets,
  });

  const targetSources = usePublicationTargetSources(api, isPublisherProfile);
  const scopedTargetRecheck = publicationTargetRecheck.usePublicationTargetRecheck(api);
  const {
    targets,
    loading: sourcesLoading,
    fetching: sourcesFetching,
    hasError: sourcesHaveError,
    unavailable: sourcesUnavailable,
    ready: sourcesReady,
  } = targetSources;
  const initialTargetRoute = useInitialPublicationTargetRoute({
    api,
    hydrated,
    publisherProfile: isPublisherProfile,
    searchParams,
    targets,
    sourcesReady,
    setDraft,
  });
  const publisherDraftHydration = usePublisherDraftTargetHydration({
    api,
    enabled: isPublisherProfile && hydrated && isEditor,
    targets: draft.targets,
    setDraft,
  });
  usePublisherTargetErrorFeedback({
    draftHydrationError: publisherDraftHydration.error,
    draftHydrationFailed: publisherDraftHydration.isError,
  });
  const calendarAvailabilityQuery = usePublicationCalendar(api, isEditor, draft, editorContext);

  const saveMutation = useMutation({
    mutationFn: async ({
      replaceConflicts,
      controller,
    }: {
      replaceConflicts: boolean;
      controller: AbortController;
    }) => {
      try {
        const snapshot = await cloudDraft.flush();
        controller.signal.throwIfAborted();
        const context = resolvePublicationSaveRequestContext(
          snapshot,
          editorContext,
          editorSession.canPreservePublicationSchedule(snapshot),
        );
        const requestId = requestIds.resolveSaveRequestId(snapshot, context, replaceConflicts);
        return await savePublicationWithAccessRefresh({
          api,
          targets: snapshot.targets.map(({ id, entityType }) => ({ id, entityType })),
          save: preparePublicationSave(api, snapshot, context, requestId, replaceConflicts),
          signal: controller.signal,
          onRefreshing: () => setRefreshingSaveAccess(true),
        });
      } finally {
        if (saveAbort.current === controller) {
          saveAbort.current = null;
          if (!controller.signal.aborted) setRefreshingSaveAccess(false);
        }
      }
    },
    onSuccess: async (publication, { controller }) => {
      if (controller.signal.aborted) return;
      requestIds.confirmSaveSuccess();
      if (editorContext?.kind === 'import') {
        await postImport.finishPublishedImport();
      }
      await invalidatePublicationQueries();
      const feedback = buildPublicationSaveFeedback(publication, {
        editScope: editorContext?.kind === 'edit' ? editorContext.editScope : null,
        editorKind: editorContext?.kind ?? null,
        timingMode: draft.timingMode,
      });
      pushToast(feedback);
      maxNotify(feedback.notification);
      if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
        editorSession.finishIsolatedPublication(publication.id);
      } else {
        await clearDraft();
        closeEditor(false);
      }
    },
    onError: (error, variables) => {
      if (variables.controller.signal.aborted) return;
      if (shouldReviewPublicationScheduleConflict(error, draft, variables.replaceConflicts)) {
        setPendingConflict(true);
        return;
      }
      if (draft.cloudDraft && isPublicationRevisionConflictError(error))
        cloudDraft.markConflict(error);
      if (
        !draft.cloudDraft &&
        (editorContext?.kind === 'edit' || editorContext?.kind === 'import') &&
        isPublicationRevisionConflictError(error)
      ) {
        setRevisionConflictPublicationId(editorContext.publicationId);
        void invalidatePublicationQueries();
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить публикацию'),
      });
      maxNotify('error');
    },
  });
  const testMutation = useMutation({
    mutationFn: () =>
      testPublication(
        api,
        buildTestPublicationRequest(draft, requestIds.resolveTestRequestId(draft)),
      ),
    onSuccess: () => {
      requestIds.confirmTestSuccess();
      pushToast({ tone: 'success', title: 'Отправлено вам' });
      maxNotify('success');
    },
    onError: (error) => {
      if (isPublicationTestResultPendingError(error)) {
        pushToast(PUBLICATION_TEST_RESULT_PENDING_FEEDBACK);
        maxNotify('warning');
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отправить тест'),
      });
      maxNotify('error');
    },
  });
  const visibleCustomButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const previewTarget =
    draft.targets.find((target) => getPublicationTargetKey(target) === previewTargetKey) ??
    draft.targets[0] ??
    null;
  const resolvedPreviewTargetKey = previewTarget ? getPublicationTargetKey(previewTarget) : null;
  const systemButtons = buildPublicationSystemButtons(previewTarget ? [previewTarget] : []);
  const visibleCustomButtonCount = visibleCustomButtons.length;
  const videoNeedsReselection = publicationDraftNeedsVideoReselection(draft);
  const hasSelectedVideo =
    draft.mediaType === 'video' && Boolean(draft.mediaBase64 || draft.mediaPayload);
  const hasMedia = draft.images.length > 0 || hasSelectedVideo || draft.retainedAssets.length > 0;
  const hasContent = Boolean(draft.text.trim() || hasMedia);
  const hasButtonErrors =
    draft.buttonEnabled &&
    hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(draft.buttons));
  const selectedPublisherTargetUnavailable =
    isPublisherProfile &&
    !publisherDraftHydration.isPending &&
    hasUnavailablePublisherDraftTargets({
      selectedTargets: draft.targets,
      currentTargets: targets,
      hydrationFailed: publisherDraftHydration.isError,
    });
  const publisherCanCreate = isPublisherProfile && hydrated;
  const operationBusy =
    saveMutation.isPending ||
    testMutation.isPending ||
    openPublicationMutation.isPending ||
    actionMutation.isPending ||
    retryMutation.isPending ||
    refreshEditedPublicationMutation.isPending ||
    initialTargetRoute.pending ||
    publisherDraftHydration.isPending ||
    timingPreparing ||
    videoPreparing ||
    editorClosePending;
  const isBusy = operationBusy || mediaPreparing;
  const anyBusy = isBusy || resolveAmbiguousMutation.isPending;
  const isRetryVersionEditor =
    editorContext?.kind === 'edit' && editorContext.editScope === 'retry';
  const preservesSavedSchedule =
    isRetryVersionEditor || editorSession.canPreservePublicationSchedule();
  const recurrenceError = preservesSavedSchedule ? null : getRecurrenceError(draft);
  const timingIssue = preservesSavedSchedule ? null : getPublicationTimingIssue(draft);
  const explicitSlotsLimitFeedback = preservesSavedSchedule
    ? null
    : getPublicationExplicitSlotsLimitFeedback(draft);
  const validationIssues = useMemo<BroadcastPublishIssueAction[]>(() => {
    const issues: BroadcastPublishIssueAction[] = [];
    if (imagesNeedReselection) {
      issues.push({
        label: 'Фото',
        onClick: () =>
          focusEditorSection('content', 'Добавьте фото снова или выберите «Без фото».'),
      });
    } else if (videoNeedsReselection) {
      issues.push({
        label: 'Видео',
        onClick: () => focusEditorSection('content', 'Выберите видео снова.'),
      });
    } else if (!hasContent) {
      issues.push({
        label: 'Сообщение',
        onClick: () => focusEditorSection('content', 'Добавьте текст, фото или видео.'),
      });
    } else if (draft.text.length > PUBLICATION_TEXT_MAX_LENGTH) {
      issues.push({
        label: 'Текст',
        onClick: () =>
          focusEditorSection('content', `Максимум ${PUBLICATION_TEXT_MAX_LENGTH} символов.`),
      });
    }
    if (!isRetryVersionEditor && draft.targets.length === 0) {
      issues.push({
        label: 'Получатели',
        onClick: () => focusEditorSection('targets', 'Выберите хотя бы одного получателя.'),
      });
    } else if (!isRetryVersionEditor && selectedPublisherTargetUnavailable) {
      issues.push({
        label: 'Подключение',
        onClick: () =>
          focusEditorSection(
            'targets',
            'Выбранный получатель пока не готов к публикации через Публика.',
          ),
      });
    }
    if (explicitSlotsLimitFeedback) {
      issues.push({
        label: 'Расписание',
        onClick: () => focusEditorSection('timing', explicitSlotsLimitFeedback.title),
      });
    } else if (timingIssue) {
      issues.push({
        label: timingIssue.label,
        onClick: () => focusEditorSection('timing', timingIssue.message),
      });
    }
    if (draft.timingMode === 'schedule' && draft.scheduleKind === 'recurrence' && recurrenceError) {
      issues.push({
        label: 'Повтор',
        onClick: () => focusEditorSection('timing', recurrenceError),
      });
    }
    if (hasButtonErrors) {
      issues.push({
        label: 'Кнопки',
        onClick: () => {
          focusEditorSection('content', 'Проверьте текст и ссылку кнопки.');
          setButtonsOpen(true);
        },
      });
    }
    return issues;
  }, [
    draft,
    explicitSlotsLimitFeedback,
    hasButtonErrors,
    hasContent,
    imagesNeedReselection,
    isRetryVersionEditor,
    recurrenceError,
    selectedPublisherTargetUnavailable,
    timingIssue,
    videoNeedsReselection,
  ]);

  useEffect(() => {
    if (!isEditor) {
      setMediaPreparing(false);
    }
  }, [isEditor]);

  useEffect(() => {
    if (targets.length === 0) {
      return;
    }

    setDraft((current) => {
      let changed = false;
      const refreshedTargets = current.targets.map((target) => {
        const currentTarget = targets.find(
          (candidate) => getPublicationTargetKey(candidate) === getPublicationTargetKey(target),
        );
        if (!currentTarget || hasSamePublicationTargetMetadata(currentTarget, target)) {
          return target;
        }
        changed = true;
        return currentTarget;
      });

      return changed ? { ...current, targets: refreshedTargets } : current;
    });
  }, [draft.targets, setDraft, targets]);

  useEffect(() => {
    if (!isEditor) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      event.preventDefault();
      requestCloseEditor(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draft, editorContext?.kind, isBusy, isEditor]);

  useNativeBackHandler(
    () => {
      requestCloseEditor(true);
      return true;
    },
    { enabled: isEditor, priority: 610 },
  );

  async function invalidatePublicationQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.listRoot }),
      queryClient.invalidateQueries({ queryKey: ['publications', 'calendar'] }),
    ]);
  }

  function requestCloseEditor(preserveDraft: boolean) {
    editorSession.requestCloseEditor(preserveDraft, isBusy);
  }

  function focusEditorSection(section: 'content' | 'targets' | 'timing', message: string) {
    setFieldError(message);
    const target =
      section === 'content'
        ? contentSectionRef.current
        : section === 'targets'
          ? targetsSectionRef.current
          : timingSectionRef.current;
    window.requestAnimationFrame(() => {
      const focusTarget =
        target?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        target?.querySelector<HTMLElement>(
          'textarea:not(:disabled), input:not(:disabled), button:not(:disabled)',
        );
      focusTarget?.focus({ preventScroll: true });
      (focusTarget ?? target)?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  }

  function validateDraft(options: { ignoreSchedule?: boolean } = {}): boolean {
    setValidationStarted(true);
    const reject = (section: 'content' | 'targets' | 'timing', message: string) => {
      focusEditorSection(section, message);
      return false;
    };
    const nextButtonErrors = validateBroadcastLinkButtons(draft.buttons);
    if (mediaPreparing) {
      return reject('content', 'Дождитесь завершения подготовки фото.');
    }
    if (imagesNeedReselection) {
      return reject('content', 'Добавьте фото снова или выберите «Без фото».');
    }
    if (videoNeedsReselection) {
      return reject('content', 'Выберите видео снова.');
    }
    if (!hasContent) {
      return reject('content', 'Добавьте текст, фото или видео.');
    }
    if (draft.text.length > PUBLICATION_TEXT_MAX_LENGTH) {
      return reject('content', `Максимум ${PUBLICATION_TEXT_MAX_LENGTH} символов.`);
    }
    if (draft.buttonEnabled && hasBroadcastLinkButtonErrors(nextButtonErrors)) {
      setButtonsOpen(true);
      return reject('content', 'Проверьте текст и ссылку кнопки.');
    }
    if (!isRetryVersionEditor && draft.targets.length === 0) {
      return reject('targets', 'Выберите хотя бы одного получателя.');
    }
    if (!isRetryVersionEditor && selectedPublisherTargetUnavailable) {
      return reject('targets', 'Выбранный получатель пока не готов к публикации через Публика.');
    }
    if (!options.ignoreSchedule && !preservesSavedSchedule) {
      if (reportExplicitSlotsLimit()) {
        return false;
      }
      const currentTimingIssue = getPublicationTimingIssue(draft);
      if (currentTimingIssue) {
        return reject('timing', currentTimingIssue.message);
      }
      if (
        draft.timingMode === 'schedule' &&
        draft.scheduleKind === 'recurrence' &&
        recurrenceError
      ) {
        return reject('timing', recurrenceError);
      }
    }
    setFieldError('');
    return true;
  }

  function reportExplicitSlotsLimit(): boolean {
    if (!explicitSlotsLimitFeedback) {
      return false;
    }

    setValidationStarted(true);
    setPendingReview(false);
    setPendingConflict(false);
    focusEditorSection('timing', explicitSlotsLimitFeedback.title);
    pushToast(explicitSlotsLimitFeedback);
    maxNotify(explicitSlotsLimitFeedback.notification);
    return true;
  }

  function submitPublication(replaceConflicts: boolean) {
    if (mediaPreparing || saveAbort.current || saveMutation.isPending) {
      return;
    }
    if (!validateDraft()) {
      setPendingReview(false);
      return;
    }
    const controller = new AbortController();
    saveAbort.current = controller;
    saveMutation.mutate({ replaceConflicts, controller });
  }

  function handlePrimaryAction() {
    if (mediaPreparing) {
      return;
    }
    if (validateDraft()) {
      setPendingReview(true);
      return;
    }
  }

  function handleTest() {
    if (testMutation.isPending || mediaPreparing) {
      return;
    }

    if (validateDraft({ ignoreSchedule: true })) {
      testMutation.mutate();
      return;
    }
  }

  function updateOnceSlot(onceDate: string, onceTime: string, scheduledAt: string | null) {
    setDraft((current) => {
      const preservedAt =
        current.onceDate === onceDate && current.onceTime === onceTime
          ? getPublicationOnceSlot(current)
          : null;
      return {
        ...current,
        onceDate,
        onceTime,
        scheduledSlots: preservedAt ? [preservedAt] : scheduledAt ? [scheduledAt] : [],
      };
    });
    setFieldError('');
  }

  function renderFilters() {
    const statusFilters = STATUS_FILTERS_BY_VIEW[view];
    const hasActiveFilters = entityFilter !== 'all' || statusFilter !== 'all';
    const showFilterControls = filtersOpen;

    return (
      <div className={cn('publications-filterbar', showFilterControls && 'is-expanded')}>
        <div className="publications-filterbar__search-row">
          <SearchField
            className="publications-filterbar__search"
            value={query}
            onChange={(nextQuery) => {
              setQuery(nextQuery);
              setPublicationHubRoute({ query: nextQuery });
            }}
            placeholder="Найти пост"
            label="Поиск публикаций"
            inputProps={{ maxLength: 120, enterKeyHint: 'search' }}
          />
          <button
            type="button"
            className={cn('publications-filterbar__toggle', hasActiveFilters && 'is-active')}
            onClick={() => setFiltersOpen((current) => !current)}
            aria-expanded={showFilterControls}
            aria-label="Фильтры публикаций"
            aria-controls="publication-filters"
            title="Фильтры"
          >
            <IconoirSprite variant="iconoir" icon="FilterList" aria-hidden />
          </button>
        </div>

        {hasActiveFilters && !showFilterControls ? (
          <button
            type="button"
            className="publications-filterbar__summary"
            onClick={() => setFiltersOpen(true)}
            aria-label="Изменить активные фильтры"
          >
            <IconoirSprite variant="iconoir" icon="FilterList" aria-hidden />
            {[
              entityFilter !== 'all' &&
                ENTITY_FILTERS.find((filter) => filter.value === entityFilter)?.label,
              statusFilter !== 'all' &&
                statusFilters.find((filter) => filter.value === statusFilter)?.label,
            ]
              .filter(Boolean)
              .join(' · ')}
          </button>
        ) : null}
        {showFilterControls ? (
          <div id="publication-filters" className="publications-filterbar__controls">
            <div
              className="publications-filterbar__entities"
              role="group"
              aria-label="Тип получателя"
            >
              {ENTITY_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={entityFilter === filter.value}
                  className={cn(entityFilter === filter.value && 'is-active')}
                  onClick={() => {
                    setEntityFilter(filter.value);
                    setPublicationHubRoute({ entity: filter.value });
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <select
              value={statusFilter}
              onChange={(event) => {
                const nextStatus = event.currentTarget.value as PublicationStatusFilter;
                setStatusFilter(nextStatus);
                setPublicationHubRoute({ status: nextStatus });
              }}
              aria-label="Статус публикаций"
            >
              {statusFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters ? (
              <button
                type="button"
                className="publications-filterbar__reset"
                onClick={() => {
                  setEntityFilter('all');
                  setStatusFilter('all');
                  setPublicationHubRoute({ entity: 'all', status: 'all' });
                }}
                aria-label="Сбросить фильтры"
                title="Сбросить фильтры"
              >
                <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderLegacyFilters() {
    const hasActiveFilters = legacyKindFilter !== 'all' || legacyEntityFilter !== 'all';
    const showFilterControls = legacyFiltersOpen;

    return (
      <div className={cn('legacy-publications-filterbar', showFilterControls && 'is-expanded')}>
        <div className="legacy-publications-filterbar__search-row">
          <SearchField
            className="legacy-publications-filterbar__search"
            value={legacyQuery}
            onChange={(nextQuery) => {
              setLegacyQuery(nextQuery);
              setLegacyRoute(true, { query: nextQuery });
            }}
            placeholder="Найти пост в архиве"
            label="Поиск ранее созданных постов"
            inputProps={{ maxLength: 120, enterKeyHint: 'search' }}
          />
          <button
            type="button"
            className={cn('legacy-publications-filterbar__toggle', hasActiveFilters && 'is-active')}
            onClick={() => setLegacyFiltersOpen((current) => !current)}
            aria-expanded={showFilterControls}
            aria-label="Фильтры ранее созданных постов"
            aria-controls="legacy-publication-filters"
            title="Фильтры"
          >
            <IconoirSprite variant="iconoir" icon="FilterList" aria-hidden />
          </button>
        </div>

        {hasActiveFilters && !showFilterControls ? (
          <button
            type="button"
            className="publications-filterbar__summary"
            onClick={() => setLegacyFiltersOpen(true)}
            aria-label="Изменить активные фильтры архива"
          >
            <IconoirSprite variant="iconoir" icon="FilterList" aria-hidden />
            {[
              legacyKindFilter !== 'all' &&
                LEGACY_KIND_FILTERS.find((filter) => filter.value === legacyKindFilter)?.label,
              legacyEntityFilter !== 'all' &&
                ENTITY_FILTERS.find((filter) => filter.value === legacyEntityFilter)?.label,
            ]
              .filter(Boolean)
              .join(' · ')}
          </button>
        ) : null}
        {showFilterControls ? (
          <div id="legacy-publication-filters" className="legacy-publications-filterbar__controls">
            <div
              className="legacy-publications-filterbar__kinds"
              role="group"
              aria-label="Тип ранее созданного поста"
            >
              {LEGACY_KIND_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={legacyKindFilter === filter.value}
                  className={cn(legacyKindFilter === filter.value && 'is-active')}
                  onClick={() => {
                    setLegacyKindFilter(filter.value);
                    setLegacyRoute(true, { kind: filter.value });
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <select
              value={legacyEntityFilter}
              onChange={(event) => {
                const nextEntity = event.currentTarget.value as PublicationEntityFilter;
                setLegacyEntityFilter(nextEntity);
                setLegacyRoute(true, { entity: nextEntity });
              }}
              aria-label="Источник ранее созданных постов"
            >
              {ENTITY_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters ? (
              <button
                type="button"
                className="legacy-publications-filterbar__reset"
                onClick={() => {
                  setLegacyKindFilter('all');
                  setLegacyEntityFilter('all');
                  setLegacyRoute(true, { kind: 'all', entity: 'all' });
                }}
                aria-label="Сбросить фильтры"
                title="Сбросить фильтры"
              >
                <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderPublicationCard(publication: PublicationSummary) {
    const delivery = getPublicationActionableDelivery(publication);
    const actionCapabilities = getPublicationActionCapabilities(publication);
    const canReviewScheduleDecision = canReviewPublicationScheduleDecision(publication);
    const scheduleReviewLabel = canReviewScheduleDecision
      ? 'Разобрать пропущенные отправки'
      : hasPublicationScheduleError(publication)
        ? 'Разобрать расписание'
        : null;
    const pending =
      (actionMutation.isPending && actionMutation.variables?.publication.id === publication.id) ||
      (openPublicationMutation.isPending &&
        openPublicationMutation.variables?.publicationId === publication.id);
    return (
      <PublicationFeedCard
        key={publication.id}
        id={publication.id}
        title={publication.title || formatPublicationTargets(publication)}
        preview={publication.contentPreview}
        previewFormat={publication.contentPreviewFormat}
        fallback={
          publication.hasVideo
            ? 'Видео без текста'
            : publication.mediaCount > 0
              ? 'Фото без текста'
              : null
        }
        eyebrow={getPublicationFeedStatusLabel(publication)}
        tone={getLifecycleTone(publication)}
        busy={pending}
        meta={[
          formatPublicationTargets(publication),
          formatPublicationSchedule(publication),
          ...publicationPostPublishLabels(publication.postPublish),
        ]}
        primaryAction={{ label: 'Открыть детали', onClick: () => setDetailsTarget(publication) }}
        canEdit={isPublisherProfile && actionCapabilities.canEdit}
        canPause={actionCapabilities.canPause}
        canResume={actionCapabilities.canResume}
        canRetry={actionCapabilities.canRetry && !scheduleReviewLabel}
        scheduleReviewLabel={scheduleReviewLabel}
        canDuplicate={isPublisherProfile}
        canCancel={actionCapabilities.canCancel}
        editLabel={getPublicationEditActionLabel(actionCapabilities.editScope)}
        cancelLabel={getPublicationCancelActionLabel(publication)}
        onEdit={() => openPublicationEditor(publication, 'edit')}
        onPause={() => setActionTarget({ publication, action: 'pause' })}
        onResume={() => setActionTarget({ publication, action: 'resume' })}
        onRetry={() => setDetailsTarget(publication)}
        onReviewSchedule={() => setDetailsTarget(publication)}
        onDuplicate={() => openPublicationEditor(publication, 'duplicate')}
        onCancel={() => setActionTarget({ publication, action: 'cancel' })}
        footer={
          <PublicationDeliveryNote
            delivery={delivery}
            title={publication.title || formatPublicationTargets(publication)}
            pending={pending}
            onReview={() => setDetailsTarget(publication)}
          />
        }
      />
    );
  }

  function renderFeed() {
    return (
      <>
        {renderFilters()}
        {currentListQuery.isLoading ? (
          <StatusState tone="neutral" title="Загружаю публикации" />
        ) : currentListQuery.isError && !currentListQuery.data ? (
          <StatusState
            tone="danger"
            title="Не удалось загрузить"
            description={describeUserFacingError(currentListQuery.error, 'Повторите ещё раз.')}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void currentListQuery.refetch()}
              >
                Обновить
              </button>
            }
          />
        ) : visibleItems.length === 0 ? (
          <div className="publications-empty">
            <strong>
              {query.trim() || entityFilter !== 'all' || statusFilter !== 'all'
                ? 'Ничего не найдено'
                : view === 'history'
                  ? 'История пока пустая'
                  : view === 'schedules'
                    ? 'Расписаний пока нет'
                    : 'Текущих постов нет'}
            </strong>
            {isPublisherProfile && view !== 'history' && !query.trim() && publisherCanCreate ? (
              <button type="button" className="publications-primary" onClick={requestCreateEditor}>
                <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
                <span>Новая публикация</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="publications-feed">{visibleItems.map(renderPublicationCard)}</div>
        )}
        {currentListQuery.hasNextPage && currentListQuery.data ? (
          <button
            type="button"
            className="publications-load-more"
            onClick={() => void currentListQuery.fetchNextPage()}
            disabled={currentListQuery.isFetchingNextPage}
          >
            {currentListQuery.isFetchingNextPage
              ? 'Загрузка...'
              : currentListQuery.isFetchNextPageError
                ? 'Повторить'
                : 'Показать ещё'}
          </button>
        ) : null}
      </>
    );
  }

  const recheckPublisherTargets = () =>
    publicationTargetRecheck.runPublicationTargetRecheck(targetSources.recheck, pushToast);

  function renderHub() {
    return (
      <>
        <PublicationHubHeader
          publisherProfile={isPublisherProfile}
          canCreate={publisherCanCreate}
          targets={targets}
          publisherSummary={targetSources.publisherSummary}
          sourcesLoading={sourcesLoading}
          sourcesFetching={sourcesFetching}
          sourcesHaveError={sourcesHaveError}
          onCreate={requestCreateEditor}
          onRefresh={recheckPublisherTargets}
          onDrafts={() => setDraftsOpen(true)}
        />

        {isPublisherProfile ? <PublisherPostImportStatus {...postImport.statusProps} /> : null}

        <div className="publications-tabs" role="group" aria-label="Раздел постов">
          {VIEW_OPTIONS.map((option) =>
            (() => {
              const count =
                option.value === 'current'
                  ? currentQuery.data
                    ? formatLoadedCount(currentItems.length, Boolean(currentQuery.hasNextPage))
                    : null
                  : option.value === 'schedules'
                    ? schedulesQuery.data
                      ? formatLoadedCount(scheduleItems.length, Boolean(schedulesQuery.hasNextPage))
                      : null
                    : historyQuery.data
                      ? formatLoadedCount(historyItems.length, Boolean(historyQuery.hasNextPage))
                      : null;

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={view === option.value}
                  className={cn(view === option.value && 'is-active')}
                  onClick={() => changeView(option.value)}
                >
                  <span>{option.label}</span>
                  {count ? <small>{count}</small> : null}
                </button>
              );
            })(),
          )}
        </div>

        {isPublisherProfile && hasSavedDraft ? (
          <button type="button" className="publication-draft-resume" onClick={openCreateEditor}>
            <span>
              <strong>Черновик</strong>
              <small>
                <MaxMarkdownPreview
                  value={draft.text}
                  sourceFormat={draft.textFormat}
                  className="publication-draft-resume__preview"
                  normalizeWhitespace
                  fallback={formatTargetSummary(draft.targets)}
                />
              </small>
            </span>
            <span>Продолжить</span>
          </button>
        ) : null}

        {showLegacyEntry ? (
          <LegacyPublicationsEntry
            count={legacyEntryCount}
            countIncomplete={
              legacyProbeHasError || legacyActiveCount === null || legacyHistoryCount === null
            }
            onOpen={openLegacyView}
          />
        ) : null}

        {renderFeed()}
      </>
    );
  }

  function renderLegacyHub() {
    const hasFilters =
      legacyQuery.trim().length > 0 || legacyKindFilter !== 'all' || legacyEntityFilter !== 'all';

    return (
      <>
        <header className="publications-editor-header legacy-publications-header">
          <button
            type="button"
            onClick={closeLegacyView}
            aria-label="Вернуться к постам"
            title="Назад"
          >
            <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
          </button>
          <span>
            <h1>Старые публикации</h1>
            {legacyCurrentTotal !== null ? (
              <small>
                {formatRussianCountLabel(legacyCurrentTotal, 'запись', 'записи', 'записей')}
              </small>
            ) : null}
          </span>
        </header>

        <div className="legacy-publications-tabs" role="group" aria-label="Старые публикации">
          {LEGACY_VIEW_OPTIONS.map((option) => {
            const count = option.value === 'active' ? legacyActiveCount : legacyHistoryCount;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={legacyView === option.value}
                className={cn(legacyView === option.value && 'is-active')}
                onClick={() => {
                  setLegacyView(option.value);
                  setLegacyRoute(true, { view: option.value });
                  maxImpact('soft');
                }}
              >
                <span>{option.label}</span>
                {count !== null ? <small>{count}</small> : null}
              </button>
            );
          })}
        </div>

        {renderLegacyFilters()}

        {legacyListQuery.isLoading ? (
          <StatusState tone="neutral" title="Загружаю ранее созданные посты" />
        ) : legacyListQuery.isError && !legacyListQuery.data ? (
          <StatusState
            tone="danger"
            title="Не удалось загрузить"
            description={describeUserFacingError(legacyListQuery.error, 'Повторите ещё раз.')}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void legacyListQuery.refetch()}
              >
                Обновить
              </button>
            }
          />
        ) : legacyItems.length === 0 ? (
          <div className="publications-empty">
            <strong>
              {hasFilters
                ? 'Ничего не найдено'
                : legacyView === 'history'
                  ? 'История пока пустая'
                  : 'Активных записей нет'}
            </strong>
          </div>
        ) : (
          <LegacyPublicationsList items={legacyItems} />
        )}

        {legacyListQuery.hasNextPage && legacyListQuery.data ? (
          <button
            type="button"
            className="publications-load-more"
            onClick={() => void legacyListQuery.fetchNextPage()}
            disabled={legacyListQuery.isFetchingNextPage}
          >
            {legacyListQuery.isFetchingNextPage
              ? 'Загрузка...'
              : legacyListQuery.isFetchNextPageError
                ? 'Повторить'
                : 'Показать ещё'}
          </button>
        ) : null}
      </>
    );
  }

  async function changeTimingMode(mode: PublicationTimingMode) {
    if (isBusy || draft.timingMode === mode) return;
    setFieldError('');
    if (mode !== 'once' || !draft.onceDate || !draft.onceTime) {
      setDraft((current) => ({
        ...current,
        timingMode: mode,
        ...(mode === 'once' ? { scheduledSlots: [] } : {}),
      }));
      return;
    }
    setTimingPreparing(true);
    try {
      const { parsePublicationScheduleField } =
        await import('../features/publications/publication-schedule-fields');
      setDraft((current) => {
        const at =
          getPublicationOnceSlot(current) ??
          parsePublicationScheduleField(
            `${current.onceDate}T${current.onceTime}`,
            current.scheduleTimezone,
          );
        return { ...current, timingMode: 'once', scheduledSlots: at ? [at] : [] };
      });
    } catch {
      focusEditorSection('timing', 'Не удалось открыть выбор времени. Попробуйте ещё раз.');
    } finally {
      setTimingPreparing(false);
    }
  }

  function renderTiming() {
    const onceDate = draft.onceDate;
    const onceTime = draft.onceTime;
    return (
      <section
        ref={timingSectionRef}
        className="publication-editor-section publication-editor-section--timing"
      >
        <div className="publication-editor-section__head">
          <strong>Когда</strong>
          {draft.timingMode === 'now' ? null : <small>{formatDraftTiming(draft)}</small>}
        </div>
        <div className="publication-timing-tabs" role="group" aria-label="Время публикации">
          {(
            [
              { value: 'now', label: 'Сейчас' },
              { value: 'once', label: 'Отложить' },
              { value: 'schedule', label: 'Расписание' },
            ] as Array<{ value: PublicationTimingMode; label: string }>
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={draft.timingMode === option.value}
              className={cn(draft.timingMode === option.value && 'is-active')}
              onClick={() => void changeTimingMode(option.value)}
              disabled={isBusy}
            >
              {option.label}
            </button>
          ))}
        </div>

        {draft.timingMode !== 'now' ? (
          <div className="publication-schedule-timezone">
            <IconoirSprite variant="iconoir" icon="Clock" aria-hidden />
            <span>
              {formatTimezoneLabel(
                draft.timingMode === 'schedule' && draft.scheduleKind === 'slots'
                  ? resolveBroadcastScheduleTimezone()
                  : draft.scheduleTimezone,
              )}
            </span>
          </div>
        ) : null}

        {draft.timingMode !== 'now' ? (
          <PublicationLatePolicyFields
            value={editorSession.getEffectiveLatePolicy(draft)}
            recurring={draft.timingMode === 'schedule' && draft.scheduleKind === 'recurrence'}
            disabled={isBusy}
            onChange={(latePolicy) => setDraft((current) => ({ ...current, latePolicy }))}
          />
        ) : null}

        {draft.timingMode === 'once' ? (
          <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
            <LazyPublicationOnceFields
              date={onceDate}
              time={onceTime}
              timezone={draft.scheduleTimezone}
              disabled={isBusy}
              dateError={
                validationStarted && timingIssue?.field === 'date' ? timingIssue.message : undefined
              }
              timeError={
                validationStarted && timingIssue?.field === 'time' ? timingIssue.message : undefined
              }
              onChange={updateOnceSlot}
            />
          </Suspense>
        ) : draft.timingMode === 'schedule' ? (
          <>
            <div className="publication-schedule-kind" role="group" aria-label="Тип расписания">
              {(
                [
                  { value: 'slots', label: 'Даты' },
                  { value: 'recurrence', label: 'Повтор' },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={draft.scheduleKind === option.value}
                  className={cn(draft.scheduleKind === option.value && 'is-active')}
                  onClick={() =>
                    setDraft((current) => ({ ...current, scheduleKind: option.value }))
                  }
                  disabled={isBusy}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {draft.scheduleKind === 'recurrence' ? (
              <Suspense fallback={<div className="publication-date-loading" aria-busy="true" />}>
                <LazyPublicationRecurrenceFields
                  draft={draft}
                  setDraft={setDraft}
                  isBusy={isBusy}
                  setFieldError={setFieldError}
                />
              </Suspense>
            ) : (
              <Suspense fallback={null}>
                <LazyBroadcastSchedulePlanner
                  preciseTime
                  minimumLeadMs={PUBLICATION_MIN_SCHEDULE_DELAY_MS}
                  value={draft.scheduledSlots}
                  occupiedSlots={
                    calendarAvailabilityQuery.data?.slots.map((slot) => slot.scheduledAt) ?? []
                  }
                  onChange={(scheduledSlots) => {
                    setDraft((current) => ({ ...current, scheduledSlots }));
                    setFieldError('');
                  }}
                  managedBroadcastsLoading={calendarAvailabilityQuery.isLoading}
                  calendarRefreshing={calendarAvailabilityQuery.isFetching}
                  currentTargetLabel={formatTargetSummary(draft.targets)}
                  targetContextLabel={formatTargetSummary(draft.targets)}
                  timingMode="scheduled"
                  availableTimingModes={['scheduled']}
                  viewMode="compose"
                  allowRecipe={false}
                  disabled={isBusy}
                />
              </Suspense>
            )}
          </>
        ) : null}

        {draft.timingMode === 'schedule' &&
        draft.scheduleKind === 'slots' &&
        calendarAvailabilityQuery.isError ? (
          <div className="publications-calendar-error" role="alert">
            <span>Не удалось загрузить занятое время.</span>
            <button type="button" onClick={() => void calendarAvailabilityQuery.refetch()}>
              <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
              <span>Повторить</span>
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  async function handlePublicationVideoFile(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }
    if (
      missingImageCount > 0 ||
      draft.images.length > 0 ||
      draft.retainedAssets.some((asset) => asset.type === 'image')
    ) {
      pushToast({
        tone: 'info',
        title:
          missingImageCount > 0
            ? 'Сначала завершите восстановление фото'
            : 'Сначала удалите добавленные фото',
      });
      return;
    }
    setVideoPreparing(true);
    const abort = new AbortController();
    videoUploadAbortRef.current = abort;
    try {
      const asset = await uploadPublicationVideo(api, file, abort.signal, setVideoUploadProgress);
      abort.signal.throwIfAborted();
      setDraft((current) => ({
        ...current,
        images: [],
        retainedAssets: [asset],
        mediaType: null,
        mediaPayload: null,
        mediaBase64: '',
        mediaMimeType: '',
        mediaFileName: '',
      }));
      rememberVideo(asset.id, file);
      discardMissingImages();
      setFieldError('');
    } finally {
      videoUploadAbortRef.current = null;
      setVideoUploadProgress(null);
      setVideoPreparing(false);
    }
  }

  function confirmDraftClear() {
    if (isBusy) {
      return;
    }
    setPendingDraftClear(false);
    setFieldError('');
    setValidationStarted(false);
    if (draft.cloudDraft) {
      replaceDraft({
        ...createEmptyPublicationDraft(),
        cloudDraft: draft.cloudDraft,
        cloudRequestId: draft.cloudRequestId,
      });
      setImportOmissions([]);
      return;
    }
    if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
      if (editorContext?.kind === 'import') {
        setImportOmissions([]);
      }
      replaceDraft(createEmptyPublicationDraft());
      return;
    }
    void clearDraft();
  }

  function renderEditor() {
    const editing = editorContext?.kind === 'edit';
    const importing = editorContext?.kind === 'import' || editorContext?.kind === 'draft';
    const editScope = editing ? editorContext.editScope : null;
    const editorTitle = getPublicationEditorTitle(editScope, importing);
    const retainedVideo = draft.retainedAssets.some((asset) => asset.type === 'video');
    const primaryLabel = getPublicationPrimaryActionLabel({
      hasValidationIssues: validationIssues.length > 0,
      editing,
      timingMode: draft.timingMode,
    });
    return (
      <>
        <header className="publications-editor-header">
          <button
            type="button"
            onClick={() => requestCloseEditor(true)}
            disabled={isBusy}
            aria-label="Назад"
            title="Назад"
          >
            <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
          </button>
          <span>
            <h1 ref={editorTitleRef} tabIndex={-1}>
              {editorTitle}
            </h1>
            {!editing ? (
              <PublicationDraftSaveIndicator state={cloudDraft} dirty={cloudDraft.dirty} />
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setPendingDraftClear(true)}
            aria-label="Очистить черновик"
            title="Очистить"
            disabled={isBusy || editing || cloudDraft.status === 'saving'}
          >
            <IconoirSprite variant="iconoir" icon="Trash" aria-hidden />
          </button>
        </header>

        <div className="publications-editor">
          {!editing ? (
            <PublicationDraftStatus
              state={cloudDraft}
              busy={isBusy || cloudDraft.status === 'saving'}
              onRetry={() => void cloudDraft.flush().catch(() => undefined)}
              onReload={() => setCloudReloadConfirm(true)}
              onCopy={() =>
                void cloudDraft.saveCopy()?.catch((error) =>
                  pushToast({
                    tone: 'danger',
                    title: describeUserFacingError(error, 'Не удалось сохранить копию'),
                  }),
                )
              }
            />
          ) : null}
          <section
            ref={targetsSectionRef}
            className="publication-editor-section publication-editor-section--targets"
          >
            <PublicationTargetNotices
              publisherProfile={isPublisherProfile}
              sourcesHaveError={sourcesHaveError}
              sourcesUnavailable={sourcesUnavailable}
              sourcesFetching={sourcesFetching}
              chatsFailed={targetSources.chatsFailed}
              onSourcesRefresh={() => void targetSources.refetch()}
              draftHydrationFailed={publisherDraftHydration.isError}
              draftHydrationPending={publisherDraftHydration.isPending}
              onDraftHydrationRefresh={() => void publisherDraftHydration.refetch()}
              initialRoute={initialTargetRoute}
            />
            <PublicationTargetPicker
              choices={targets}
              value={draft.targets}
              compactSummary={isPublisherProfile}
              notice={
                selectedPublisherTargetUnavailable && !isRetryVersionEditor
                  ? 'Выбранный получатель недоступен. Удалите его.'
                  : null
              }
              remoteSource={
                isPublisherProfile
                  ? {
                      query: targetSources.publisherInputQuery,
                      entityFilter: targetSources.publisherEntityFilter,
                      settling: targetSources.publisherSearchSettling,
                      loading: sourcesLoading,
                      filteredTotal: targetSources.filteredTotal,
                      hasNextPage: targetSources.hasNextPage,
                      fetchingNextPage: targetSources.fetchingNextPage,
                      fetchNextPageError: targetSources.fetchNextPageError,
                      onQueryChange: targetSources.setPublisherInputQuery,
                      onEntityFilterChange: targetSources.setPublisherEntityFilter,
                      onLoadMore: () => void targetSources.fetchNextPage(),
                    }
                  : undefined
              }
              disabled={
                isBusy ||
                isRetryVersionEditor ||
                (!isPublisherProfile && sourcesLoading && targets.length === 0)
              }
              error={fieldError.includes('получател') ? fieldError : null}
              onChange={(nextTargets) => {
                setDraft((current) => ({ ...current, targets: nextTargets }));
                setFieldError('');
              }}
            />
          </section>

          <Suspense
            fallback={
              <section
                ref={contentSectionRef}
                className="publication-editor-section publication-editor-section--content"
                aria-busy="true"
              >
                <div className="publication-editor-section__head">
                  <strong>Пост</strong>
                  <small>Загрузка...</small>
                </div>
              </section>
            }
          >
            <LazyPublicationContentEditorSection
              sectionRef={contentSectionRef}
              draft={draft}
              setDraft={setDraft}
              importing={editorContext?.kind === 'import'}
              importOmissions={importOmissions}
              importedAssetPreviews={assetPreviews}
              customButtons={visibleCustomButtons}
              systemButtons={systemButtons}
              previewTargets={draft.targets}
              previewTargetKey={resolvedPreviewTargetKey}
              customButtonCount={visibleCustomButtonCount}
              hasButtonErrors={hasButtonErrors}
              showButtonsLabel={isPublisherProfile}
              isBusy={isBusy}
              operationBusy={operationBusy}
              imagesNeedReselection={imagesNeedReselection}
              missingImageCount={missingImageCount}
              retainedVideo={Boolean(retainedVideo)}
              videoPreparing={videoPreparing}
              videoUploadProgress={videoUploadProgress}
              onCancelVideoUpload={() => videoUploadAbortRef.current?.abort()}
              videoNeedsReselection={videoNeedsReselection}
              fieldError={fieldError}
              onDiscardMissingImages={discardMissingImages}
              onResolveMissingImages={resolveMissingImages}
              onPreviewTargetChange={setPreviewTargetKey}
              onOpenButtons={() => setButtonsOpen(true)}
              onVideoFile={handlePublicationVideoFile}
              onImagePreparationChange={setMediaPreparing}
              onFieldError={setFieldError}
              onInfo={(message) => pushToast({ tone: 'info', title: message })}
            />
          </Suspense>

          {editScope === 'retry' ? null : renderTiming()}

          <PublicationPostPublishFields
            value={draft.postPublish}
            disabled={isBusy}
            onChange={(postPublish) => setDraft((current) => ({ ...current, postPublish }))}
          />
        </div>

        <div className="publications-publish-bar">
          {fieldError ? (
            <p className="publication-submit-feedback" role="alert">
              {fieldError}
            </p>
          ) : null}
          <BroadcastPublishBar
            title={
              editScope === 'retry'
                ? 'Версия для повтора'
                : editScope === 'future'
                  ? 'Будущие отправки'
                  : draft.timingMode === 'schedule'
                    ? 'Расписание'
                    : 'Публикация'
            }
            meta={formatTargetSummary(draft.targets)}
            issues={validationStarted && !fieldError ? validationIssues : []}
            busy={isBusy}
            showTest={!isPublisherProfile}
            testLabel="Отправить себе"
            compactTestLabel="Тест"
            testAriaLabel="Отправить публикацию себе"
            testDisabled={
              isBusy ||
              !hasContent ||
              videoNeedsReselection ||
              draft.targets.length === 0 ||
              hasButtonErrors
            }
            primaryLabel={
              isBusy
                ? refreshingSaveAccess
                  ? 'Проверяем доступ...'
                  : saveMutation.isPending
                    ? 'Сохраняем...'
                    : 'Подождите...'
                : editScope === 'retry'
                  ? 'Проверить пост'
                  : draft.timingMode === 'once'
                    ? 'Проверить и отложить'
                    : draft.timingMode === 'schedule'
                      ? 'Проверить расписание'
                      : 'Проверить пост'
            }
            primaryDisabled={isBusy}
            onTest={handleTest}
            onPrimary={handlePrimaryAction}
          />
        </div>

        <PublicationButtonsSheet
          open={buttonsOpen}
          buttons={draft.buttonEnabled ? draft.buttons : []}
          disabled={isBusy}
          onApply={(buttons) => {
            setDraft((current) => ({
              ...current,
              buttonEnabled: buttons.length > 0,
              buttons,
            }));
            setButtonsOpen(false);
          }}
          onClose={() => setButtonsOpen(false)}
        />

        {pendingReview ? (
          <Suspense
            fallback={
              <ActionConfirmSheet
                id="publication-review-loading"
                open
                title="Загрузка проверки публикации"
                summary="Подготавливаем предпросмотр..."
                confirmLabel="Загрузка..."
                confirmDisabled
                cancelLabel="Назад"
                tone="accent"
                onClose={() => setPendingReview(false)}
                onConfirm={() => undefined}
              />
            }
          >
            <LazyPublicationReviewSheet
              open={pendingReview}
              draft={draft}
              previews={assetPreviews}
              facts={[
                `Кому · ${formatTargetSummary(draft.targets)}`,
                editScope === 'retry' ? null : formatTimezoneLabel(draft.scheduleTimezone),
                editScope === 'retry'
                  ? 'Отправка · после ручного повтора'
                  : `Когда · ${formatDraftTiming(draft)}`,
                editScope === 'retry' || draft.timingMode === 'now'
                  ? null
                  : `При задержке · ${formatPublicationLatePolicy(
                      editorSession.getEffectiveLatePolicy(draft),
                      draft.timingMode === 'schedule' && draft.scheduleKind === 'recurrence',
                    )}`,
                ...publicationPostPublishLabels(draft.postPublish),
              ].filter((item): item is string => Boolean(item))}
              confirmLabel={primaryLabel}
              busy={isBusy}
              onClose={() => !isBusy && setPendingReview(false)}
              onConfirm={() => {
                setPendingReview(false);
                submitPublication(false);
              }}
            />
          </Suspense>
        ) : null}
      </>
    );
  }

  return (
    <div
      className={cn(
        'publications-page',
        isPublisherProfile && 'is-publisher',
        isEditor && 'is-editor',
        isEditorKeyboardOpen && 'is-keyboard-open',
      )}
    >
      {isEditor ? renderEditor() : isLegacyView ? renderLegacyHub() : renderHub()}

      <PublicationCreateSheet
        open={postImport.createSheetOpen}
        busy={postImport.createPending}
        onClose={closeCreateSheet}
        onWrite={openCreateEditor}
        onForward={postImport.startImport}
      />
      {draftsOpen ? (
        <Suspense fallback={null}>
          <LazyPublicationDraftsSheet
            api={api}
            busy={openPublicationMutation.isPending}
            onClose={() => setDraftsOpen(false)}
            onOpen={(publicationId, copy) => {
              rememberEditorReturnFocus();
              openPublicationMutation.mutate({
                publicationId,
                mode: copy ? 'draft-copy' : 'draft',
              });
            }}
            onDeleted={(id) => {
              if (draft.cloudDraft?.id === id) void clearDraft();
              void invalidatePublicationQueries();
            }}
          />
        </Suspense>
      ) : null}

      <ActionConfirmSheet
        id="publication-cloud-reload"
        open={cloudReloadConfirm}
        title="Обновить черновик?"
        summary="Несохранённые правки на этом устройстве будут заменены."
        confirmLabel="Обновить"
        cancelLabel="Оставить"
        tone="danger"
        isBusy={editorClosePending}
        onClose={() => setCloudReloadConfirm(false)}
        onConfirm={() => {
          setEditorClosePending(true);
          void cloudDraft
            .reload()
            ?.then(() => setCloudReloadConfirm(false))
            .catch((error) =>
              pushToast({
                tone: 'danger',
                title: describeUserFacingError(error, 'Не удалось загрузить черновик'),
              }),
            )
            .finally(() => setEditorClosePending(false));
        }}
      />

      <ActionConfirmSheet
        id="publication-editor-close"
        open={pendingEditorClose}
        title="Закрыть без сохранения?"
        summary="Внесённые изменения будут потеряны."
        confirmLabel="Закрыть"
        cancelLabel="Остаться"
        tone="danger"
        isBusy={isBusy}
        onClose={() => setPendingEditorClose(false)}
        onConfirm={() => {
          setPendingEditorClose(false);
          restoreCreateDraftAndClose();
        }}
      />

      <ActionConfirmSheet
        id="publication-draft-clear"
        open={pendingDraftClear}
        title="Очистить черновик?"
        confirmLabel="Очистить"
        cancelLabel="Оставить"
        tone="danger"
        isBusy={isBusy}
        onClose={() => setPendingDraftClear(false)}
        onConfirm={confirmDraftClear}
      />

      <ActionConfirmSheet
        id="publication-revision-conflict"
        open={revisionConflictPublicationId !== null}
        title="Публикация изменилась"
        summary="Ваши правки будут перенесены в актуальную версию."
        confirmLabel="Обновить"
        cancelLabel="Остаться"
        tone="accent"
        isBusy={refreshEditedPublicationMutation.isPending}
        onClose={() =>
          !refreshEditedPublicationMutation.isPending && setRevisionConflictPublicationId(null)
        }
        onConfirm={() =>
          revisionConflictPublicationId &&
          refreshEditedPublicationMutation.mutate(revisionConflictPublicationId)
        }
      />

      <ActionConfirmSheet
        id="publication-conflict"
        open={pendingConflict}
        title="Есть пересечение"
        summary="Будут отменены только будущие отправки в совпадающее время для выбранных получателей. Уже опубликованные сообщения и другие даты останутся без изменений."
        previewTitle={formatDraftTiming(draft)}
        previewMeta={`Получатели: ${formatTargetSummary(draft.targets)}`}
        confirmLabel="Отменить и сохранить"
        cancelLabel="Другое время"
        tone="danger"
        isBusy={saveMutation.isPending}
        onClose={() => {
          setPendingConflict(false);
          setFieldError('Выберите другое время.');
        }}
        onConfirm={() => {
          setPendingConflict(false);
          submitPublication(true);
        }}
      />

      <PublicationActionSheet actions={publicationActions} />

      {detailsTarget ? (
        <Suspense fallback={null}>
          <LazyPublicationDetailsSheet
            api={api}
            publication={detailsTarget}
            allowEdit={isPublisherProfile}
            busy={anyBusy}
            covered={retryChoiceTarget !== null || ambiguousTarget !== null}
            publisherAccessRecheckBusy={scopedTargetRecheck.isBusy}
            publisherAccessRechecking={scopedTargetRecheck.isRechecking(detailsTarget.id)}
            onClose={() => setDetailsTarget(null)}
            onCancel={(publication) => {
              setDetailsTarget(null);
              setActionTarget({ publication, action: 'cancel' });
            }}
            onEdit={(publicationId) => {
              const publication =
                [...currentItems, ...scheduleItems, ...historyItems].find(
                  (item) => item.id === publicationId,
                ) ?? (detailsTarget.id === publicationId ? detailsTarget : null);
              if (publication) {
                openPublicationEditor(publication, 'edit');
              }
            }}
            onRecheckPublisherAccess={isPublisherProfile ? scopedTargetRecheck.recheck : undefined}
            onRetry={requestPublicationRetry}
            onResolveAmbiguous={(publicationId, occurrenceId, deliveryId, resolution) =>
              setAmbiguousTarget({ publicationId, occurrenceId, deliveryId, resolution })
            }
          />
        </Suspense>
      ) : null}
      <PublicationDeliveryActionSheets actions={publicationActions} />
    </div>
  );
}

export default PublicationsPage;
