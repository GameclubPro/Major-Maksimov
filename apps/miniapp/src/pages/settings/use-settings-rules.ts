import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  chatRulesSchema,
  MAX_CHAT_RULES_TEXT_LENGTH,
  type ChatRules,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { ApiRequestError } from '../../lib/api-request-error';
import type { UpdateChatRulesPayload } from '../../lib/api/shared-types';
import {
  getRules,
  updateRules,
  publishRules,
  resetPublishedRules,
} from '../../lib/api/chat-settings-client';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { maxNotify } from '../../lib/max-bridge';
import type { useToast } from '../../components/ui/toast';
import type { RulesTextScreenState } from '../settings-rules-text';
import {
  getRulesPublicationFeedback,
  type RulesPublicationMode,
  mergeSavedRulesIntoSettingsScreen,
  mergeRulesPublicationIntoDraft,
  runRulesSaveAttempt,
  serializeRulesDraftPayload,
  shouldHydrateRulesDraftFromServer,
} from '../settings-rules-state';
import {
  formatApiError,
  AUTO_SAVE_DELAY_MS,
  DEFAULT_RULES_POST_BUTTON_TEXT,
} from './settings-page-helpers';
type Dependencies = {
  api: ApiTransport;
  chatId: string | undefined;
  serverRules: ChatRules | undefined;
  rulesModuleOpen?: boolean;
  currentRulesTextSource: RulesTextScreenState | null;
  isUpdatingRulesAttachment: boolean;
  pushToast: ReturnType<typeof useToast>['pushToast'];
};
export function useSettingsRules({
  api,
  chatId,
  serverRules,
  rulesModuleOpen = false,
  currentRulesTextSource,
  isUpdatingRulesAttachment,
  pushToast,
}: Dependencies) {
  const queryClient = useQueryClient();
  const identity = useMemo(() => ({ chatId }), [chatId]);
  const active = useRef<typeof identity | null>(identity);
  active.current = identity;
  const isCurrentRulesScope = () => active.current === identity;
  const [rulesDraft, setOwnedRulesDraft] = useState<ChatRules | null>(null);
  // FLAG: Save, image and leave-guard callbacks are bound to one visit, including revisits.
  const setRulesDraft: Dispatch<SetStateAction<ChatRules | null>> = (update) => {
    if (!isCurrentRulesScope()) return;
    setOwnedRulesDraft((current) =>
      !isCurrentRulesScope() ? current : typeof update === 'function' ? update(current) : update,
    );
  };
  const [rulesPublicationMode, setRulesPublicationMode] =
    useState<RulesPublicationMode>('new_message');
  const [rulesTextError, setRulesTextError] = useState('');
  const [rulesImageError, setRulesImageError] = useState('');
  const [isPreparingRulesImage, setIsPreparingRulesImage] = useState(false);
  const rulesImagePreparingRef = useRef(false);
  const [rulesButtonErrors, setRulesButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>([]);
  const [rulesButtonFieldsTouched, setRulesButtonFieldsTouched] = useState(false);
  const [rulesButtonsSheetOpen, setRulesButtonsSheetOpen] = useState(false);
  const [rulesButtonRevealSignal, setRulesButtonRevealSignal] = useState(0);
  const [rulesResetConfirmationOpen, setRulesResetConfirmationOpen] = useState(false);
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const [rulesSaveConflict, setRulesSaveConflict] = useState(false);
  const [isPreparingRulesPublish, setIsPreparingRulesPublish] = useState(false);
  const rulesPreparationRef = useRef(false);
  const [rulesResetPendingMessageId, setRulesResetPendingMessageId] = useState<string | null>(null);
  const [isCheckingRulesPublication, setIsCheckingRulesPublication] = useState(false);
  const checkingRulesPublicationRef = useRef<typeof identity | null>(null);
  const rulesReadEpochRef = useRef(0);
  const rulesDraftRef = useRef<ChatRules | null>(null);
  const previousRulesServerSnapshotRef = useRef('');
  const rulesDraftBaseSnapshotRef = useRef('');
  useLayoutEffect(() => {
    rulesDraftRef.current = rulesDraft;
  }, [rulesDraft]);

  useLayoutEffect(() => {
    active.current = identity;
    setOwnedRulesDraft(null);
    rulesDraftRef.current = null;
    previousRulesServerSnapshotRef.current = '';
    rulesDraftBaseSnapshotRef.current = '';
    rulesImagePreparingRef.current = false;
    setIsPreparingRulesImage(false);
    setRulesPublicationMode('new_message');
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonsSheetOpen(false);
    setRulesButtonRevealSignal(0);
    setRulesFailedSnapshot('');
    setRulesSaveConflict(false);
    setIsPreparingRulesPublish(false);
    rulesPreparationRef.current = false;
    setRulesResetConfirmationOpen(false);
    setRulesResetPendingMessageId(null);
    setIsCheckingRulesPublication(false);
    checkingRulesPublicationRef.current = null;
    saveRulesMutation.reset();
    publishRulesMutation.reset();
    resetPublishedRulesMutation.reset();
    return () => {
      if (active.current === identity) active.current = null;
    };
  }, [identity]);

  function handleRulesImagePreparationChange(preparing: boolean) {
    if (!isCurrentRulesScope()) return;
    rulesImagePreparingRef.current = preparing;
    setIsPreparingRulesImage(preparing);
    if (preparing) setRulesImageError('');
  }

  useEffect(() => {
    if (!serverRules) {
      return;
    }

    const nextServerDraft = chatRulesSchema.parse(serverRules);
    setRulesResetPendingMessageId((pending) =>
      pending && (nextServerDraft.publishedMessageId ?? nextServerDraft.publishedUrl) === pending
        ? pending
        : null,
    );
    const shouldHydrate = shouldHydrateRulesDraftFromServer({
      currentDraft: rulesDraftRef.current,
      previousServerSnapshot: previousRulesServerSnapshotRef.current,
      nextServerDraft,
    });
    previousRulesServerSnapshotRef.current = serializeRulesDraftPayload(nextServerDraft);
    if (!shouldHydrate) {
      setRulesDraft((current) =>
        mergeRulesPublicationIntoDraft(current, nextServerDraft, rulesDraftBaseSnapshotRef.current),
      );
      return;
    }

    rulesDraftBaseSnapshotRef.current = serializeRulesDraftPayload(nextServerDraft);
    setRulesDraft(nextServerDraft);
    setRulesSaveConflict(false);
    setRulesTextError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonRevealSignal(0);
  }, [serverRules, identity]);

  const rulesDraftSnapshot = useMemo(
    () => (rulesDraft ? serializeRulesDraftPayload(rulesDraft) : ''),
    [rulesDraft],
  );

  const rulesServerSnapshot = useMemo(
    () => (serverRules ? serializeRulesDraftPayload(serverRules) : ''),
    [serverRules],
  );

  const hasRulesChanges = Boolean(
    rulesDraft && serverRules && rulesDraftSnapshot !== rulesServerSnapshot,
  );
  const rulesPublication = rulesDraft ?? serverRules;
  const rulesPublishedMessageId = rulesPublication?.publishedMessageId ?? null;
  const rulesPublishedUrl = rulesPublication?.publishedUrl ?? null;
  const hasPublishedRules = Boolean(rulesPublishedMessageId || rulesPublishedUrl);
  const isRulesResetPending = Boolean(rulesResetPendingMessageId);
  const refreshRulesPublication = useCallback(
    async (reportError = false) => {
      if (!identity.chatId || active.current !== identity || checkingRulesPublicationRef.current) {
        return;
      }
      checkingRulesPublicationRef.current = identity;
      const requestEpoch = rulesReadEpochRef.current;
      setIsCheckingRulesPublication(true);
      try {
        const updated = await getRules(api, identity.chatId);
        // FLAG: An older read cannot overwrite a newer write or a later visit to the same chat.
        if (active.current !== identity || rulesReadEpochRef.current !== requestEpoch) return;
        queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
          ['settings-screen', identity.chatId],
          (current) => mergeSavedRulesIntoSettingsScreen(current, updated),
        );
      } catch (error) {
        if (reportError && active.current === identity) {
          pushToast({
            tone: 'danger',
            title: 'Не удалось проверить удаление',
            description: formatApiError(error),
          });
        }
      } finally {
        if (checkingRulesPublicationRef.current === identity) {
          checkingRulesPublicationRef.current = null;
        }
        if (active.current === identity) setIsCheckingRulesPublication(false);
      }
    },
    [api, identity, pushToast, queryClient],
  );
  useEffect(() => {
    if (!rulesModuleOpen || !rulesResetPendingMessageId) return;
    const delays = [1_000, 3_000, 8_000];
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (stopped || attempt === delays.length) return;
      timer = setTimeout(() => {
        attempt += 1;
        void refreshRulesPublication().finally(schedule);
      }, delays[attempt]);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [rulesModuleOpen, rulesResetPendingMessageId, refreshRulesPublication]);
  const saveRulesMutation = useMutation({
    mutationFn: (request: { identity: typeof identity; payload: UpdateChatRulesPayload }) =>
      updateRules(api, request.identity.chatId ?? '', request.payload),
    onSuccess: (saved, { identity: requestScope, payload }) => {
      if (active.current !== requestScope) {
        void queryClient.invalidateQueries({ queryKey: ['settings-screen', requestScope.chatId] });
        return;
      }
      rulesReadEpochRef.current += 1;
      const payloadSnapshot = serializeRulesDraftPayload(payload);
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', requestScope.chatId],
        (current) => mergeSavedRulesIntoSettingsScreen(current, saved),
      );
      rulesDraftBaseSnapshotRef.current = serializeRulesDraftPayload(saved);
      setRulesDraft((current) => {
        if (!current) {
          return saved;
        }
        const currentSnapshot = serializeRulesDraftPayload(current);
        return currentSnapshot === payloadSnapshot ? saved : current;
      });
      setRulesTextError('');
      setRulesButtonErrors([]);
      setRulesButtonFieldsTouched(false);
      setRulesButtonRevealSignal(0);
      setRulesFailedSnapshot('');
      setRulesSaveConflict(false);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', requestScope.chatId] });
    },
    onError: (error, { identity: requestScope, payload }) => {
      if (active.current !== requestScope) return;
      rulesReadEpochRef.current += 1;
      if (error instanceof ApiRequestError && error.status === 409) {
        setRulesSaveConflict(true);
        void refreshRulesPublication();
      }
      setRulesFailedSnapshot(serializeRulesDraftPayload(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить черновик правил',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingRules = saveRulesMutation.isPending;
  const mutateRules = useCallback(
    (payload: UpdateChatRulesPayload) => {
      if (active.current === identity) {
        rulesReadEpochRef.current += 1;
        saveRulesMutation.mutate({ identity, payload });
      }
    },
    [identity, saveRulesMutation.mutate],
  );
  const mutateRulesAsync = (payload: UpdateChatRulesPayload) => {
    rulesReadEpochRef.current += 1;
    return saveRulesMutation.mutateAsync({ identity, payload });
  };

  const publishRulesMutation = useMutation({
    mutationFn: (request: {
      identity: typeof identity;
      mode: RulesPublicationMode;
      previousMessageId: string | null;
    }) => publishRules(api, request.identity.chatId ?? '', { mode: request.mode }),
    onSuccess: (result, request) => {
      if (active.current === request.identity) rulesReadEpochRef.current += 1;
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', request.identity.chatId],
      });
      if (active.current !== request.identity) return;
      setRulesResetPendingMessageId(null);
      const updated = chatRulesSchema.parse({
        ...(rulesDraft ?? serverRules ?? {}),
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAt: result.publishedAt,
      });
      setRulesDraft(updated);
      pushToast({
        tone: 'success',
        ...getRulesPublicationFeedback(result, request.previousMessageId),
      });
      maxNotify('success');
    },
    onError: (error, request) => {
      if (active.current === request.identity) rulesReadEpochRef.current += 1;
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', request.identity.chatId],
      });
      if (active.current !== request.identity) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать правила',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isPublishingRules = publishRulesMutation.isPending;

  const resetPublishedRulesMutation = useMutation({
    mutationFn: (request: {
      identity: typeof identity;
      serverSnapshot: string;
      targetReceipt: string | null;
    }) => resetPublishedRules(api, request.identity.chatId ?? ''),
    onSuccess: (updated, request) => {
      if (active.current !== request.identity) {
        void queryClient.invalidateQueries({
          queryKey: ['settings-screen', request.identity.chatId],
        });
        return;
      }
      rulesReadEpochRef.current += 1;
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', request.identity.chatId],
        (current) => mergeSavedRulesIntoSettingsScreen(current, updated),
      );
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', request.identity.chatId],
      });
      const returnedReceipt = updated.publishedMessageId ?? updated.publishedUrl;
      const resetPending = Boolean(returnedReceipt && returnedReceipt === request.targetReceipt);
      setRulesResetPendingMessageId(resetPending ? returnedReceipt : null);
      setRulesDraft((current) =>
        mergeRulesPublicationIntoDraft(current, updated, request.serverSnapshot),
      );
      pushToast({
        tone: returnedReceipt ? 'info' : 'success',
        title: resetPending
          ? 'Пост правил ещё удаляется'
          : returnedReceipt
            ? 'В чате уже другой пост правил'
            : 'Пост правил удалён',
        ...(resetPending ? { description: 'Подождите немного и повторите публикацию.' } : {}),
      });
    },
    onError: (error, request) => {
      if (active.current === request.identity) rulesReadEpochRef.current += 1;
      void queryClient.invalidateQueries({
        queryKey: ['settings-screen', request.identity.chatId],
      });
      if (active.current !== request.identity) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить пост правил',
        description: formatApiError(error),
      });
    },
  });
  const isResettingPublishedRules = resetPublishedRulesMutation.isPending;

  const isRulesDraftEditingDisabled =
    isPreparingRulesPublish ||
    isPublishingRules ||
    isResettingPublishedRules ||
    isUpdatingRulesAttachment;
  const isRulesBusy = isSavingRules || isRulesDraftEditingDisabled || isPreparingRulesImage;
  function validateRulesDraft(
    value: ChatRules,
    options: { forceButtonErrors?: boolean } = {},
  ): UpdateChatRulesPayload | null {
    const normalizedText = value.text;
    if (normalizedText.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return null;
    }
    setRulesTextError('');

    if (value.imageBase64) {
      if (!value.imageMimeType.toLowerCase().startsWith('image/')) {
        setRulesImageError('Поддерживаются только изображения.');
        return null;
      }
    }

    const shouldShowButtonErrors = Boolean(options.forceButtonErrors || rulesButtonFieldsTouched);
    const normalizedButtonState = buildBroadcastLinkButtonLegacyFields(value.buttons);
    if (value.buttonEnabled) {
      const nextButtonErrors = validateBroadcastLinkButtons(value.buttons);
      if (hasBroadcastLinkButtonErrors(nextButtonErrors)) {
        setRulesButtonErrors(shouldShowButtonErrors ? nextButtonErrors : []);
        return null;
      }
      setRulesButtonErrors([]);
    } else {
      setRulesButtonErrors([]);
    }

    /* eslint-disable @typescript-eslint/no-unused-vars -- Rest excludes server-only metadata. */
    const {
      publishedMessageId: _publishedMessageId,
      publishedUrl: _publishedUrl,
      publishedAt: _publishedAt,
      revision: _revision,
      ...editableDraft
    } = value;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return {
      ...editableDraft,
      expectedRevision: value.revision ?? null,
      buttonUrl: normalizedButtonState.buttonUrl,
      buttonText: normalizedButtonState.buttonText,
      adminContactButtonUrl: value.adminContactButtonEnabled ? value.adminContactButtonUrl : '',
    };
  }
  function reportRulesAutofillError(error: unknown) {
    if (!isCurrentRulesScope()) return;
    const description = error instanceof Error ? error.message : 'Не удалось собрать текст правил.';
    setRulesTextError(description);
    pushToast({
      tone: 'danger',
      title: 'Не удалось собрать текст правил',
      description,
    });
    maxNotify('error');
  }
  async function buildRulesDraftFromCurrentSettings(value: ChatRules): Promise<ChatRules | null> {
    if (!currentRulesTextSource) {
      throw new Error('Настройки чата ещё загружаются.');
    }
    const snapshot = serializeRulesDraftPayload(value);
    const { buildRulesTextFromSettingsScreen } = await import('../settings-rules-text').catch(
      () => {
        throw new Error('Не удалось загрузить автотекст правил. Проверьте соединение и повторите.');
      },
    );
    // FLAG: Lazy preparation belongs to this visit and must not replace edits made while loading.
    if (
      !isCurrentRulesScope() ||
      rulesImagePreparingRef.current ||
      !rulesDraftRef.current ||
      serializeRulesDraftPayload(rulesDraftRef.current) !== snapshot
    ) {
      return null;
    }
    return {
      ...rulesDraftRef.current,
      autoTextEnabled: true,
      text: buildRulesTextFromSettingsScreen(currentRulesTextSource),
      textFormat: 'plain',
    };
  }
  function beginRulesPreparation(): boolean {
    if (
      !isCurrentRulesScope() ||
      rulesPreparationRef.current ||
      isRulesBusy ||
      rulesImagePreparingRef.current
    )
      return false;
    rulesPreparationRef.current = true;
    setIsPreparingRulesPublish(true);
    return true;
  }
  function endRulesPreparation() {
    if (!isCurrentRulesScope()) return;
    rulesPreparationRef.current = false;
    setIsPreparingRulesPublish(false);
  }
  async function handleRulesAutoTextChange(enabled: boolean) {
    if (!rulesDraft || !beginRulesPreparation()) return;
    try {
      if (!enabled) {
        setRulesTextError('');
        setRulesDraft((current) => (current ? { ...current, autoTextEnabled: false } : current));
        return;
      }
      const nextDraft = await buildRulesDraftFromCurrentSettings(rulesDraft);
      if (!isCurrentRulesScope() || !nextDraft) return;
      setRulesTextError('');
      rulesDraftRef.current = nextDraft;
      setRulesDraft(nextDraft);
    } catch (error) {
      reportRulesAutofillError(error);
    } finally {
      endRulesPreparation();
    }
  }
  async function prepareRulesDraftForSubmit(value: ChatRules): Promise<ChatRules | null> {
    if (!value.autoTextEnabled) {
      return value;
    }

    try {
      const nextDraft = await buildRulesDraftFromCurrentSettings(value);
      if (!isCurrentRulesScope() || !nextDraft) return null;
      setRulesTextError('');
      if (serializeRulesDraftPayload(nextDraft) !== serializeRulesDraftPayload(value)) {
        const applyAutofill = (current: ChatRules | null) =>
          current
            ? {
                ...current,
                text: nextDraft.text,
                textFormat: nextDraft.textFormat,
                autoTextEnabled: true,
              }
            : current;
        // FLAG: Fast save receipts must compare against this prepared draft, not the previous render.
        rulesDraftRef.current = applyAutofill(rulesDraftRef.current ?? value);
        setRulesDraft(applyAutofill);
      }
      return nextDraft;
    } catch (error) {
      reportRulesAutofillError(error);
      return null;
    }
  }
  async function saveRulesDraftNow(
    options: { forceButtonErrors?: boolean; draft?: ChatRules } = {},
  ): Promise<ChatRules | null> {
    const targetDraft = options.draft ?? rulesDraft;
    if (!targetDraft || rulesImagePreparingRef.current) {
      return null;
    }

    const payload = validateRulesDraft(targetDraft, options);
    if (!payload) {
      return null;
    }

    return mutateRulesAsync(payload);
  }
  async function handleSaveRulesDraft() {
    if (!rulesDraft || !hasRulesChanges || !beginRulesPreparation()) {
      return;
    }
    try {
      const preparedRulesDraft = await prepareRulesDraftForSubmit(rulesDraft);
      if (!isCurrentRulesScope() || !preparedRulesDraft) return;
      setIsPreparingRulesPublish(false);
      const attempt = await runRulesSaveAttempt({
        submittedDraft: preparedRulesDraft,
        save: () =>
          saveRulesDraftNow({
            forceButtonErrors: true,
            draft: preparedRulesDraft,
          }),
        getCurrentDraft: () => rulesDraftRef.current,
      });
      if (!isCurrentRulesScope() || !attempt?.isCurrent) {
        return;
      }
      pushToast({ tone: 'success', title: 'Черновик правил сохранён' });
      maxNotify('success');
    } catch {
      // The mutation reports the actionable error and keeps the draft available for retry.
    } finally {
      endRulesPreparation();
    }
  }
  async function handlePublishRules() {
    if (!chatId || !rulesDraft || !beginRulesPreparation()) {
      return;
    }
    try {
      const preparedRulesDraft = await prepareRulesDraftForSubmit(rulesDraft);
      if (!isCurrentRulesScope() || !preparedRulesDraft) return;
      if (!preparedRulesDraft.autoTextEnabled && !preparedRulesDraft.text.trim()) {
        setRulesTextError('Введите текст правил перед публикацией.');
        return;
      }
      setRulesTextError('');

      if (preparedRulesDraft.text.length > MAX_CHAT_RULES_TEXT_LENGTH) {
        setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
        return;
      }

      const nextRulesSnapshot = serializeRulesDraftPayload(preparedRulesDraft);
      const shouldSavePreparedRules = nextRulesSnapshot !== rulesServerSnapshot;

      if (
        !shouldSavePreparedRules &&
        !validateRulesDraft(preparedRulesDraft, { forceButtonErrors: true })
      ) {
        return;
      }

      if (shouldSavePreparedRules) {
        const attempt = await runRulesSaveAttempt({
          submittedDraft: preparedRulesDraft,
          save: () =>
            saveRulesDraftNow({
              forceButtonErrors: true,
              draft: preparedRulesDraft,
            }),
          getCurrentDraft: () => rulesDraftRef.current,
        });
        if (!isCurrentRulesScope() || !attempt) {
          return;
        }
        if (!attempt.isCurrent) {
          pushToast({
            tone: 'info',
            title: 'Правила изменились',
            description: 'Сохраните актуальную версию и повторите публикацию.',
          });
          maxNotify('warning');
          return;
        }
      }

      if (!isCurrentRulesScope()) return;
      rulesReadEpochRef.current += 1;
      publishRulesMutation.mutate({
        identity,
        mode: hasPublishedRules && !isRulesResetPending ? rulesPublicationMode : 'new_message',
        previousMessageId: rulesPublishedMessageId,
      });
    } catch {
      // The save mutation reports the actionable error and preserves the latest draft.
    } finally {
      endRulesPreparation();
    }
  }
  function handleResetPublishedRules() {
    if (
      !chatId ||
      !hasPublishedRules ||
      isRulesBusy ||
      rulesPreparationRef.current ||
      rulesImagePreparingRef.current
    ) {
      return;
    }
    if (isRulesResetPending) {
      void refreshRulesPublication(true);
      return;
    }

    setRulesResetConfirmationOpen(true);
  }
  function confirmResetPublishedRules() {
    if (
      !chatId ||
      !hasPublishedRules ||
      isRulesBusy ||
      rulesPreparationRef.current ||
      rulesImagePreparingRef.current
    )
      return;
    setRulesResetConfirmationOpen(false);
    rulesReadEpochRef.current += 1;
    resetPublishedRulesMutation.mutate({
      identity,
      serverSnapshot: rulesDraftBaseSnapshotRef.current,
      targetReceipt: rulesPublishedMessageId ?? rulesPublishedUrl,
    });
  }
  function handleRulesButtonsEnabledChange(enabled: boolean) {
    setRulesButtonFieldsTouched(true);
    setRulesButtonErrors([]);
    if (enabled && (rulesDraft?.buttons.length ?? 0) === 0) {
      setRulesButtonRevealSignal((value) => value + 1);
    }
    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      if (!enabled) {
        return {
          ...current,
          buttons: [],
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: DEFAULT_RULES_POST_BUTTON_TEXT,
        };
      }

      const buttons =
        current.buttons.length > 0 ? current.buttons : [createEmptyBroadcastLinkButton()];
      const buttonState = buildBroadcastLinkButtonLegacyFields(buttons);

      return {
        ...current,
        buttons,
        buttonEnabled: true,
        buttonUrl: buttonState.buttonUrl,
        buttonText: buttonState.buttonText,
      };
    });
  }
  function handleRulesAdminContactButtonChange(enabled: boolean, url: string) {
    setRulesDraft((current) =>
      current
        ? {
            ...current,
            adminContactButtonEnabled: enabled,
            adminContactButtonUrl: enabled ? url : '',
          }
        : current,
    );
  }
  useEffect(() => {
    if (!rulesFailedSnapshot || rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    setRulesFailedSnapshot('');
  }, [rulesDraftSnapshot, rulesFailedSnapshot]);

  useEffect(() => {
    if (
      !chatId ||
      !rulesDraft ||
      !hasRulesChanges ||
      isSavingRules ||
      isPreparingRulesImage ||
      isPreparingRulesPublish ||
      isPublishingRules ||
      isResettingPublishedRules ||
      rulesSaveConflict
    ) {
      return;
    }

    if (rulesFailedSnapshot && rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    const parsed = validateRulesDraft(rulesDraft);
    if (!parsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!rulesImagePreparingRef.current && !rulesPreparationRef.current) mutateRules(parsed);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    hasRulesChanges,
    isPreparingRulesImage,
    isPreparingRulesPublish,
    isPublishingRules,
    isResettingPublishedRules,
    isSavingRules,
    mutateRules,
    rulesButtonFieldsTouched,
    rulesDraft,
    rulesDraftSnapshot,
    rulesFailedSnapshot,
    rulesSaveConflict,
  ]);

  return {
    rulesDraft,
    setRulesDraft,
    rulesPublicationMode,
    setRulesPublicationMode,
    rulesTextError,
    setRulesTextError,
    rulesImageError,
    setRulesImageError: (value: SetStateAction<string>) => {
      if (isCurrentRulesScope()) setRulesImageError(value);
    },
    isPreparingRulesImage,
    handleRulesImagePreparationChange,
    rulesButtonErrors,
    setRulesButtonErrors,
    setRulesButtonFieldsTouched,
    rulesButtonsSheetOpen,
    setRulesButtonsSheetOpen,
    rulesButtonRevealSignal,
    isPreparingRulesPublish,
    rulesResetConfirmationOpen,
    setRulesResetConfirmationOpen,
    handleRulesAutoTextChange,
    saveRulesDraftNow,
    handleSaveRulesDraft,
    handlePublishRules,
    handleResetPublishedRules,
    confirmResetPublishedRules,
    handleRulesButtonsEnabledChange,
    handleRulesAdminContactButtonChange,
    hasRulesChanges,
    rulesPublishedUrl,
    hasPublishedRules,
    isRulesResetPending,
    isCheckingRulesPublication,
    isSavingRules,
    isPublishingRules,
    isResettingPublishedRules,
    isRulesDraftEditingDisabled,
    isRulesBusy,
  };
}
