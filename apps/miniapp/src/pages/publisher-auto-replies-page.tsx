import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type { BroadcastImage, BroadcastLinkButton } from '@maxim/contracts';
import {
  type PublisherAutoReplyAsset,
  type PublisherAutoReplyRuleV2,
} from '@maxim/contracts/publisher-auto-replies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AutoReplyCreateSheet } from '../components/auto-reply-create-sheet';
import type { AutoReplyMatchTesterProps } from '../components/auto-reply-match-tester';
import type { BotPermissionRequiredDialogProps } from '../components/bot-permission-required-dialog';
import type { BroadcastContentComposerProps } from '../components/broadcast-content-composer';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { Spinner } from '../components/ui/spinner';
import { useToast } from '../components/ui/toast';
import {
  archivePublisherAutoReply,
  cancelCurrentPublisherAutoReplyAuthoringSession,
  createPublisherAutoReply,
  createPublisherAutoReplyAuthoringSession,
  createPublisherAutoReplyRequestId,
  getCurrentPublisherAutoReplyAuthoringSession,
  getPublisherAutoReplyAsset,
  listPublisherAutoReplies,
  updatePublisherAutoReply,
} from '../lib/api/publisher-auto-replies-client';
import {
  getPublisherEntity,
  refreshPublisherEntity,
  updatePublisherModules,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BotPermissionBlocker } from '../lib/bot-permission-error';
import { cn } from '../lib/cn';
import { clearAutoReplyDraft } from '../lib/auto-reply-draft';
import { formatBroadcastButtonsStatus } from '../lib/broadcast-link-buttons';
import { useManagedEntityLeaveGuard } from '../lib/managed-entity-navigation';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { useAutoReplyDraft } from '../lib/use-auto-reply-draft';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import { describeUserFacingError } from '../lib/user-facing-error';
import type { PublicationButtonsSheetProps } from '../features/publications/publication-buttons-sheet';
import {
  AUTO_REPLY_COOLDOWN_OPTIONS,
  AUTO_REPLY_MAX_IMAGES,
  AUTO_REPLY_MAX_PHRASES,
  AUTO_REPLY_PHRASE_MAX_LENGTH,
  AUTO_REPLY_TEXT_MAX_LENGTH,
  buildPublisherChatModulesRoute,
  createEmptyAutoReplyDraft,
  getAutoReplyConflictKind,
  getAutoReplyCooldownLabel,
  getAutoReplyAuthoringStateLabel,
  getAutoReplyMatchModeLabel,
  getAutoReplyPhraseCountLabel,
  isActiveAutoReplyAuthoringState,
  isAutoReplyAuthoringConflictError,
  mergeAutoReplyPhrases,
  normalizeAutoReplyDraft,
  normalizeAutoReplyPhrase,
  splitAutoReplyPhrasePaste,
  validateAutoReplyDraft,
  validateAutoReplyTriggerDraft,
  type AutoReplyDraft,
  type AutoReplyDraftIssues,
} from './publisher-auto-replies-page-model';
import './publisher-auto-replies-page.css';
import '../styles/publisher-auto-replies-workspace.css';

const AUTO_REPLY_QUERY_ROOT = ['publisher-auto-replies'] as const;
const PUBLISHER_ENTITY_QUERY_ROOT = ['publisher-entity'] as const;

let botPermissionErrorModulePromise: Promise<typeof import('../lib/bot-permission-error')> | null =
  null;

function loadBotPermissionErrorModule() {
  botPermissionErrorModulePromise ??= import('../lib/bot-permission-error');
  return botPermissionErrorModulePromise;
}

const LazyBotPermissionRequiredDialog =
  recoverableLazyNamedComponent<BotPermissionRequiredDialogProps>(
    () => import('../components/bot-permission-required-dialog'),
    'BotPermissionRequiredDialog',
  );

const LazyAutoReplyMatchTester = recoverableLazyNamedComponent<AutoReplyMatchTesterProps>(
  () => import('../components/auto-reply-match-tester'),
  'AutoReplyMatchTester',
);

const LazyBroadcastContentComposer = recoverableLazyNamedComponent<BroadcastContentComposerProps>(
  () => import('../components/broadcast-content-composer'),
  'BroadcastContentComposer',
);

const PublicationButtonsSheet = recoverableLazyNamedComponent<PublicationButtonsSheetProps>(
  () => import('../features/publications/publication-buttons-sheet'),
  'PublicationButtonsSheet',
);

type EditorTarget = { kind: 'create' } | { kind: 'edit'; rule: PublisherAutoReplyRuleV2 };

function AutoReplySwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="auto-reply-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="auto-reply-switch__track" aria-hidden>
        <span className="auto-reply-switch__thumb" />
      </span>
    </label>
  );
}

function AutoReplyAssetThumbnail({
  api,
  chatId,
  ruleId,
  asset,
}: {
  api: ApiTransport;
  chatId: string;
  ruleId: string;
  asset: PublisherAutoReplyAsset;
}) {
  const [reload, setReload] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setFailed(false);
    void getPublisherAutoReplyAsset(api, chatId, ruleId, asset.id, {
      signal: controller.signal,
    }).then(
      (blob) => {
        if (controller.signal.aborted) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      },
      () => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      },
    );
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [api, asset.id, chatId, reload, ruleId]);

  if (failed) {
    return (
      <button
        type="button"
        className="publisher-auto-reply-asset is-error"
        onClick={() => setReload((value) => value + 1)}
        aria-label={`Повторить загрузку фото ${asset.fileName || asset.id}`}
      >
        <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
      </button>
    );
  }

  return (
    <span className="publisher-auto-reply-asset" aria-busy={!previewUrl || undefined}>
      {previewUrl ? <img src={previewUrl} alt="" /> : <Spinner size="sm" label={null} />}
    </span>
  );
}

