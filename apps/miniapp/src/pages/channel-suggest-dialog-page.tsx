import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type { ChannelDialogMessage, ChannelDialogResponse } from '@maxim/contracts/channel-dialog';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeSuggestionSubscriptionError } from '../lib/channel-suggestion-subscription-error';

import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ComponentType,
  type FormEvent as ReactFormEvent,
} from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { MaxMarkdownTool } from '../components/max-markdown-editor';
import { PublicDialogUnavailableState } from '../components/public-dialog-unavailable-state';
import type { MaxRichTextEditorHandle } from '../components/max-rich-text-editor';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  buildChannelSuggestionThreadScope,
  clearChannelSuggestionDraft,
  flushChannelSuggestionDraftStorage,
  loadChannelSuggestionDraft,
  saveChannelSuggestionDraft,
} from '../features/channel-suggestions/channel-suggestion-draft-storage';
import type { ApiTransport } from '../lib/api/transport';
import {
  resolveSuggestionKeyboardLayout,
  type SuggestionKeyboardViewportBaseline,
} from '../lib/channel-suggestion-keyboard-layout';
import {
  createChannelSuggestionImagePreparationGuard,
  type ChannelSuggestionImagePreparationGuard,
} from '../lib/channel-suggestion-image-preparation';
import { cn } from '../lib/cn';
import {
  advanceContentBoundRequestIdentity,
  createContentBoundRequestIdentity,
  resolveContentBoundRequestIdentity,
} from '../lib/client-request-id';
import { resolveChannelDialogProfileCapabilities } from '../lib/channel-dialog-profile-capabilities';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/dialog-api-error';
import type { PreparedSuggestionAttachment } from '../lib/channel-suggestion-media';
import { openFileInputPicker, resolveFileInputActivationMode } from '../lib/file-input-picker';
import { maxSelectionChanged, setMaxClosingConfirmation } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/channel-dialog-suggest.css';
import '../styles/channel-dialog-mobile-actions.css';

const SUGGEST_DRAFT_MAX_LENGTH = 2_000;
const ATTACHMENT_SELECTION_DEDUPE_MS = 2_500;
const MAX_SUGGEST_IMAGES = 10;
const MAX_SUGGEST_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_SUGGEST_ATTACHMENTS_TOTAL_BASE64 = 24_000_000;
const MIN_SUGGEST_COMPOSER_VISIBLE_SPACE_PX = 100;

function LazySuggestionChunkLoadFailure() {
  return (
    <button
      type="button"
      className="button button--danger"
      onClick={() => window.location.reload()}
    >
      Обновить
    </button>
  );
}

function lazySuggestionComponent<TProps>(
  loader: () => Promise<{ default: ComponentType<TProps> }>,
  exportName: string,
  recoverAutomatically: boolean,
) {
  return lazy(async () => {
    try {
      return await loader();
    } catch (cause) {
      let reloading = false;
      if (recoverAutomatically) {
        try {
          const recovery = await import('../lib/lazy-load-recovery');
          reloading = recovery.reloadAfterLazyPageLoadFailure(exportName, cause);
        } catch {
          // Keep the explicit reload action available when the recovery chunk also failed.
        }
      }
      if (reloading) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }

      return { default: LazySuggestionChunkLoadFailure as ComponentType<TProps> };
    }
  });
}

const loadChannelSuggestionComposeImageGrid = () =>
  import('../components/channel-suggestion-compose-image-grid');
const LazyChannelSuggestionComposeImageGrid = lazySuggestionComponent(
  loadChannelSuggestionComposeImageGrid,
  'ChannelSuggestionComposeImageGrid',
  false,
);
const loadChannelSuggestionHistory = () => import('../components/channel-suggestion-history');
const LazyChannelSuggestionHistory = lazySuggestionComponent(
  loadChannelSuggestionHistory,
  'ChannelSuggestionHistory',
  true,
);
const loadMaxRichTextEditor = () =>
  import('../components/max-rich-text-editor').then((module) => ({
    default: module.MaxRichTextEditor,
  }));
const LazyMaxRichTextEditor = lazySuggestionComponent(
  loadMaxRichTextEditor,
  'MaxRichTextEditor',
  true,
);
const LazySuggestionFormatToolbar = lazySuggestionComponent(
  () => import('../components/channel-suggestion-format-toolbar'),
  'ChannelSuggestionFormatToolbar',
  true,
);

type SuggestDraftAttachment = PreparedSuggestionAttachment;

const LazySuggestionPreview = lazy(() =>
  import('../components/max-markdown-preview').then((module) => ({
    default: module.MaxMarkdownPreview,
  })),
);

type PreparingImageState = {
  total: number;
  done: number;
};

type TerminalDialogErrorState = readonly [chatId: string, token: string, message: string];

type ChannelDialogClientModule = typeof import('../lib/api/channel-dialog-client');
let channelDialogClientPromise: Promise<ChannelDialogClientModule> | null = null;

function loadChannelDialogClient(): Promise<ChannelDialogClientModule> {
  channelDialogClientPromise ??= import('../lib/api/channel-dialog-client').catch(
    (error: unknown) => {
      channelDialogClientPromise = null;
      throw error;
    },
  );
  return channelDialogClientPromise;
}

async function getChannelSuggestDialog(
  api: ApiTransport,
  chatId: string,
  token: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChannelDialogResponse> {
  const response = await api.request(
    `/channels/${chatId}/dialog/suggest?token=${encodeURIComponent(token)}`,
    request,
  );
  return response as ChannelDialogResponse;
}

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось отправить сообщение.';
  }

  const normalized = error.message.trim();
  if (!normalized) {
    return 'Не удалось отправить сообщение.';
  }

  if (normalized.startsWith('API request failed:')) {
    const details = normalized.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось отправить сообщение.';
  }

  return normalized;
}

function calculateDraftAttachmentsBase64Length(attachments: SuggestDraftAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.base64.length, 0);
}

function mergeDialogMessage(
  current: ChannelDialogMessage,
  next: ChannelDialogMessage,
): ChannelDialogMessage {
  return {
    ...current,
    ...next,
    avatarUrl: next.avatarUrl ?? current.avatarUrl ?? null,
  };
}

function updateDialogMessage(
  dialog: ChannelDialogResponse | undefined,
  message: ChannelDialogMessage,
): ChannelDialogResponse | undefined {
  if (!dialog) {
    return dialog;
  }

  const existingIndex = dialog.messages.findIndex((item) => item.id === message.id);
  if (existingIndex < 0) {
    return {
      ...dialog,
      messages: [...dialog.messages, message],
    };
  }

  return {
    ...dialog,
    messages: dialog.messages.map((item) =>
      item.id === message.id ? mergeDialogMessage(item, message) : item,
    ),
  };
}