function RetainedAssetEditorItem({
  api,
  chatId,
  ruleId,
  asset,
  disabled,
  onRemove,
}: {
  api: ApiTransport;
  chatId: string;
  ruleId: string;
  asset: PublisherAutoReplyAsset;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <figure className="publisher-auto-reply-editor__retained-item">
      <AutoReplyAssetThumbnail api={api} chatId={chatId} ruleId={ruleId} asset={asset} />
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Убрать фото ${asset.fileName || asset.id}`}
        title="Убрать фото"
      >
        <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
      </button>
    </figure>
  );
}

function createDraftFromRule(rule: PublisherAutoReplyRuleV2): AutoReplyDraft {
  return {
    phrases: rule.phrases,
    matchInContext: rule.matchInContext,
    fuzzyMatch: rule.fuzzyMatch,
    text: rule.content.text,
    images: [],
    retainedAssets: rule.content.images.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
    })),
    buttons: rule.content.buttons.map(({ text, url }) => ({ text, url })),
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
  };
}

function buildRuleFromList(
  current: readonly PublisherAutoReplyRuleV2[],
  updated: PublisherAutoReplyRuleV2,
): PublisherAutoReplyRuleV2[] {
  const next = current.map((rule) => (rule.id === updated.id ? updated : rule));
  return next.some((rule) => rule.id === updated.id) ? next : [updated, ...next];
}

function PublisherAutoReplyEditor({
  api,
  userId,
  chatId,
  target,
  onClose,
  onPermissionBlocker,
  onSaved,
}: {
  api: ApiTransport;
  userId: string;
  chatId: string;
  target: EditorTarget;
  onClose: () => void;
  onPermissionBlocker: (blocker: BotPermissionBlocker) => void;
  onSaved: (rule: PublisherAutoReplyRuleV2) => void;
}) {
  const { pushToast } = useToast();
  const rule = target.kind === 'edit' ? target.rule : null;
  const initialDraft = useMemo(
    () => (rule ? createDraftFromRule(rule) : createEmptyAutoReplyDraft()),
    [rule],
  );
  const {
    draft,
    setDraft,
    hydrated,
    dirty,
    missingImageCount,
    storageReadError,
    storageWriteError,
    modifiedSinceHydration,
    retryHydration,
    persist,
    discard,
    markSaved,
  } = useAutoReplyDraft({
    userId,
    chatId,
    ruleId: rule?.id,
    initialDraft,
  });
  const [issues, setIssues] = useState<AutoReplyDraftIssues>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [buttonsOpen, setButtonsOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [imagesPreparing, setImagesPreparing] = useState(false);
  const [phraseInput, setPhraseInput] = useState('');
  const requestIdRef = useRef<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useKeyboardOpen();

  useEffect(() => {
    if (!keyboardOpen) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const revealFocusedField = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !editorRef.current?.contains(field)) return;
        if (!field.matches('input, textarea, [contenteditable="true"]')) return;
        const top = (viewport?.offsetTop ?? 0) + 12;
        const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 12;
        let bounds = field.getBoundingClientRect();
        if (field.isContentEditable && bounds.height > bottom - top) {
          const selection = window.getSelection();
          if (!selection?.focusNode || !field.contains(selection.focusNode)) return;
          const caret = document.createRange();
          caret.setStart(selection.focusNode, selection.focusOffset);
          caret.collapse(true);
          let caretBounds = caret.getBoundingClientRect();
          if (
            !caretBounds.height &&
            selection.focusNode instanceof Text &&
            selection.focusNode.length
          ) {
            const offset = Math.min(
              Math.max(0, selection.focusOffset - 1),
              selection.focusNode.length - 1,
            );
            caret.setStart(selection.focusNode, offset);
            caret.setEnd(selection.focusNode, offset + 1);
            caretBounds = caret.getBoundingClientRect();
          }
          if (!caretBounds.height) return;
          bounds = caretBounds;
        }
        const delta =
          bounds.top < top
            ? bounds.top - top
            : bounds.bottom > bottom
              ? Math.min(bounds.bottom - bottom, bounds.top - top)
              : 0;
        if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'instant' });
      });
    };
    revealFocusedField();
    viewport?.addEventListener('resize', revealFocusedField);
    window.addEventListener('resize', revealFocusedField);
    const editor = editorRef.current;
    editor?.addEventListener('focusin', revealFocusedField);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', revealFocusedField);
      window.removeEventListener('resize', revealFocusedField);
      editor?.removeEventListener('focusin', revealFocusedField);
    };
  }, [keyboardOpen]);

  const saveMutation = useMutation({
    mutationFn: async (value: AutoReplyDraft) => {
      const normalized = normalizeAutoReplyDraft(value);
      requestIdRef.current ??= createPublisherAutoReplyRequestId();
      const content = {
        text: normalized.text,
        textFormat: 'markdown' as const,
        images: [
          ...normalized.retainedAssets.map((asset) => ({
            type: 'image-ref' as const,
            assetId: asset.id,
          })),
          ...normalized.images.map((image) => ({
            type: 'image' as const,
            base64: image.base64,
            mimeType: image.mimeType,
            fileName: image.fileName,
          })),
        ],
        buttons: normalized.buttons.map((button, index) => ({ ...button, row: index })),
      };

      return rule
        ? updatePublisherAutoReply(api, chatId, rule.id, {
            requestId: requestIdRef.current,
            expectedVersion: rule.version,
            phrases: normalized.phrases,
            matchInContext: normalized.matchInContext,
            fuzzyMatch: normalized.fuzzyMatch,
            enabled: normalized.enabled,
            cooldownSeconds: normalized.cooldownSeconds,
            content,
          })
        : createPublisherAutoReply(api, chatId, {
            requestId: requestIdRef.current,
            phrases: normalized.phrases,
            matchInContext: normalized.matchInContext,
            fuzzyMatch: normalized.fuzzyMatch,
            enabled: true,
            cooldownSeconds: normalized.cooldownSeconds,
            content,
          });
    },
    onSuccess: async (savedRule) => {
      requestIdRef.current = null;
      setConflict(false);
      setPhraseInput('');
      setReviewOpen(false);
      await markSaved(createDraftFromRule(savedRule));
      pushToast({
        tone: 'success',
        title: rule ? 'Автоответ обновлён' : 'Автоответ создан',
      });
      onSaved(savedRule);
    },
    onError: async (error) => {
      setReviewOpen(false);
      const { parseBotPermissionBlocker } = await loadBotPermissionErrorModule();
      const permissionBlocker = parseBotPermissionBlocker(error);
      if (permissionBlocker) {
        if (rule) {
          setDraft((current) => ({ ...current, enabled: rule.enabled }));
        }
        onPermissionBlocker(permissionBlocker);
        return;
      }
      const conflictKind = getAutoReplyConflictKind(error);
      if (conflictKind === 'phrase_conflict') {
        setIssues((current) => ({
          ...current,
          phrases: 'Одна из фраз уже используется в другом автоответе.',
        }));
        pushToast({
          tone: 'danger',
          title: 'Фраза уже используется',
          description: 'Удалите повторяющуюся фразу или измените другой автоответ.',
        });
        return;
      }
      if (conflictKind === 'client_upgrade_required') {
        pushToast({
          tone: 'danger',
          title: 'Нужно обновить мини-приложение',
          description: 'Закройте его в MAX, откройте снова и повторите сохранение.',
        });
        return;
      }
      if (conflictKind === 'version_conflict') {
        setConflict(true);
        pushToast({
          tone: 'danger',
          title: 'Автоответ уже изменился',
          description: 'Откройте его заново.',
        });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить автоответ.'),
      });
    },
  });

  const updateDraft = useCallback(
    (change: Partial<AutoReplyDraft>) => {
      setDraft((current) => ({ ...current, ...change }));
    },
    [setDraft],
  );

  const mergePendingPhrase = useCallback(
    (value: AutoReplyDraft = draft) => {
      const pending = normalizeAutoReplyPhrase(phraseInput);
      if (!pending) {
        return { draft: value };
      }
      const merged = mergeAutoReplyPhrases(value.phrases, [pending]);
      return merged.issue
        ? { draft: value, issue: merged.issue }
        : { draft: { ...value, phrases: merged.phrases } };
    },
    [draft, phraseInput],
  );

  const addPhraseCandidates = useCallback(
    (candidates: readonly string[]) => {
      const merged = mergeAutoReplyPhrases(draft.phrases, candidates);
      if (merged.issue) {
        setIssues((current) => ({ ...current, phrases: merged.issue }));
        return false;
      }
      const fuzzyIssue = validateAutoReplyTriggerDraft({
        ...draft,
        phrases: merged.phrases,
      }).fuzzyMatch;
      updateDraft({ phrases: merged.phrases });
      setPhraseInput('');
      setIssues((current) => ({ ...current, phrases: undefined, fuzzyMatch: fuzzyIssue }));
      return true;
    },
    [draft, updateDraft],
  );

  const validateEditorDraft = useCallback(
    (value: AutoReplyDraft) => {
      const nextIssues = validateAutoReplyDraft(value);
      if (missingImageCount > 0) {
        nextIssues.content = `Выберите заново ${missingImageCount} фото из сохранённого черновика.`;
      }
      return nextIssues;
    },
    [missingImageCount],
  );

  const revealIssues = useCallback((nextIssues: AutoReplyDraftIssues) => {
    setIssues(nextIssues);
    window.requestAnimationFrame(() => {
      const selector = nextIssues.phrases
        ? '[aria-labelledby="publisher-auto-reply-phrase-title"]:not(:disabled)'
        : nextIssues.fuzzyMatch
          ? '.publisher-auto-reply-editor__match-error'
          : nextIssues.content
            ? '.is-content [contenteditable="true"]'
            : null;
      if (!selector) return;
      const field = editorRef.current?.querySelector<HTMLElement>(selector);
      if (!field) return;
      if (!field.matches('input, button, [contenteditable="true"]')) field.tabIndex = -1;
      field.focus({ preventScroll: true });
      field.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  }, []);

  const validateAndReview = useCallback(() => {
    const composed = mergePendingPhrase();
    if (composed.issue) {
      revealIssues({ phrases: composed.issue });
      return;
    }
    const nextIssues = validateEditorDraft(composed.draft);
    revealIssues(nextIssues);
    if (
      nextIssues.buttons &&
      !nextIssues.phrases &&
      !nextIssues.fuzzyMatch &&
      !nextIssues.content
    ) {
      setButtonsOpen(true);
    } else if (Object.keys(nextIssues).length === 0) {
      if (composed.draft !== draft) {
        setDraft(composed.draft);
        setPhraseInput('');
      }
      setReviewOpen(true);
    }
  }, [draft, mergePendingPhrase, revealIssues, setDraft, validateEditorDraft]);

  const editorDirty = dirty || normalizeAutoReplyPhrase(phraseInput).length > 0;

  const requestClose = useCallback(() => {
    if (saveMutation.isPending) {
      return;
    }
    if (editorDirty) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  }, [editorDirty, onClose, saveMutation.isPending]);

  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { enabled: !buttonsOpen && !reviewOpen && !closeConfirmOpen, priority: 500 },
  );

  useManagedEntityLeaveGuard({
    dirty: editorDirty,
    saving: saveMutation.isPending,
    save: async () => {
      const composed = mergePendingPhrase();
      if (composed.issue) {
        setIssues((current) => ({ ...current, phrases: composed.issue }));
        return false;
      }
      const nextIssues = validateEditorDraft(composed.draft);
      setIssues(nextIssues);
      if (Object.keys(nextIssues).length > 0) {
        pushToast({ tone: 'danger', title: 'Проверьте поля автоответа' });
        return false;
      }
      try {
        await saveMutation.mutateAsync(composed.draft);
        return true;
      } catch {
        return false;
      }
    },
    discard: () => {
      setPhraseInput('');
      void discard();
    },
  });

  const totalImages = draft.retainedAssets.length + draft.images.length;
  const retainedById = new Map(rule?.content.images.map((asset) => [asset.id, asset]) ?? []);

  if (!hydrated) {
    return (
      <div className="publisher-auto-replies-page__state" role="status">
        <Spinner label={null} />
        <strong>Восстанавливаю редактор</strong>
      </div>
    );
  }

  if (storageReadError) {
    return (
      <div className="publisher-auto-replies-page__state has-error" role="alert">
        <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
        <strong>Не удалось восстановить черновик</strong>
        <span>Повторите попытку или начните заново.</span>
        <div className="publisher-auto-replies-page__state-actions">
          <button type="button" onClick={retryHydration}>
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            <span>Повторить</span>
          </button>
          <button type="button" onClick={() => void discard()}>
            Начать заново
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={editorRef}
      className={`publisher-auto-reply-editor${keyboardOpen ? ' is-keyboard-open' : ''}`}
      aria-busy={saveMutation.isPending || undefined}
    >
      <header className="publisher-auto-reply-editor__header">
        <button type="button" onClick={requestClose} aria-label="Закрыть редактор" title="Назад">
          <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
        </button>
        <span>
          <strong>{rule ? 'Изменить автоответ' : 'Новый автоответ'}</strong>
        </span>
      </header>

      {conflict ? (
        <div className="publisher-auto-reply-editor__conflict" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <span>Автоответ изменился. Откройте его заново.</span>
        </div>
      ) : null}

      <section className="publisher-auto-reply-editor__section is-triggers">
        <header>
          <h2 id="publisher-auto-reply-phrase-title">Фразы</h2>
          <small aria-live="polite">{getAutoReplyPhraseCountLabel(draft.phrases.length)}</small>
        </header>

        {draft.phrases.length > 0 ? (
          <div
            className="publisher-auto-reply-editor__phrases"
            role="list"
            aria-label="Добавленные фразы"
          >
            {draft.phrases.map((phrase, index) => (
              <span
                key={`${phrase}-${index}`}
                className="publisher-auto-reply-editor__phrase-chip"
                role="listitem"
              >
                <span>{phrase}</span>
                <button
                  type="button"
                  disabled={saveMutation.isPending}
                  onClick={() => {
                    const phrases = draft.phrases.filter((_, phraseIndex) => phraseIndex !== index);
                    updateDraft({
                      phrases,
                    });
                    setIssues((current) => ({
                      ...current,
                      phrases: undefined,
                      fuzzyMatch: validateAutoReplyTriggerDraft({ ...draft, phrases }).fuzzyMatch,
                    }));
                  }}
                  aria-label={`Удалить фразу «${phrase}»`}
                  title="Удалить фразу"
                >
                  <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className={cn('publisher-auto-reply-editor__field', issues.phrases && 'has-error')}>
          <div className="publisher-auto-reply-editor__phrase-add">
            <input
              value={phraseInput}
              maxLength={AUTO_REPLY_PHRASE_MAX_LENGTH}
              disabled={saveMutation.isPending || draft.phrases.length >= AUTO_REPLY_MAX_PHRASES}
              placeholder="Например: прайс"
              autoCapitalize="sentences"
              enterKeyHint="done"
              aria-labelledby="publisher-auto-reply-phrase-title"
              aria-describedby="publisher-auto-reply-phrase-meta"
              aria-invalid={Boolean(issues.phrases)}
              onPaste={(event) => {
                const value = event.clipboardData.getData('text');
                if (!/[\r\n]/u.test(value)) {
                  return;
                }
                event.preventDefault();
                addPhraseCandidates(splitAutoReplyPhrasePaste(value));
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                addPhraseCandidates([phraseInput]);
              }}
              onChange={(event) => {
                setPhraseInput(event.target.value);
                setIssues((current) => ({ ...current, phrases: undefined }));
              }}
            />
            <button
              type="button"
              disabled={
                saveMutation.isPending ||
                !phraseInput.trim() ||
                draft.phrases.length >= AUTO_REPLY_MAX_PHRASES
              }
              onClick={() => addPhraseCandidates([phraseInput])}
              aria-label="Добавить фразу"
              title="Добавить фразу"
            >
              <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
            </button>
          </div>
          <small
            id="publisher-auto-reply-phrase-meta"
            className="publisher-auto-reply-editor__field-meta"
            role={issues.phrases ? 'alert' : undefined}
          >
            {issues.phrases ?? `${draft.phrases.length} из ${AUTO_REPLY_MAX_PHRASES}`}
          </small>
        </div>

        <div className="publisher-auto-reply-editor__match-options">
          <div className="publisher-auto-reply-editor__toggle-row">
            <span>
              <strong>Искать внутри сообщения</strong>
              <small>{draft.matchInContext ? 'В любом месте текста' : 'Сообщение целиком'}</small>
            </span>
            <AutoReplySwitch
              checked={draft.matchInContext}
              disabled={saveMutation.isPending}
              label="Искать фразу внутри сообщения"
              onChange={(matchInContext) => updateDraft({ matchInContext })}
            />
          </div>
          <div className="publisher-auto-reply-editor__toggle-row">
            <span>
              <strong>Учитывать опечатки</strong>
              <small>{draft.fuzzyMatch ? 'Близкое написание' : 'Точное написание'}</small>
            </span>
            <AutoReplySwitch
              checked={draft.fuzzyMatch}
              disabled={saveMutation.isPending}
              label="Учитывать опечатки во фразах"
              onChange={(fuzzyMatch) => {
                updateDraft({ fuzzyMatch });
                setIssues((current) => ({
                  ...current,
                  fuzzyMatch: validateAutoReplyTriggerDraft({ ...draft, fuzzyMatch }).fuzzyMatch,
                }));
              }}
            />
          </div>
          {issues.fuzzyMatch ? (
            <small className="publisher-auto-reply-editor__match-error" role="alert">
              {issues.fuzzyMatch}
            </small>
          ) : null}
        </div>

        <Suspense fallback={null}>
          <LazyAutoReplyMatchTester
            api={api}
            chatId={chatId}
            ruleId={rule?.id}
            draft={draft}
            pendingPhrase={phraseInput}
            disabled={saveMutation.isPending}
            onCommitPhrases={(phrases) => {
              updateDraft({ phrases });
              setPhraseInput('');
              setIssues((current) => ({
                ...current,
                phrases: undefined,
                fuzzyMatch: validateAutoReplyTriggerDraft({ ...draft, phrases }).fuzzyMatch,
              }));
            }}
            onTriggerIssues={(triggerIssues) => {
              setIssues((current) => ({ ...current, ...triggerIssues }));
            }}
          />
        </Suspense>
      </section>

      <section className="publisher-auto-reply-editor__section is-content">
        <header>
          <h2>Ответ</h2>
        </header>

        {rule && draft.retainedAssets.length > 0 ? (
          <div
            className="publisher-auto-reply-editor__retained"
            aria-label="Сохранённые фотографии"
          >
            {draft.retainedAssets.map((metadata) => {
              const asset = retainedById.get(metadata.id);
              return asset ? (
                <RetainedAssetEditorItem
                  key={asset.id}
                  api={api}
                  chatId={chatId}
                  ruleId={rule.id}
                  asset={asset}
                  disabled={saveMutation.isPending}
                  onRemove={() =>
                    updateDraft({
                      retainedAssets: draft.retainedAssets.filter((item) => item.id !== asset.id),
                    })
                  }
                />
              ) : null;
            })}
          </div>
        ) : null}

        <Suspense
          fallback={
            <div className="publisher-auto-reply-editor__composer-placeholder" aria-busy="true">
              <Spinner label={null} />
            </div>
          }
        >
          <LazyBroadcastContentComposer
            className="publisher-auto-reply-editor__composer"
            text={draft.text}
            sourceFormat="markdown"
            maxLength={AUTO_REPLY_TEXT_MAX_LENGTH}
            images={draft.images}
            buttons={draft.buttons}
            buttonsPerRow={1}
            buttonsStatusLabel="Кнопка"
            buttonsActive={draft.buttons.length > 0}
            buttonsError={Boolean(issues.buttons)}
            maxImages={Math.max(1, AUTO_REPLY_MAX_IMAGES - draft.retainedAssets.length)}
            allowImages={draft.retainedAssets.length < AUTO_REPLY_MAX_IMAGES}
            disabled={saveMutation.isPending}
            textError={issues.content}
            messageAriaLabel="Сообщение автоответа"
            textPlaceholder="Текст ответа"
            textAriaLabel="Текст автоответа"
            showToolLabels
            onOpenButtons={() => setButtonsOpen(true)}
            onTextChange={(text) => {
              updateDraft({ text });
              if (issues.content) {
                setIssues((current) => ({ ...current, content: undefined }));
              }
            }}
            onImagesChange={(images: BroadcastImage[]) => {
              updateDraft({ images });
              if (issues.content) {
                setIssues((current) => ({ ...current, content: undefined }));
              }
            }}
            onImagePreparationChange={setImagesPreparing}
            onError={(message) => pushToast({ tone: 'danger', title: message })}
          />
        </Suspense>
        {missingImageCount > 0 ? (
          <small className="publisher-auto-reply-editor__missing-images" role="alert">
            Выберите заново {missingImageCount} фото из сохранённого черновика.
          </small>
        ) : null}
        {storageWriteError ? (
          <small className="publisher-auto-reply-editor__missing-images" role="alert">
            Черновик не сохранён на устройстве. Не закрывайте приложение до сохранения автоответа.
          </small>
        ) : null}
        {totalImages > 0 ? (
          <small className="publisher-auto-reply-editor__image-count">
            {totalImages} из {AUTO_REPLY_MAX_IMAGES} фото
          </small>
        ) : null}
      </section>

      <section className="publisher-auto-reply-editor__section">
        <header>
          <h2>Настройки</h2>
        </header>
        {rule ? (
          <div className="publisher-auto-reply-editor__toggle-row">
            <strong>Автоответ включён</strong>
            <AutoReplySwitch
              checked={draft.enabled}
              disabled={saveMutation.isPending}
              label={draft.enabled ? 'Выключить автоответ' : 'Включить автоответ'}
              onChange={(enabled) => updateDraft({ enabled })}
            />
          </div>
        ) : null}
        <label className="publisher-auto-reply-editor__select-field">
          <span>Пауза для одного участника</span>
          <select
            value={draft.cooldownSeconds}
            disabled={saveMutation.isPending}
            onChange={(event) => updateDraft({ cooldownSeconds: Number(event.target.value) })}
          >
            {AUTO_REPLY_COOLDOWN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <footer className="publisher-auto-reply-editor__save-bar">
        <button
          type="button"
          disabled={saveMutation.isPending || imagesPreparing || conflict}
          onClick={validateAndReview}
        >
          {saveMutation.isPending ? 'Сохраняю...' : 'Продолжить'}
        </button>
      </footer>

      {buttonsOpen ? (
        <Suspense fallback={null}>
          <PublicationButtonsSheet
            open
            buttons={draft.buttons}
            disabled={saveMutation.isPending}
            onApply={(buttons: BroadcastLinkButton[]) => {
              updateDraft({ buttons });
              setIssues((current) => ({ ...current, buttons: undefined }));
              setButtonsOpen(false);
            }}
            onClose={() => setButtonsOpen(false)}
          />
        </Suspense>
      ) : null}

      <ActionConfirmSheet
        id="publisher-auto-reply-review"
        className="publisher-auto-reply-review"
        open={reviewOpen}
        title={rule ? 'Сохранить изменения?' : 'Создать автоответ?'}
        summary={`${getAutoReplyPhraseCountLabel(draft.phrases.length)} · ${getAutoReplyMatchModeLabel(draft)}.`}
        previewTitle={
          <div className="publisher-auto-reply-review__content">
            <strong>Ответить</strong>
            {totalImages > 0 ? (
              <div className="publisher-auto-reply-review__media" aria-label="Фотографии ответа">
                {rule
                  ? rule.content.images
                      .filter((asset) => draft.retainedAssets.some((item) => item.id === asset.id))
                      .map((asset) => (
                        <AutoReplyAssetThumbnail
                          key={asset.id}
                          api={api}
                          chatId={chatId}
                          ruleId={rule.id}
                          asset={asset}
                        />
                      ))
                  : null}
                {draft.images.map((image, index) => (
                  <img
                    key={`${image.fileName}-${index}`}
                    src={`data:${image.mimeType};base64,${image.base64}`}
                    alt={image.fileName || `Фото ${index + 1}`}
                  />
                ))}
              </div>
            ) : null}
            <MaxMarkdownPreview
              value={draft.text}
              sourceFormat="markdown"
              fallback={totalImages > 0 ? 'Ответ без текста' : null}
            />
            {draft.buttons.length > 0 ? (
              <div className="publication-preview__buttons" aria-label="Кнопки автоответа">
                {draft.buttons.map((button, index) => (
                  <span key={`${button.url}-${index}`} title={button.url}>
                    {button.text}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        }
        previewMeta={
          <div className="publisher-auto-reply-review__facts">
            <strong>Если написали</strong>
            <ul>
              {draft.phrases.map((phrase) => (
                <li key={phrase}>{phrase}</li>
              ))}
            </ul>
            <span>{getAutoReplyMatchModeLabel(draft)}</span>
            <span>Пауза: {getAutoReplyCooldownLabel(draft.cooldownSeconds)}</span>
            {rule ? (
              <span>{draft.enabled ? 'Автоответ включён' : 'Автоответ выключен'}</span>
            ) : null}
          </div>
        }
        confirmLabel={rule ? 'Сохранить' : 'Создать'}
        confirmBusyLabel="Сохраняю..."
        tone="accent"
        isBusy={saveMutation.isPending}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => saveMutation.mutate(draft)}
      />

      <ActionConfirmSheet
        id="publisher-auto-reply-close"
        open={closeConfirmOpen}
        title="Закрыть редактор?"
        summary={
          storageWriteError
            ? 'Не удалось сохранить черновик на устройстве. Попробуйте ещё раз или вернитесь в редактор.'
            : 'Сохраним черновик на этом устройстве перед закрытием.'
        }
        confirmLabel={storageWriteError ? 'Повторить' : 'Сохранить и закрыть'}
        confirmBusyLabel="Сохраняем…"
        isBusy={persisting}
        tone="accent"
        onClose={() => setCloseConfirmOpen(false)}
        onConfirm={() => {
          if (persisting) return;
          const composed = mergePendingPhrase();
          if (composed.issue) {
            setIssues((current) => ({ ...current, phrases: composed.issue }));
            setCloseConfirmOpen(false);
            return;
          }
          if (missingImageCount > 0 && (modifiedSinceHydration || composed.draft !== draft)) {
            setIssues((current) => ({
              ...current,
              content: `Выберите заново ${missingImageCount} фото из сохранённого черновика.`,
            }));
            setCloseConfirmOpen(false);
            return;
          }
          setPersisting(true);
          void persist(composed.draft).then((saved) => {
            setPersisting(false);
            if (!saved) return;
            setCloseConfirmOpen(false);
            onClose();
          });
        }}
      />
    </div>
  );
}

function AutoReplyRuleRow({
  api,
  chatId,
  rule,
  busy,
  conflict,
  onToggle,
  onEdit,
  onDelete,
}: {
  api: ApiTransport;
  chatId: string;
  rule: PublisherAutoReplyRuleV2;
  busy: boolean;
  conflict: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [phrasesExpanded, setPhrasesExpanded] = useState(false);
  const phrasesId = useId();
  return (
    <article className={cn('publisher-auto-reply-row', !rule.enabled && 'is-disabled')}>
      <div className="publisher-auto-reply-row__head">
        <span className="publisher-auto-reply-row__phrase">
          <IconoirSprite variant="iconoir" icon="Key" aria-hidden />
          <strong>{rule.phrases[0] ?? 'Без фразы'}</strong>
          {rule.phrases.length > 1 ? (
            <button
              type="button"
              className="publisher-auto-reply-row__phrase-more"
              aria-expanded={phrasesExpanded}
              aria-controls={phrasesId}
              aria-label={phrasesExpanded ? 'Скрыть остальные фразы' : 'Показать все фразы'}
              onClick={() => setPhrasesExpanded((current) => !current)}
            >
              {phrasesExpanded ? '−' : `+${rule.phrases.length - 1}`}
            </button>
          ) : null}
        </span>
        <AutoReplySwitch
          checked={rule.enabled}
          disabled={busy}
          label={`${rule.enabled ? 'Выключить' : 'Включить'} автоответ «${rule.phrases[0] ?? 'без фразы'}»`}
          onChange={onToggle}
        />
      </div>

      {phrasesExpanded ? (
        <ul id={phrasesId} className="publisher-auto-reply-row__all-phrases">
          {rule.phrases.map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
      ) : null}

      <div className="publisher-auto-reply-row__content">
        {rule.content.images.length > 0 ? (
          <div className="publisher-auto-reply-row__assets" aria-label="Фотографии ответа">
            {rule.content.images.slice(0, 3).map((asset) => (
              <AutoReplyAssetThumbnail
                key={asset.id}
                api={api}
                chatId={chatId}
                ruleId={rule.id}
                asset={asset}
              />
            ))}
            {rule.content.images.length > 3 ? (
              <span className="publisher-auto-reply-row__asset-more">
                +{rule.content.images.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
        <MaxMarkdownPreview
          value={rule.content.text}
          sourceFormat={rule.content.textFormat}
          className="publisher-auto-reply-row__preview"
          fallback={rule.content.images.length > 0 ? 'Ответ без текста' : 'Пустой ответ'}
        />
      </div>

      <footer className="publisher-auto-reply-row__footer">
        <span>
          {[
            getAutoReplyMatchModeLabel(rule),
            rule.content.buttons.length > 0
              ? formatBroadcastButtonsStatus(rule.content.buttons)
              : null,
            rule.cooldownSeconds > 0
              ? `Пауза ${getAutoReplyCooldownLabel(rule.cooldownSeconds)}`
              : null,
          ]
            .filter((item): item is string => item !== null)
            .join(' · ')}
        </span>
        <span className="publisher-auto-reply-row__actions">
          <button
            type="button"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Редактировать автоответ «${rule.phrases[0] ?? 'без фразы'}»`}
            title="Редактировать"
          >
            <IconoirSprite variant="iconoir" icon="EditPencil" aria-hidden />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Удалить автоответ «${rule.phrases[0] ?? 'без фразы'}»`}
            title="Удалить"
          >
            <IconoirSprite variant="iconoir" icon="Trash" aria-hidden />
          </button>
        </span>
      </footer>
      {conflict ? (
        <div className="publisher-auto-reply-row__conflict" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <span>Автоответ обновлён.</span>
        </div>
      ) : null}
    </article>
  );
}

export function PublisherAutoRepliesPage({ api, userId }: { api: ApiTransport; userId: string }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { entityId = '' } = useParams<{ entityId: string }>();
  const chatId = entityId.trim();
  const queryKey = [...AUTO_REPLY_QUERY_ROOT, chatId] as const;
  const authoringQueryKey = [...AUTO_REPLY_QUERY_ROOT, chatId, 'authoring'] as const;
  const entityQueryKey = [...PUBLISHER_ENTITY_QUERY_ROOT, 'chat', chatId] as const;
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublisherAutoReplyRuleV2 | null>(null);
  const [conflictRuleId, setConflictRuleId] = useState<string | null>(null);
  const [permissionBlocker, setPermissionBlocker] = useState<BotPermissionBlocker | null>(null);
  const [botBusy, setBotBusy] = useState(false);
  const completedAuthoringSessionRef = useRef<string | null>(null);
  const authoringRequestIdRef = useRef<string | null>(null);

  const entityQuery = useQuery({
    queryKey: entityQueryKey,
    queryFn: ({ signal }) => getPublisherEntity(api, 'chat', chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const rulesQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => listPublisherAutoReplies(api, chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const authoringQuery = useQuery({
    queryKey: authoringQueryKey,
    queryFn: ({ signal }) => getCurrentPublisherAutoReplyAuthoringSession(api, chatId, { signal }),
    enabled: chatId.length > 0,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      isActiveAutoReplyAuthoringState(query.state.data?.session?.state) ? 2_500 : false,
  });
  const moduleMutation = useMutation({
    mutationFn: (autoRepliesEnabled: boolean) => {
      const entity = entityQuery.data;
      if (!entity) {
        throw new Error('Чат ещё не загружен.');
      }
      return updatePublisherModules(api, 'chat', chatId, {
        expectedRevision: entity.moduleSettings.revision,
        autoRepliesEnabled,
      });
    },
    onSuccess: (moduleSettings) => {
      setPermissionBlocker(null);
      queryClient.setQueryData(entityQueryKey, (current: unknown) =>
        current && typeof current === 'object' ? { ...current, moduleSettings } : current,
      );
    },
    onError: async (error) => {
      const { parseBotPermissionBlocker } = await loadBotPermissionErrorModule();
      const blocker = parseBotPermissionBlocker(error);
      if (blocker) {
        setPermissionBlocker(blocker);
      } else {
        pushToast({
          tone: 'danger',
          title: describeUserFacingError(error, 'Не удалось изменить модуль.'),
        });
      }
      await queryClient.invalidateQueries({ queryKey: entityQueryKey });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ rule, enabled }: { rule: PublisherAutoReplyRuleV2; enabled: boolean }) =>
      updatePublisherAutoReply(api, chatId, rule.id, {
        requestId: createPublisherAutoReplyRequestId(),
        expectedVersion: rule.version,
        enabled,
      }),
    onMutate: ({ rule, enabled }) => {
      setConflictRuleId(null);
      if (enabled) {
        return;
      }
      queryClient.setQueryData(queryKey, (current: unknown) => {
        if (!current || typeof current !== 'object' || !('items' in current)) {
          return current;
        }
        const response = current as { items: PublisherAutoReplyRuleV2[]; total: number };
        return {
          ...response,
          items: response.items.map((item) => (item.id === rule.id ? { ...item, enabled } : item)),
        };
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, (current: unknown) => {
        if (!current || typeof current !== 'object' || !('items' in current)) {
          return current;
        }
        const response = current as { items: PublisherAutoReplyRuleV2[]; total: number };
        return { ...response, items: buildRuleFromList(response.items, updated) };
      });
    },
    onError: async (error, variables) => {
      const { parseBotPermissionBlocker } = await loadBotPermissionErrorModule();
      const blocker = parseBotPermissionBlocker(error);
      if (blocker) {
        setPermissionBlocker(blocker);
      } else {
        const conflictKind = getAutoReplyConflictKind(error);
        if (conflictKind === 'version_conflict') {
          setConflictRuleId(variables.rule.id);
        } else {
          pushToast({
            tone: 'danger',
            title:
              conflictKind === 'client_upgrade_required'
                ? 'Закройте мини-приложение и откройте его снова'
                : conflictKind === 'phrase_conflict'
                  ? 'Одна из фраз уже используется'
                  : describeUserFacingError(error, 'Не удалось изменить автоответ.'),
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const permissionRecheckMutation = useMutation({
    mutationFn: () => refreshPublisherEntity(api, 'chat', chatId),
    onSuccess: async () => {
      setPermissionBlocker(null);
      await queryClient.invalidateQueries({ queryKey: entityQueryKey });
      pushToast({
        tone: 'info',
        title: 'Проверка поставлена в очередь',
        description: 'После обновления прав повторите включение автоответа.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось запустить проверку доступа.'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (rule: PublisherAutoReplyRuleV2) =>
      archivePublisherAutoReply(api, chatId, rule.id, {
        requestId: createPublisherAutoReplyRequestId(),
        expectedVersion: rule.version,
      }),
    onSuccess: async (_response, rule) => {
      await clearAutoReplyDraft(userId, chatId, rule.id);
      setDeleteTarget(null);
      pushToast({ tone: 'success', title: 'Автоответ удалён' });
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: async (error, rule) => {
      if (getAutoReplyConflictKind(error) === 'version_conflict') {
        setConflictRuleId(rule.id);
        setDeleteTarget(null);
      } else {
        pushToast({
          tone: 'danger',
          title: describeUserFacingError(error, 'Не удалось удалить автоответ.'),
        });
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const cancelAuthoringMutation = useMutation({
    mutationFn: () => cancelCurrentPublisherAutoReplyAuthoringSession(api, chatId),
    onSuccess: (response) => {
      queryClient.setQueryData(authoringQueryKey, response);
      pushToast({ tone: 'info', title: 'Создание через Публика отменено' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отменить создание.'),
      });
    },
  });

  const handleSaved = (savedRule: PublisherAutoReplyRuleV2) => {
    queryClient.setQueryData(queryKey, (current: unknown) => {
      if (!current || typeof current !== 'object' || !('items' in current)) {
        return { items: [savedRule], total: 1 };
      }
      const response = current as { items: PublisherAutoReplyRuleV2[]; total: number };
      const exists = response.items.some((rule) => rule.id === savedRule.id);
      return {
        ...response,
        items: buildRuleFromList(response.items, savedRule),
        total: exists ? response.total : response.total + 1,
      };
    });
    setEditorTarget(null);
    void queryClient.invalidateQueries({ queryKey });
  };

  const handleOpenBot = async () => {
    setBotBusy(true);
    try {
      authoringRequestIdRef.current ??= createPublisherAutoReplyRequestId();
      const response = await createPublisherAutoReplyAuthoringSession(api, chatId, {
        requestId: authoringRequestIdRef.current,
      });
      authoringRequestIdRef.current = null;
      queryClient.setQueryData(authoringQueryKey, {
        session: response.session,
        botUrl: response.botUrl,
      });
      const botUrl = response.botUrl;
      if (!botUrl || !openMaxBotLinkAndClose(botUrl)) {
        throw new Error('Не удалось открыть диалог с Публиком.');
      }
      setCreateSheetOpen(false);
      setBotBusy(false);
    } catch (error) {
      if (isAutoReplyAuthoringConflictError(error)) {
        const current = await authoringQuery.refetch();
        const botUrl = current.data?.botUrl;
        if (botUrl && openMaxBotLinkAndClose(botUrl)) {
          setCreateSheetOpen(false);
          setBotBusy(false);
          return;
        }
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось открыть Публика.'),
      });
      setBotBusy(false);
    }
  };

  useEffect(() => {
    const session = authoringQuery.data?.session;
    if (session?.state !== 'completed' || completedAuthoringSessionRef.current === session.id) {
      return;
    }
    completedAuthoringSessionRef.current = session.id;
    void queryClient.invalidateQueries({ queryKey });
  }, [authoringQuery.data?.session, chatId, queryClient]);

  useEffect(() => {
    document.body.classList.add('publisher-auto-replies-open');
    return () => document.body.classList.remove('publisher-auto-replies-open');
  }, []);

  if (!chatId) {
    return (
      <section className="publisher-auto-replies-page">
        <div className="publisher-auto-replies-page__state has-error" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <strong>Чат не найден</strong>
          <Link to="/">Вернуться</Link>
        </div>
      </section>
    );
  }

  if (editorTarget) {
    return (
      <section className="publisher-auto-replies-page is-editor">
        <PublisherAutoReplyEditor
          key={editorTarget.kind === 'edit' ? editorTarget.rule.id : 'new'}
          api={api}
          userId={userId}
          chatId={chatId}
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
          onPermissionBlocker={setPermissionBlocker}
          onSaved={handleSaved}
        />
        <Suspense fallback={null}>
          <LazyBotPermissionRequiredDialog
            id="publisher-auto-reply-permission"
            blocker={permissionBlocker}
            isRechecking={permissionRecheckMutation.isPending}
            onClose={() => setPermissionBlocker(null)}
            onRecheck={() => permissionRecheckMutation.mutate()}
          />
        </Suspense>
      </section>
    );
  }

  const entity = entityQuery.data;
  const rules = rulesQuery.data?.items ?? [];
  const loading = entityQuery.isLoading || rulesQuery.isLoading;
  const refreshing = entityQuery.isFetching || rulesQuery.isFetching;
  const rowBusyId = toggleMutation.variables?.rule.id ?? deleteMutation.variables?.id ?? null;

  return (
    <section className="publisher-auto-replies-page" aria-busy={refreshing || undefined}>
      <header className="publisher-auto-replies-page__header">
        <button
          type="button"
          onClick={() => navigate(buildPublisherChatModulesRoute(chatId))}
          aria-label="Вернуться к модулям"
          title="Назад"
        >
          <IconoirSprite variant="iconoir" icon="NavArrowLeft" aria-hidden />
        </button>
        <EntityAvatar
          title={entity?.title ?? 'Чат'}
          entityType="chat"
          avatarUrl={entity?.avatarUrl ?? null}
          className="publisher-auto-replies-page__avatar"
        />
        <span className="publisher-auto-replies-page__identity">
          <strong>Автоответы</strong>
          <small>{entity?.title.trim() || 'Чат'}</small>
        </span>
        <button
          type="button"
          className={cn(refreshing && 'is-refreshing')}
          disabled={refreshing}
          onClick={() => void Promise.all([rulesQuery.refetch(), entityQuery.refetch()])}
          aria-label="Обновить автоответы"
          title="Обновить"
        >
          <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
        </button>
      </header>

      {authoringQuery.data?.session &&
      isActiveAutoReplyAuthoringState(authoringQuery.data.session.state) ? (
        <div className="publisher-auto-replies-page__authoring">
          <span>
            <strong>Черновик в Публике</strong>
            <small aria-live="polite">
              {getAutoReplyAuthoringStateLabel(authoringQuery.data.session.state)}
            </small>
          </span>
          <span className="publisher-auto-replies-page__authoring-actions">
            {authoringQuery.data.botUrl ? (
              <button
                type="button"
                onClick={() => openMaxBotLinkAndClose(authoringQuery.data!.botUrl!)}
              >
                Продолжить
              </button>
            ) : null}
            <button
              type="button"
              disabled={cancelAuthoringMutation.isPending}
              onClick={() => cancelAuthoringMutation.mutate()}
              aria-label="Отменить создание через Публика"
              title="Отменить"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
            </button>
          </span>
        </div>
      ) : null}

      {entity ? (
        <div className="publisher-auto-replies-page__module-toggle">
          <span>
            <strong>Автоответы в чате</strong>
            <small>
              {entity.moduleSettings.autoRepliesEnabled === true ? 'Включены' : 'Выключены'}
            </small>
          </span>
          <AutoReplySwitch
            checked={entity.moduleSettings.autoRepliesEnabled === true}
            disabled={moduleMutation.isPending}
            label={
              entity.moduleSettings.autoRepliesEnabled
                ? 'Выключить модуль автоответов'
                : 'Включить модуль автоответов'
            }
            onChange={(enabled) => moduleMutation.mutate(enabled)}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="publisher-auto-replies-page__state" role="status">
          <Spinner label={null} />
          <strong>Загружаю автоответы</strong>
        </div>
      ) : rulesQuery.isError || entityQuery.isError ? (
        <div className="publisher-auto-replies-page__state has-error" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <strong>Не удалось загрузить автоответы</strong>
          <button
            type="button"
            onClick={() => void Promise.all([rulesQuery.refetch(), entityQuery.refetch()])}
          >
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            <span>Повторить</span>
          </button>
        </div>
      ) : rules.length === 0 ? (
        <div className="publisher-auto-replies-page__empty">
          <span aria-hidden>
            <IconoirSprite variant="iconoir" icon="Key" />
          </span>
          <strong>Нет автоответов</strong>
          <button type="button" onClick={() => setCreateSheetOpen(true)}>
            <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
            <span>Добавить автоответ</span>
          </button>
        </div>
      ) : (
        <div className="publisher-auto-replies-page__list">
          {rules.map((rule) => (
            <AutoReplyRuleRow
              key={rule.id}
              api={api}
              chatId={chatId}
              rule={rule}
              busy={rowBusyId === rule.id}
              conflict={conflictRuleId === rule.id}
              onToggle={(enabled) => toggleMutation.mutate({ rule, enabled })}
              onEdit={() => setEditorTarget({ kind: 'edit', rule })}
              onDelete={() => setDeleteTarget(rule)}
            />
          ))}
        </div>
      )}

      {!loading && !rulesQuery.isError && !entityQuery.isError && rules.length > 0 ? (
        <button
          type="button"
          className="publisher-auto-replies-page__add"
          onClick={() => setCreateSheetOpen(true)}
          aria-label="Добавить автоответ"
          title="Добавить автоответ"
        >
          <IconoirSprite variant="iconoir" icon="Plus" aria-hidden />
        </button>
      ) : null}

      <AutoReplyCreateSheet
        open={createSheetOpen}
        busy={botBusy}
        onClose={() => setCreateSheetOpen(false)}
        onWrite={() => {
          setCreateSheetOpen(false);
          setEditorTarget({ kind: 'create' });
        }}
        onOpenBot={() => void handleOpenBot()}
      />

      <ActionConfirmSheet
        id="publisher-auto-reply-delete"
        open={deleteTarget !== null}
        title="Удалить автоответ?"
        summary="Публик перестанет отвечать по этому правилу."
        previewTitle={
          deleteTarget
            ? `${deleteTarget.phrases[0] ?? 'Без фразы'}${deleteTarget.phrases.length > 1 ? ` +${deleteTarget.phrases.length - 1}` : ''}`
            : undefined
        }
        confirmLabel="Удалить"
        confirmBusyLabel="Удаляю..."
        tone="danger"
        isBusy={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate(deleteTarget);
          }
        }}
      />
      <Suspense fallback={null}>
        <LazyBotPermissionRequiredDialog
          id="publisher-auto-reply-permission"
          blocker={permissionBlocker}
          isRechecking={permissionRecheckMutation.isPending}
          onClose={() => setPermissionBlocker(null)}
          onRecheck={() => permissionRecheckMutation.mutate()}
        />
      </Suspense>
    </section>
  );
}