function buildAttachmentSelectionSignature(files: File[]): string {
  return files
    .map((file) => [file.name, file.size, file.type, file.lastModified].join(':'))
    .join('|');
}

function SuggestionRequirements({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return null;
  }

  return (
    <details className="channel-suggest-requirements">
      <summary className="channel-suggest-requirements__label">Требования канала</summary>
      <div className="channel-suggest-requirements__text">
        {paragraphs.map((paragraph, index) => (
          <p key={`${paragraph}-${index}`}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}

export function ChannelSuggestDialogPage({
  api,
  profile,
  userId,
}: {
  api: ApiTransport;
  profile: MiniappProfile;
  userId: string;
}) {
  const { chatId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const draftThreadScope = buildChannelSuggestionThreadScope(token) ?? '';
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'compose' | 'preview' | 'history'>('compose');
  const [isImportingText, setIsImportingText] = useState(false);
  const [activeTools, setActiveTools] = useState<ReadonlySet<MaxMarkdownTool>>(() => new Set());
  const [editorReady, setEditorReady] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<SuggestDraftAttachment[]>([]);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftImagesNeedReselection, setDraftImagesNeedReselection] = useState(false);
  const [missingDraftImageCount, setMissingDraftImageCount] = useState(0);
  const [preparingImageState, setPreparingImageState] = useState<PreparingImageState | null>(null);
  const [terminalDialogErrorState, setTerminalDialogErrorState] =
    useState<TerminalDialogErrorState | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const suggestComposerRef = useRef<HTMLElement | null>(null);
  const suggestBarRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const richTextEditorRef = useRef<MaxRichTextEditorHandle | null>(null);
  const requestIdentityRef = useRef(createContentBoundRequestIdentity());
  const draftValueRef = useRef(draft);
  const draftAttachmentsRef = useRef(draftAttachments);
  const draftSaveTimerRef = useRef<number | null>(null);
  const suggestionKeyboardBaselineRef = useRef<SuggestionKeyboardViewportBaseline | null>(null);
  const imagePreparationGuardRef = useRef<ChannelSuggestionImagePreparationGuard | null>(null);
  imagePreparationGuardRef.current ??= createChannelSuggestionImagePreparationGuard();
  const imagePreparationGuard = imagePreparationGuardRef.current;
  const attachmentInputWatchCleanupRef = useRef<(() => void) | null>(null);
  const lastHandledAttachmentSelectionRef = useRef<string | null>(null);
  const recentAttachmentSelectionRef = useRef<{ signature: string; handledAt: number } | null>(
    null,
  );
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { canUploadSuggestionImages: canUploadImages } =
    resolveChannelDialogProfileCapabilities(profile);
  const fileInputActivationMode = resolveFileInputActivationMode(
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.maxPlatform,
  );
  const useNativeTapFileInputs = fileInputActivationMode === 'native-tap';
  const dialogQueryKey = [
    ...queryKeys.entityDialog('channel', chatId, 'suggest', token),
    profile,
    userId,
  ];
  const terminalDialogError =
    terminalDialogErrorState?.[0] === chatId && terminalDialogErrorState[1] === token
      ? terminalDialogErrorState[2]
      : null;
  const shouldLoadDialog = Boolean(chatId && token) && !terminalDialogError;

  const dialogQuery = useQuery({
    queryKey: dialogQueryKey,
    queryFn: ({ signal }) => getChannelSuggestDialog(api, chatId, token, { signal }),
    enabled: shouldLoadDialog,
    retry: (failureCount, error) =>
      !isTerminalDialogApiMessage(normalizeApiError(error)) && failureCount < 1,
    refetchOnWindowFocus: !terminalDialogError,
    retryOnMount: !terminalDialogError,
    refetchInterval: (query) => {
      const message = query.state.error ? normalizeApiError(query.state.error) : '';
      if (message && isTerminalDialogApiMessage(message)) {
        return false;
      }

      return view === 'history' ? 8_000 : false;
    },
  });

  useEffect(() => {
    if (terminalDialogError) {
      return;
    }

    const message = dialogQuery.error ? normalizeApiError(dialogQuery.error) : '';
    if (!message || !isTerminalDialogApiMessage(message)) {
      return;
    }

    setTerminalDialogErrorState([chatId, token, message]);
    void queryClient.cancelQueries({ queryKey: dialogQueryKey });
  }, [chatId, dialogQuery.error, dialogQueryKey, queryClient, terminalDialogError, token]);

  const messages = dialogQuery.data?.messages ?? [];
  const hasMoreMessages = dialogQuery.data?.hasMoreMessages === true;
  const introText = dialogQuery.data?.introText?.trim() ?? '';
  const draftLength = draft.trim().length;
  const isPreparingImage = preparingImageState !== null;
  const canSubmitMessage =
    !isPreparingImage &&
    !isImportingText &&
    !draftImagesNeedReselection &&
    draftLength <= SUGGEST_DRAFT_MAX_LENGTH &&
    (draftLength > 0 || (canUploadImages && draftAttachments.length > 0));
  const suggestPreparingImageSlots = preparingImageState?.total ?? 0;
  const suggestVisibleImageCount = Math.min(
    draftAttachments.length + suggestPreparingImageSlots,
    MAX_SUGGEST_IMAGES,
  );
  const suggestPreparingImageLabel = preparingImageState
    ? `Готовим ${Math.min(preparingImageState.done + 1, preparingImageState.total)}/${preparingImageState.total}`
    : null;

  const resetAttachmentPicker = () => {
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;
    lastHandledAttachmentSelectionRef.current = null;
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
  };

  const markDraftContentChanged = () => {
    requestIdentityRef.current = advanceContentBoundRequestIdentity(requestIdentityRef.current);
  };

  const handleDraftTextChange = (value: string) => {
    if (draftValueRef.current === value) {
      return;
    }
    draftValueRef.current = value;
    markDraftContentChanged();
    setDraft(value);
  };

  useEffect(
    () => () => {
      imagePreparationGuard.cancel();
      resetAttachmentPicker();
    },
    [],
  );

  useEffect(() => {
    if (canUploadImages) {
      return;
    }
    imagePreparationGuard.cancel();
    setDraftAttachments((current) => {
      if (current.length > 0) {
        draftAttachmentsRef.current = [];
        markDraftContentChanged();
      }
      return [];
    });
    setPreparingImageState(null);
    setDraftImagesNeedReselection(false);
    setMissingDraftImageCount(0);
    resetAttachmentPicker();
  }, [canUploadImages, imagePreparationGuard]);

  useLayoutEffect(() => {
    const screen = screenRef.current;
    const bar = suggestBarRef.current;
    if (!screen || !bar) {
      return undefined;
    }

    const updateBarHeight = () => {
      screen.style.setProperty(
        '--suggest-bar-height',
        `${Math.ceil(bar.getBoundingClientRect().height)}px`,
      );
    };

    updateBarHeight();
    const observer = new ResizeObserver(updateBarHeight);
    observer.observe(bar);
    window.addEventListener('resize', updateBarHeight, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBarHeight);
      screen.style.removeProperty('--suggest-bar-height');
    };
  }, [dialogQuery.isSuccess]);

  const blurSuggestComposerFocus = () => {
    if (typeof document === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    const composer = suggestComposerRef.current;
    const bar = suggestBarRef.current;
    if (
      activeElement instanceof HTMLElement &&
      ((composer && composer.contains(activeElement)) || (bar && bar.contains(activeElement)))
    ) {
      activeElement.blur();
    }
    screenRef.current?.classList.remove('is-suggest-editor-focused');
    screenRef.current?.style.removeProperty('--suggest-keyboard-reserve');
    suggestionKeyboardBaselineRef.current = null;
  };

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const screen = screenRef.current;
    const viewport = scrollViewportRef.current;
    const composer = suggestComposerRef.current;
    if (!screen || !viewport || !composer) {
      return undefined;
    }

    let frameId = 0;
    let isEditorFocused = false;
    const timers = new Set<number>();

    const isSuggestEditorTarget = (target: EventTarget | null): target is Element =>
      target instanceof Element &&
      composer.contains(target) &&
      Boolean(
        target.closest('.max-rich-text-editor__surface, .max-rich-text-editor__link-panel input'),
      );

    const readKeyboardOverlap = () => {
      const rawValue = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue('--app-keyboard-overlap');
      const value = Number.parseFloat(rawValue);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };

    const getFocusedAnchor = (): HTMLElement => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && composer.contains(activeElement)) {
        const linkPanel = activeElement.closest<HTMLElement>('.max-rich-text-editor__link-panel');
        const editorSurface = activeElement.closest<HTMLElement>('.max-rich-text-editor__surface');
        return linkPanel ?? editorSurface ?? activeElement;
      }

      return composer;
    };

    const readKeyboardLayout = () => {
      const visualViewport = window.visualViewport;
      const layoutHeight = window.innerHeight;
      const visualHeight = visualViewport?.height ?? layoutHeight;
      const baseline = suggestionKeyboardBaselineRef.current ?? {
        layoutHeight,
        visualHeight,
      };
      suggestionKeyboardBaselineRef.current = baseline;

      return resolveSuggestionKeyboardLayout({
        focused: isEditorFocused,
        fallbackEligible:
          document.documentElement.dataset.maxClient === 'native' ||
          Math.min(window.innerWidth, visualViewport?.width ?? window.innerWidth) <= 640,
        layoutHeight,
        visualHeight,
        visualOffsetTop: visualViewport?.offsetTop ?? 0,
        containerBottom: screen.getBoundingClientRect().bottom,
        keyboardOverlap: readKeyboardOverlap(),
        fallbackMaxReservePx: Math.max(
          0,
          screen.getBoundingClientRect().bottom -
            viewport.getBoundingClientRect().top -
            (suggestBarRef.current?.getBoundingClientRect().height ?? 0) -
            MIN_SUGGEST_COMPOSER_VISIBLE_SPACE_PX,
        ),
        baseline,
      });
    };

    const syncKeyboardReserve = () => {
      if (!isEditorFocused) {
        screen.style.removeProperty('--suggest-keyboard-reserve');
        return null;
      }

      const layout = readKeyboardLayout();
      if (layout.barReservePx > 0) {
        screen.style.setProperty('--suggest-keyboard-reserve', `${layout.barReservePx}px`);
      } else {
        screen.style.removeProperty('--suggest-keyboard-reserve');
      }
      return layout;
    };

    const setEditorFocused = (focused: boolean) => {
      isEditorFocused = focused;
      screen.classList.toggle('is-suggest-editor-focused', focused);
      if (focused) {
        syncKeyboardReserve();
        return;
      }

      screen.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
    };

    const keepFocusedEditorVisible = (behavior: ScrollBehavior) => {
      if (!isEditorFocused) {
        return;
      }

      const visualViewport = window.visualViewport;
      const viewportRect = viewport.getBoundingClientRect();
      const visualTop = visualViewport?.offsetTop ?? 0;
      const keyboardLayout = syncKeyboardReserve();
      if (!keyboardLayout) {
        return;
      }
      const visibleTop = Math.max(viewportRect.top, visualTop);
      const visibleBottom = Math.min(viewportRect.bottom, keyboardLayout.visibleBottomPx);
      const barTop = suggestBarRef.current?.getBoundingClientRect().top;
      const protectedBottom =
        typeof barTop === 'number' ? Math.min(visibleBottom, barTop - 12) : visibleBottom;
      const targetRect = getFocusedAnchor().getBoundingClientRect();
      const bottomGap = targetRect.bottom + 18 - protectedBottom;

      if (bottomGap > 1) {
        viewport.scrollBy({ top: Math.ceil(bottomGap), behavior });
        return;
      }

      const topGap = visibleTop + 10 - targetRect.top;
      if (topGap > 1) {
        viewport.scrollBy({ top: -Math.ceil(topGap), behavior });
      }
    };

    const scheduleKeepVisible = (behavior: ScrollBehavior = 'auto') => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => keepFocusedEditorVisible(behavior));
    };

    const scheduleSettlingPasses = () => {
      scheduleKeepVisible('smooth');
      for (const delay of [80, 180, 320]) {
        const timerId = window.setTimeout(() => {
          timers.delete(timerId);
          scheduleKeepVisible('auto');
        }, delay);
        timers.add(timerId);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isSuggestEditorTarget(event.target)) {
        return;
      }

      setEditorFocused(true);
      scheduleSettlingPasses();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (isSuggestEditorTarget(event.relatedTarget)) {
        return;
      }

      setEditorFocused(false);
    };

    const handleViewportChange = () => {
      syncKeyboardReserve();
      scheduleKeepVisible('auto');
    };

    composer.addEventListener('focusin', handleFocusIn);
    composer.addEventListener('focusout', handleFocusOut);
    composer.addEventListener('input', handleViewportChange);
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);

    if (isSuggestEditorTarget(document.activeElement)) {
      setEditorFocused(true);
      scheduleSettlingPasses();
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      screen.classList.remove('is-suggest-editor-focused');
      screen.style.removeProperty('--suggest-keyboard-reserve');
      suggestionKeyboardBaselineRef.current = null;
      for (const timerId of timers) {
        window.clearTimeout(timerId);
      }
      composer.removeEventListener('focusin', handleFocusIn);
      composer.removeEventListener('focusout', handleFocusOut);
      composer.removeEventListener('input', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [dialogQuery.isSuccess]);

  const appendDraftAttachments = (nextAttachments: SuggestDraftAttachment[]) => {
    if (nextAttachments.length === 0) {
      return;
    }

    const current = draftAttachmentsRef.current;
    const accepted = [...current];
    let totalBase64Length = calculateDraftAttachmentsBase64Length(current);
    let rejectedByCount = 0;
    let rejectedBySize = 0;
    let rejectedAsDuplicate = 0;

    for (const attachment of nextAttachments) {
      if (
        accepted.some(
          (existing) =>
            existing.mimeType === attachment.mimeType && existing.base64 === attachment.base64,
        )
      ) {
        rejectedAsDuplicate += 1;
        continue;
      }
      if (accepted.length >= MAX_SUGGEST_IMAGES) {
        rejectedByCount += 1;
        continue;
      }

      if (attachment.base64.length > MAX_SUGGEST_IMAGE_BASE64_LENGTH) {
        rejectedBySize += 1;
        continue;
      }

      const nextTotalBase64Length = totalBase64Length + attachment.base64.length;
      if (nextTotalBase64Length > MAX_SUGGEST_ATTACHMENTS_TOTAL_BASE64) {
        rejectedBySize += 1;
        continue;
      }

      accepted.push(attachment);
      totalBase64Length = nextTotalBase64Length;
    }

    const addedCount = accepted.length - current.length;
    if (addedCount === 0) {
      pushToast({
        tone: 'danger',
        title:
          rejectedAsDuplicate > 0 && rejectedBySize === 0 && rejectedByCount === 0
            ? 'Это фото уже добавлено'
            : rejectedBySize > 0
              ? 'Фото слишком тяжёлые'
              : 'Слишком много фото',
        description:
          rejectedByCount > 0
            ? `Можно добавить до ${MAX_SUGGEST_IMAGES} фото.`
            : 'Уберите часть фото и попробуйте снова.',
      });
      return;
    }

    if (rejectedByCount > 0 || rejectedBySize > 0 || rejectedAsDuplicate > 0) {
      pushToast({
        tone: 'info',
        title: `Добавили ${addedCount} из ${nextAttachments.length}`,
        description:
          rejectedByCount > 0
            ? `Можно добавить до ${MAX_SUGGEST_IMAGES} фото. Остальные не добавлены.`
            : rejectedBySize > 0
              ? 'Часть фото не добавили, потому что суммарный размер получился слишком большим.'
              : 'Повторяющиеся фото не добавили.',
      });
    }

    maxSelectionChanged();
    markDraftContentChanged();
    const nextMissingCount = Math.max(0, missingDraftImageCount - addedCount);
    setMissingDraftImageCount(nextMissingCount);
    setDraftImagesNeedReselection(nextMissingCount > 0);
    draftAttachmentsRef.current = accepted;
    setDraftAttachments(accepted);
  };

  const prepareDraftImagesFromFiles = async (files: File[]) => {
    if (draftAttachmentsRef.current.some((attachment) => attachment.type === 'video')) {
      pushToast({
        tone: 'info',
        title: 'В предложении уже есть видео',
        description: 'Уберите его, чтобы добавить фотографии.',
      });
      resetAttachmentPicker();
      return;
    }
    if (files.length === 0) {
      if (!imagePreparationGuard.isActive()) {
        resetAttachmentPicker();
      }
      return;
    }

    const preparationRun = imagePreparationGuard.tryStart();
    if (!preparationRun) {
      return;
    }

    try {
      const remainingSlots = Math.max(0, MAX_SUGGEST_IMAGES - draftAttachments.length);
      if (remainingSlots <= 0) {
        pushToast({
          tone: 'info',
          title: 'Больше фото не поместится',
          description: `Можно добавить до ${MAX_SUGGEST_IMAGES} фото.`,
        });
        return;
      }

      if (files.length > remainingSlots) {
        pushToast({
          tone: 'info',
          title: `Добавим ${remainingSlots} фото`,
          description:
            remainingSlots === MAX_SUGGEST_IMAGES
              ? `За один раз можно выбрать до ${MAX_SUGGEST_IMAGES} фото.`
              : `Сейчас осталось места только для ${remainingSlots} фото.`,
        });
      }

      const selectableFiles = files.slice(0, remainingSlots);
      setPreparingImageState({ total: selectableFiles.length, done: 0 });

      const { prepareSuggestionDialogImageAttachment, resolveSuggestionDialogImageMaxBytes } =
        await import('../lib/dialog-attachments');
      if (!imagePreparationGuard.owns(preparationRun)) {
        return;
      }

      const prepared: SuggestDraftAttachment[] = [];
      let firstError: string | null = null;
      const suggestionImageMaxBytes = resolveSuggestionDialogImageMaxBytes(
        selectableFiles.length,
        calculateDraftAttachmentsBase64Length(draftAttachments),
      );

      for (const file of selectableFiles) {
        if (!imagePreparationGuard.owns(preparationRun)) {
          return;
        }

        try {
          const attachment = await prepareSuggestionDialogImageAttachment(file, {
            maxBytes: suggestionImageMaxBytes,
          });
          if (!imagePreparationGuard.owns(preparationRun)) {
            return;
          }
          prepared.push({ ...attachment, type: 'image' });
        } catch (error: unknown) {
          if (!imagePreparationGuard.owns(preparationRun)) {
            return;
          }
          if (!firstError) {
            firstError = describeUserFacingError(error, 'Не удалось подготовить фото');
          }
        } finally {
          if (imagePreparationGuard.owns(preparationRun)) {
            setPreparingImageState((current) =>
              current ? { ...current, done: Math.min(current.total, current.done + 1) } : current,
            );
          }
        }
      }

      if (!imagePreparationGuard.owns(preparationRun)) {
        return;
      }

      if (prepared.length > 0) {
        appendDraftAttachments(prepared);
      }

      if (firstError) {
        pushToast({
          tone: 'danger',
          title: 'Фото не добавлено',
          description: firstError,
        });
      }
    } catch (error: unknown) {
      if (imagePreparationGuard.owns(preparationRun)) {
        pushToast({
          tone: 'danger',
          title: 'Фото не добавлено',
          description: describeUserFacingError(error, 'Не удалось подготовить фото'),
        });
      }
    } finally {
      if (imagePreparationGuard.finish(preparationRun)) {
        resetAttachmentPicker();
        setPreparingImageState(null);
      }
    }
  };

  const handleDraftImageInputSelection = (input: HTMLInputElement | null): boolean => {
    const files = Array.from(input?.files ?? []);
    if (files.length === 0) {
      return false;
    }

    const signature = buildAttachmentSelectionSignature(files);
    const recentSelection = recentAttachmentSelectionRef.current;
    if (
      recentSelection?.signature === signature &&
      Date.now() - recentSelection.handledAt < ATTACHMENT_SELECTION_DEDUPE_MS
    ) {
      attachmentInputWatchCleanupRef.current?.();
      attachmentInputWatchCleanupRef.current = null;
      return true;
    }

    if (lastHandledAttachmentSelectionRef.current === signature) {
      attachmentInputWatchCleanupRef.current?.();
      attachmentInputWatchCleanupRef.current = null;
      return true;
    }

    lastHandledAttachmentSelectionRef.current = signature;
    recentAttachmentSelectionRef.current = {
      signature,
      handledAt: Date.now(),
    };
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;
    void prepareDraftImagesFromFiles(files);
    return true;
  };

  const armImageInputWatcher = () => {
    attachmentInputWatchCleanupRef.current?.();
    attachmentInputWatchCleanupRef.current = null;

    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !imageInputRef.current ||
      imageInputRef.current.disabled
    ) {
      return;
    }

    const input = imageInputRef.current;
    const timeoutIds = new Set<number>();
    const scheduleDrain = (delays: number[]) => {
      for (const delay of delays) {
        const timeoutId = window.setTimeout(() => {
          timeoutIds.delete(timeoutId);
          handleDraftImageInputSelection(input);
        }, delay);
        timeoutIds.add(timeoutId);
      }
    };

    const handleFocus = () => {
      scheduleDrain([80, 320, 900]);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleDrain([80, 320, 900]);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleDrain([240, 900, 1600, 4200, 8200]);

    attachmentInputWatchCleanupRef.current = () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };
  };

  const handleDraftImagesChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    handleDraftImageInputSelection(event.currentTarget);
  };

  const handleVideoFile = async (file: File | undefined) => {
    if (!file || isSubmitPending) return;
    if (draftAttachmentsRef.current.length) {
      pushToast({
        tone: 'info',
        title: 'Сначала уберите выбранные вложения',
        description: 'Можно отправить до 10 фото или одно видео.',
      });
      return;
    }
    const run = imagePreparationGuard.tryStart();
    if (!run) return;
    setPreparingImageState({ total: 1, done: 0 });
    try {
      const { prepareSuggestionVideo } = await import('../lib/channel-suggestion-media');
      const attachment = await prepareSuggestionVideo(file);
      if (!imagePreparationGuard.owns(run)) return;
      markDraftContentChanged();
      draftAttachmentsRef.current = [attachment];
      setDraftAttachments([attachment]);
      setDraftImagesNeedReselection(false);
      setMissingDraftImageCount(0);
      maxSelectionChanged();
    } catch (error: unknown) {
      if (imagePreparationGuard.owns(run))
        pushToast({
          tone: 'danger',
          title: 'Видео не добавлено',
          description: describeUserFacingError(error, 'Не удалось прочитать видео'),
        });
    } finally {
      if (imagePreparationGuard.finish(run)) setPreparingImageState(null);
    }
  };

  const moveDraftAttachment = (index: number, direction: -1 | 1) => {
    const next = [...draftAttachmentsRef.current];
    const target = index + direction;
    if (isSubmitPending || imagePreparationGuard.isActive() || target < 0 || target >= next.length)
      return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    markDraftContentChanged();
    draftAttachmentsRef.current = next;
    setDraftAttachments(next);
    maxSelectionChanged();
  };

  const importTextFile = async (file: File | undefined) => {
    if (!file || isComposerBusy) return;
    const run = imagePreparationGuard.tryStart();
    if (!run) return;
    setIsImportingText(true);
    const initialRevision = requestIdentityRef.current.draftRevision;
    try {
      const { readSuggestionTextFile } = await import('../lib/channel-suggestion-media');
      const next = await readSuggestionTextFile(
        file,
        draftValueRef.current,
        SUGGEST_DRAFT_MAX_LENGTH,
      );
      if (!imagePreparationGuard.owns(run)) return;
      if (requestIdentityRef.current.draftRevision !== initialRevision) {
        pushToast({
          tone: 'info',
          title: 'Текст изменился во время загрузки',
          description: 'Выберите файл ещё раз, чтобы добавить его к текущему тексту.',
        });
        return;
      }
      handleDraftTextChange(next);
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: 'Текст не добавлен',
        description: describeUserFacingError(error, 'Не удалось прочитать текст'),
      });
    } finally {
      if (imagePreparationGuard.finish(run)) setIsImportingText(false);
    }
  };

  const handleDraftImagesInput = (event: ReactFormEvent<HTMLInputElement>) => {
    handleDraftImageInputSelection(event.currentTarget);
  };

  const handleDraftAttachmentRemove = (index: number) => {
    const current = draftAttachmentsRef.current;
    const next = current.filter((_, attachmentIndex) => attachmentIndex !== index);
    if (next.length === current.length) {
      return;
    }
    const restoresMissingSlot = draftImagesNeedReselection;
    markDraftContentChanged();
    draftAttachmentsRef.current = next;
    setDraftAttachments(next);
    if (restoresMissingSlot) {
      setMissingDraftImageCount((current) => Math.min(MAX_SUGGEST_IMAGES, current + 1));
    }
    maxSelectionChanged();
    resetAttachmentPicker();
  };

  const handleDiscardMissingDraftImages = () => {
    if (!draftImagesNeedReselection) {
      return;
    }
    markDraftContentChanged();
    setDraftImagesNeedReselection(false);
    setMissingDraftImageCount(0);
  };

  const sendMutation = useMutation({
    mutationFn: (payload: {
      requestId: string;
      text: string;
      attachments: SuggestDraftAttachment[];
    }) =>
      Promise.all([loadChannelDialogClient(), import('../lib/channel-suggestion-media')]).then(
        ([{ createChannelDialogMessage }, { toSuggestionMediaPayload }]) =>
          createChannelDialogMessage(api, chatId, 'suggest', {
            token,
            requestId: payload.requestId,
            text: payload.text,
            textFormat: 'markdown',
            ...toSuggestionMediaPayload(canUploadImages ? payload.attachments : []),
          }),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<ChannelDialogResponse | undefined>(dialogQueryKey, (current) =>
        updateDialogMessage(current, result.message),
      );
      pushToast({
        tone: 'success',
        title: 'Предложение отправлено',
      });
      setDraft('');
      setView('history');
      draftValueRef.current = '';
      setDraftAttachments([]);
      draftAttachmentsRef.current = [];
      setDraftImagesNeedReselection(false);
      setMissingDraftImageCount(0);
      requestIdentityRef.current = createContentBoundRequestIdentity();
      void clearChannelSuggestionDraft({
        userId,
        chatId,
        profile,
        threadScope: draftThreadScope,
      });
      resetAttachmentPicker();
      void loadChannelSuggestionHistory()
        .catch(() => undefined)
        .then(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const viewport = scrollViewportRef.current;
              viewport?.scrollTo({
                top: 0,
                behavior: 'smooth',
              });
            });
          });
        });
      void queryClient.invalidateQueries({
        queryKey: dialogQueryKey,
      });
    },
    onError: (error) => {
      const subscriptionMessage = describeSuggestionSubscriptionError(error);
      if (subscriptionMessage) {
        pushToast({ tone: 'danger', title: subscriptionMessage });
        return;
      }
      const message = normalizeApiError(error);
      if (isTerminalDialogApiMessage(message)) {
        setTerminalDialogErrorState([chatId, token, message]);
        void queryClient.cancelQueries({ queryKey: dialogQueryKey });
        return;
      }

      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отправить предложение'),
      });
    },
  });

  const isSubmitPending = sendMutation.isPending;
  const isComposerBusy = isSubmitPending || isPreparingImage || isImportingText || !editorReady;
  const submitDisabled = !canSubmitMessage || isSubmitPending || !editorReady;

  useEffect(() => {
    setDraftHydrated(false);
    if (!dialogQuery.isSuccess || !userId.trim() || !chatId.trim()) {
      return undefined;
    }
    let cancelled = false;
    const initialRevision = requestIdentityRef.current.draftRevision;
    void loadChannelSuggestionDraft({
      userId,
      chatId,
      profile,
      threadScope: draftThreadScope,
    })
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (
          stored &&
          requestIdentityRef.current.draftRevision === initialRevision &&
          draftValueRef.current.length === 0 &&
          draftAttachmentsRef.current.length === 0
        ) {
          draftValueRef.current = stored.text;
          draftAttachmentsRef.current = stored.attachments;
          requestIdentityRef.current = stored.requestIdentity;
          setDraft(stored.text);
          setDraftAttachments(stored.attachments);
          setDraftImagesNeedReselection(stored.imagesNeedReselection);
          setMissingDraftImageCount(stored.missingImageCount);
        }
        setDraftHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setDraftHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, dialogQuery.isSuccess, draftThreadScope, profile, userId]);

  useEffect(() => {
    if (!draftHydrated || !userId.trim()) {
      return undefined;
    }
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      if (
        !draftValueRef.current.trim() &&
        draftAttachmentsRef.current.length === 0 &&
        !draftImagesNeedReselection
      ) {
        void clearChannelSuggestionDraft({
          userId,
          chatId,
          profile,
          threadScope: draftThreadScope,
        });
        return;
      }
      void saveChannelSuggestionDraft(
        { userId, chatId, profile, threadScope: draftThreadScope },
        {
          text: draftValueRef.current,
          attachments: draftAttachmentsRef.current,
          requestIdentity: requestIdentityRef.current,
          imagesNeedReselection: draftImagesNeedReselection,
          imageCount: draftImagesNeedReselection
            ? draftAttachmentsRef.current.length + missingDraftImageCount
            : draftAttachmentsRef.current.length,
        },
      );
    }, 250);
    return () => {
      if (draftSaveTimerRef.current !== null) {
        window.clearTimeout(draftSaveTimerRef.current);
      }
    };
  }, [
    chatId,
    draft,
    draftAttachments,
    draftHydrated,
    draftImagesNeedReselection,
    draftThreadScope,
    missingDraftImageCount,
    profile,
    userId,
  ]);

  const shouldProtectClose =
    isSubmitPending ||
    isImportingText ||
    isPreparingImage ||
    draftImagesNeedReselection ||
    Boolean(draft.trim()) ||
    draftAttachments.length > 0;
  useEffect(() => {
    setMaxClosingConfirmation(shouldProtectClose);
    const persistLatestDraft = () => {
      if (!draftHydrated || !userId.trim()) {
        return;
      }
      void saveChannelSuggestionDraft(
        { userId, chatId, profile, threadScope: draftThreadScope },
        {
          text: draftValueRef.current,
          attachments: draftAttachmentsRef.current,
          requestIdentity: requestIdentityRef.current,
          imagesNeedReselection: draftImagesNeedReselection,
          imageCount: draftImagesNeedReselection
            ? draftAttachmentsRef.current.length + missingDraftImageCount
            : draftAttachmentsRef.current.length,
        },
      ).then(() =>
        flushChannelSuggestionDraftStorage({
          userId,
          chatId,
          profile,
          threadScope: draftThreadScope,
        }),
      );
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldProtectClose) {
        return;
      }
      persistLatestDraft();
      event.preventDefault();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && shouldProtectClose) {
        persistLatestDraft();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      setMaxClosingConfirmation(false);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    chatId,
    draftHydrated,
    draftImagesNeedReselection,
    draftThreadScope,
    missingDraftImageCount,
    profile,
    shouldProtectClose,
    userId,
  ]);

  const applySuggestTextModifier = (tool: MaxMarkdownTool) => {
    if (isComposerBusy) {
      return;
    }

    richTextEditorRef.current?.applyTool(tool);
    maxSelectionChanged();
  };

  const onSubmit = () => {
    const text = draft.trim();
    if (
      imagePreparationGuard.isActive() ||
      isSubmitPending ||
      draftImagesNeedReselection ||
      !chatId ||
      !token ||
      draftLength > SUGGEST_DRAFT_MAX_LENGTH ||
      (!text && (!canUploadImages || draftAttachments.length === 0))
    ) {
      return;
    }

    void loadChannelSuggestionHistory().catch(() => undefined);
    const resolvedRequest = resolveContentBoundRequestIdentity(
      requestIdentityRef.current,
      'publisher-suggestion',
    );
    requestIdentityRef.current = resolvedRequest.identity;
    void saveChannelSuggestionDraft(
      { userId, chatId, profile, threadScope: draftThreadScope },
      {
        text,
        attachments: canUploadImages ? draftAttachments : [],
        requestIdentity: resolvedRequest.identity,
        imagesNeedReselection: draftImagesNeedReselection,
        imageCount: draftImagesNeedReselection
          ? draftAttachments.length + missingDraftImageCount
          : draftAttachments.length,
      },
    );
    sendMutation.mutate({
      requestId: resolvedRequest.requestId,
      text,
      attachments: canUploadImages ? draftAttachments : [],
    });
  };

  if (terminalDialogError) {
    const sessionExpired = isSessionExpiredApiMessage(terminalDialogError);
    return (
      <PublicDialogUnavailableState
        tone={sessionExpired ? 'danger' : undefined}
        title={sessionExpired ? 'Нужно открыть приложение заново' : 'Диалог недоступен'}
        description={
          sessionExpired
            ? 'Закройте мини-приложение и откройте этот диалог снова из сообщения в MAX.'
            : terminalDialogError
        }
      />
    );
  }

  if (!chatId) {
    return (
      <PublicDialogUnavailableState
        title="Канал не найден"
        description="Откройте диалог заново из сообщения."
      />
    );
  }

  if (!token) {
    return (
      <PublicDialogUnavailableState
        title="Кнопка устарела"
        description="Откройте сообщение и нажмите кнопку ещё раз."
      />
    );
  }

  const suggestImageControl = canUploadImages ? (
    <div className="channel-suggest-composer__tools">
      {useNativeTapFileInputs ? (
        <label
          className={cn(
            'channel-suggest-composer__tool',
            isComposerBusy && 'is-disabled',
            draftAttachments.length > 0 && 'is-active',
          )}
          onClick={() => {
            blurSuggestComposerFocus();
            armImageInputWatcher();
          }}
        >
          <input
            ref={imageInputRef}
            className="channel-dialog-compose__attach-input"
            type="file"
            accept="image/*"
            multiple
            disabled={isComposerBusy}
            aria-label={`Добавить до ${MAX_SUGGEST_IMAGES} фото`}
            onChange={handleDraftImagesChange}
            onInput={handleDraftImagesInput}
            onClickCapture={armImageInputWatcher}
            onPointerDownCapture={armImageInputWatcher}
            tabIndex={isComposerBusy ? -1 : 0}
          />
          <IconoirSprite variant="iconoir" icon="Attachment" aria-hidden focusable="false" />
        </label>
      ) : (
        <>
          <button
            type="button"
            className={cn(
              'channel-suggest-composer__tool',
              draftAttachments.length > 0 && 'is-active',
            )}
            aria-label={`Добавить до ${MAX_SUGGEST_IMAGES} фото`}
            disabled={isComposerBusy}
            onClick={() => {
              blurSuggestComposerFocus();
              armImageInputWatcher();
              openFileInputPicker(imageInputRef.current);
            }}
          >
            <IconoirSprite variant="iconoir" icon="Attachment" aria-hidden focusable="false" />
          </button>
          <input
            ref={imageInputRef}
            className="channel-dialog-compose__picker-input"
            type="file"
            accept="image/*"
            multiple
            disabled={isComposerBusy}
            onChange={handleDraftImagesChange}
            onInput={handleDraftImagesInput}
            onClickCapture={armImageInputWatcher}
            onPointerDownCapture={armImageInputWatcher}
            tabIndex={-1}
          />
        </>
      )}

      <label
        className={cn(
          'channel-suggest-composer__tool',
          'channel-suggest-composer__video-tool',
          isComposerBusy && 'is-disabled',
        )}
        title="Добавить видео до 24 МБ"
      >
        <IconoirSprite variant="iconoir" icon="VideoCamera" aria-hidden />
        <span aria-hidden>до 24 МБ</span>
        <input
          className="channel-dialog-compose__attach-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
          aria-label="Добавить видео до 24 МБ"
          disabled={isComposerBusy}
          onClick={blurSuggestComposerFocus}
          onChange={(event) => {
            const input = event.currentTarget;
            void handleVideoFile(input.files?.[0]).finally(() => {
              input.value = '';
            });
          }}
        />
      </label>
      <label
        className={cn('channel-suggest-composer__tool', isComposerBusy && 'is-disabled')}
        title="Добавить текст из файла"
      >
        <IconoirSprite variant="iconoir" icon="Page" aria-hidden />
        <input
          className="channel-dialog-compose__attach-input"
          type="file"
          accept="text/plain,text/markdown,.txt,.md,.markdown"
          aria-label="Добавить текст из файла"
          disabled={isComposerBusy}
          onClick={blurSuggestComposerFocus}
          onChange={(event) => {
            const input = event.currentTarget;
            void importTextFile(input.files?.[0]).finally(() => {
              input.value = '';
            });
          }}
        />
      </label>
      {suggestPreparingImageLabel ? (
        <span className="channel-suggest-composer__asset">{suggestPreparingImageLabel}</span>
      ) : null}
    </div>
  ) : null;

  const formatToolbar = (
    <Suspense
      fallback={<div className="channel-suggest-composer__modifier-row" aria-busy="true" />}
    >
      <LazySuggestionFormatToolbar
        disabled={isComposerBusy}
        activeTools={activeTools}
        onApply={applySuggestTextModifier}
      />
    </Suspense>
  );

  const suggestBar =
    !dialogQuery.isLoading && !dialogQuery.error ? (
      <div
        ref={suggestBarRef}
        className="channel-suggest-composer__bar channel-suggest-composer__bar--anchored"
        hidden={view === 'history'}
      >
        {suggestImageControl}
        <span />

        <button
          type="button"
          className="channel-suggest-composer__submit"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {isSubmitPending ? (
            <span className="channel-dialog-submit__loader" aria-hidden />
          ) : (
            <IconoirSprite
              variant="iconoir"
              icon="SendDiagonalSolid"
              aria-hidden
              focusable="false"
            />
          )}
          <span>{isSubmitPending ? 'Отправка' : 'Отправить'}</span>
        </button>
      </div>
    ) : null;

  return (
    <div
      ref={screenRef}
      className="channel-dialog-screen channel-dialog-screen--suggest page-enter"
      data-view={view}
    >
      <div className="channel-dialog-screen__backdrop" aria-hidden />

      <div className="channel-dialog-shell channel-dialog-shell--suggest">
        <header className="channel-suggest-heading">
          <h1>Предложить объявление</h1>
          <span>{profile === 'publisher' ? 'Публик' : 'Майор'}</span>
        </header>
        <div className="channel-suggest-tabs" role="tablist" aria-label="Предложения">
          {(
            [
              { value: 'compose', label: 'Написать' },
              { value: 'preview', label: 'Предпросмотр' },
              {
                value: 'history',
                label: `Мои${messages.length ? ` · ${messages.length}${hasMoreMessages ? '+' : ''}` : ''}`,
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={view === tab.value}
              aria-controls={`suggest-${tab.value}`}
              id={`suggest-tab-${tab.value}`}
              tabIndex={view === tab.value ? 0 : -1}
              onKeyDown={(event) => {
                const tabs = ['compose', 'preview', 'history'] as const;
                const index = tabs.indexOf(tab.value);
                const nextIndex =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null;
                if (nextIndex === null) return;
                event.preventDefault();
                blurSuggestComposerFocus();
                const nextView = tabs[nextIndex];
                setView(nextView);
                scrollViewportRef.current?.scrollTo({ top: 0 });
                document.getElementById(`suggest-tab-${nextView}`)?.focus({ preventScroll: true });
              }}
              onClick={() => {
                blurSuggestComposerFocus();
                setView(tab.value);
                scrollViewportRef.current?.scrollTo({ top: 0 });
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <section ref={scrollViewportRef} className="channel-dialog-body channel-suggest-body">
          {dialogQuery.isLoading ? (
            <div className="channel-dialog-skeletons" aria-label="Загрузка">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="channel-dialog-skeleton">
                  <span className="channel-dialog-skeleton__avatar" />
                  <div className="channel-dialog-skeleton__body">
                    <span className="channel-dialog-skeleton__line is-short" />
                    <span className="channel-dialog-skeleton__line" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {dialogQuery.error ? (
            <div className="channel-dialog-error">
              <StatusState
                tone="danger"
                title="Не удалось загрузить"
                description={describeUserFacingError(
                  dialogQuery.error,
                  'Не удалось загрузить предложения',
                )}
                action={
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => void dialogQuery.refetch()}
                  >
                    Повторить
                  </button>
                }
              />
            </div>
          ) : null}

          {!dialogQuery.isLoading && !dialogQuery.error ? (
            <div className="channel-suggest-workspace">
              {introText && view === 'compose' ? <SuggestionRequirements text={introText} /> : null}

              <section
                ref={suggestComposerRef}
                className={cn(
                  'channel-suggest-composer',
                  canSubmitMessage && 'is-ready',
                  isComposerBusy && 'is-busy',
                )}
                aria-label="Предложить объявление"
                id="suggest-compose"
                role="tabpanel"
                aria-labelledby="suggest-tab-compose"
                hidden={view !== 'compose'}
              >
                <div className="channel-suggest-composer__head">
                  <span className="channel-suggest-composer__status">
                    {isImportingText ? 'Загрузка текста' : 'Черновик'}
                  </span>
                  <span
                    className={cn(
                      'channel-suggest-composer__counter',
                      draftLength > SUGGEST_DRAFT_MAX_LENGTH && 'is-limit',
                    )}
                    aria-live="polite"
                  >
                    {draftLength}/{SUGGEST_DRAFT_MAX_LENGTH}
                  </span>
                </div>
                {formatToolbar}

                {draftImagesNeedReselection ? (
                  <div className="channel-suggest-composer__restore-warning" role="alert">
                    <span>
                      {missingDraftImageCount > 1
                        ? `Не удалось восстановить ${missingDraftImageCount} вложений. Добавьте их снова.`
                        : 'Не удалось восстановить вложение. Добавьте файл снова.'}
                    </span>
                    <button
                      type="button"
                      disabled={isSubmitPending || isPreparingImage}
                      onClick={handleDiscardMissingDraftImages}
                    >
                      {draftAttachments.length > 0 ? 'Оставить выбранные' : 'Без вложений'}
                    </button>
                  </div>
                ) : null}

                <div
                  className={cn(
                    'channel-suggest-composer__phone',
                    !draft.trim() &&
                      draftAttachments.length === 0 &&
                      suggestPreparingImageSlots === 0 &&
                      'is-empty',
                  )}
                >
                  <div className="channel-suggest-composer__bubble">
                    {canUploadImages && suggestVisibleImageCount > 0 ? (
                      <Suspense
                        fallback={
                          <div
                            className={cn(
                              'channel-suggest-composer__image-grid',
                              `is-count-${suggestVisibleImageCount}`,
                              'is-busy',
                            )}
                            role="list"
                            aria-label="Готовим фото"
                            aria-busy="true"
                          >
                            {Array.from({ length: suggestVisibleImageCount }, (_, index) => (
                              <div
                                key={index}
                                className="channel-suggest-composer__image-tile is-loading"
                                role="listitem"
                              >
                                <span
                                  className="channel-suggest-composer__image-loader"
                                  aria-hidden
                                >
                                  <IconoirSprite
                                    variant="iconoir"
                                    icon="Attachment"
                                    aria-hidden
                                    focusable="false"
                                  />
                                </span>
                              </div>
                            ))}
                          </div>
                        }
                      >
                        <LazyChannelSuggestionComposeImageGrid
                          attachments={draftAttachments}
                          preparingCount={suggestPreparingImageSlots}
                          busy={isSubmitPending || suggestPreparingImageSlots > 0}
                          maxImages={MAX_SUGGEST_IMAGES}
                          onRemove={handleDraftAttachmentRemove}
                          onMove={moveDraftAttachment}
                        />
                      </Suspense>
                    ) : null}

                    <div className="channel-suggest-composer__field">
                      <Suspense
                        fallback={
                          <div
                            className="channel-suggest-composer__rich-editor"
                            role="textbox"
                            aria-label="Текст объявления"
                            aria-busy="true"
                          />
                        }
                      >
                        <LazyMaxRichTextEditor
                          ref={richTextEditorRef}
                          value={draft}
                          onChange={handleDraftTextChange}
                          placeholder="Текст объявления"
                          maxLength={SUGGEST_DRAFT_MAX_LENGTH}
                          disabled={isSubmitPending}
                          onNormalizationReadyChange={setEditorReady}
                          onActiveToolsChange={setActiveTools}
                          ariaLabel="Текст объявления"
                          className="channel-suggest-composer__rich-editor"
                          onPasteFiles={canUploadImages ? prepareDraftImagesFromFiles : undefined}
                        />
                      </Suspense>
                    </div>

                    <span className="channel-suggest-composer__tail" aria-hidden />
                  </div>
                </div>
              </section>

              {view === 'preview' ? (
                <section
                  className="channel-suggest-preview"
                  role="tabpanel"
                  id="suggest-preview"
                  aria-labelledby="suggest-tab-preview"
                >
                  {draftAttachments.length > 0 ? (
                    <Suspense fallback={null}>
                      <LazyChannelSuggestionComposeImageGrid
                        attachments={draftAttachments}
                        maxImages={MAX_SUGGEST_IMAGES}
                        onRemove={handleDraftAttachmentRemove}
                        preview
                      />
                    </Suspense>
                  ) : null}
                  <Suspense fallback={null}>
                    <LazySuggestionPreview
                      value={draft}
                      preserveLinks
                      fallback={<span className="channel-suggest-empty">Текст не добавлен</span>}
                    />
                  </Suspense>
                </section>
              ) : null}

              {view === 'history' ? (
                <section role="tabpanel" id="suggest-history" aria-labelledby="suggest-tab-history">
                  {hasMoreMessages && messages.length > 0 ? (
                    <p className="channel-suggest-empty" role="status">
                      Показаны последние {messages.length}
                    </p>
                  ) : null}
                  {messages.length ? (
                    <Suspense
                      fallback={
                        <div className="channel-dialog-skeletons" aria-label="Загрузка истории">
                          <div className="channel-dialog-skeleton">
                            <span className="channel-dialog-skeleton__avatar" />
                            <div className="channel-dialog-skeleton__body">
                              <span className="channel-dialog-skeleton__line is-short" />
                              <span className="channel-dialog-skeleton__line" />
                            </div>
                          </div>
                        </div>
                      }
                    >
                      <LazyChannelSuggestionHistory messages={messages} />
                    </Suspense>
                  ) : (
                    <p className="channel-suggest-empty" role="status">
                      Предложений пока нет
                    </p>
                  )}
                </section>
              ) : null}
            </div>
          ) : null}
        </section>

        {suggestBar}
      </div>
    </div>
  );
}
