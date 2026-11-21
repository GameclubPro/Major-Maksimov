import type {
  ApplySectionTargetPreviewResponse,
  ApplySettingsTarget,
} from '@maxim/contracts/settings';
import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { XmarkGlyph } from '../../components/ui/compact-icons';
import { AppIcon } from '../../components/ui/app-icon';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import type { ApplySectionKey } from '../settings-page-state';
import {
  formatApplyTargetCountLabel,
  formatApplyTargetSaveLabel,
  isApplySettingsTargetPreviewCurrent,
} from './settings-apply-target';
import './settings-apply-target-sheet.css';

type SettingsApplyTargetSheetProps = {
  sheet: { sourceChatId: string; section: ApplySectionKey; target: ApplySettingsTarget } | null;
  preview: ApplySectionTargetPreviewResponse | null;
  previewLoading: boolean;
  previewError: string | null;
  sectionLabel: string;
  overlayStyle: CSSProperties | undefined;
  isApplying: boolean;
  onClose: () => void;
  onRetry: () => void;
  onConfirm: () => void;
};

export function SettingsApplyTargetSheet({
  sheet,
  preview,
  previewLoading,
  previewError,
  sectionLabel,
  overlayStyle,
  isApplying,
  onClose,
  onRetry,
  onConfirm,
}: SettingsApplyTargetSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const isOpen = Boolean(sheet);
  useDialogFocusTrap(isOpen, panelRef, panelRef);
  const { snapshot: favoritesSnapshot, actions: favoritesActions } = useHomeEntityFavorites();
  const compositionEpoch = favoritesSnapshot.byType.chat.compositionEpoch;
  const previewEpochRef = useRef({ preview, epoch: compositionEpoch });
  if (previewEpochRef.current.preview !== preview)
    previewEpochRef.current = { preview, epoch: compositionEpoch };

  useNativeBackHandler(
    () => {
      if (isApplying) {
        return true;
      }
      onClose();
      return true;
    },
    { enabled: isOpen, priority: 690 },
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const panel = panelRef.current;
      if (!panel || !isTopmostModalDialog(panel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!isApplying) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isApplying, isOpen, onClose]);

  if (!sheet) return null;
  const { target } = sheet;
  const favoriteType =
    target.mode === 'favoriteTypes' && target.favoriteTypes.length === 1
      ? target.favoriteTypes[0]
      : null;
  const favoriteReady =
    !favoriteType ||
    (favoritesSnapshot.labels.status === 'ready' &&
      favoritesSnapshot.labels.serverConfirmed &&
      favoritesSnapshot.byType.chat.assignmentsComplete &&
      favoritesSnapshot.byType.chat.status === 'ready');
  const favoriteChanged = Boolean(
    favoriteType &&
    favoriteReady &&
    !favoritesSnapshot.assignments.chat[favoriteType].includes(sheet.sourceChatId),
  );
  const supportedTarget =
    target.mode === 'all' || target.mode === 'current' || Boolean(favoriteType);
  const previewMatchesTarget =
    preview?.sourceChatId === sheet.sourceChatId &&
    previewEpochRef.current.epoch === compositionEpoch &&
    isApplySettingsTargetPreviewCurrent(target, preview);
  const targetLimitExceeded =
    (sheet.section === 'reports' || sheet.section === 'night') &&
    (preview?.appliedChatIds.length ?? 0) > 500;
  const canConfirm =
    previewMatchesTarget &&
    !previewLoading &&
    !previewError &&
    !isApplying &&
    favoriteReady &&
    !favoriteChanged &&
    supportedTarget &&
    (preview?.updatedChats ?? 0) > 0 &&
    !targetLimitExceeded;
  const visibleChats = previewMatchesTarget ? (preview?.sampleChats.slice(0, 4) ?? []) : [];
  const remainingChats = Math.max(0, (preview?.updatedChats ?? 0) - visibleChats.length);
  const title =
    favoriteType && favoritesSnapshot.labels.status === 'ready'
      ? `Папка «${favoritesSnapshot.labels.resolved[favoriteType]}»`
      : target.mode === 'current'
        ? 'Этот чат'
        : favoriteType
          ? 'Папка'
          : 'Все чаты';
  const error = favoriteChanged
    ? 'Папка чата изменилась. Откройте сохранение заново.'
    : !supportedTarget
      ? 'Откройте сохранение заново.'
      : !favoriteReady
        ? 'Не удалось подтвердить папку чата.'
        : targetLimitExceeded
          ? 'За раз можно сохранить настройки не более чем в 500 чатах.'
          : previewError;
  const titleId = `settings-apply-target-${sheet.section}-title`;
  const descriptionId = `settings-apply-target-${sheet.section}-description`;
  const content = (
    <div className="settings-apply-target" style={overlayStyle}>
      <button
        type="button"
        className="settings-apply-target__backdrop"
        aria-label="Закрыть подтверждение"
        onClick={onClose}
        disabled={isApplying}
        tabIndex={-1}
      />
      <section
        ref={panelRef}
        className="settings-apply-target__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="settings-apply-target__handle" aria-hidden />
        <div className="settings-apply-target__header">
          <strong id={titleId}>{title}</strong>
          <button
            type="button"
            className="settings-apply-target__close"
            aria-label="Закрыть подтверждение"
            onClick={onClose}
            disabled={isApplying}
          >
            <XmarkGlyph aria-hidden />
          </button>
        </div>
        <p id={descriptionId} className="settings-apply-target__consequence">
          Настройки «{sectionLabel}» будут заменены.
        </p>
        <div
          className="settings-apply-target__preview"
          aria-live="polite"
          aria-busy={(!error && (previewLoading || !previewMatchesTarget)) || undefined}
        >
          {error ? (
            <span role="alert" className="is-danger">
              {error}
            </span>
          ) : previewLoading || !previewMatchesTarget ? (
            <span>Проверяем чаты…</span>
          ) : (
            <>
              <strong>
                {preview?.updatedChats
                  ? formatApplyTargetCountLabel(preview.updatedChats)
                  : 'Нет подходящих чатов'}
              </strong>
              {visibleChats.length ? (
                <ul className="settings-apply-target__chat-list" aria-label="Выбранные чаты">
                  {visibleChats.map((chat) => (
                    <li key={chat.id}>
                      <AppIcon icon="ChatLines" />
                      <span>{chat.title}</span>
                      {chat.id === sheet.sourceChatId ? <small>Этот чат</small> : null}
                    </li>
                  ))}
                  {remainingChats > 0 ? (
                    <li className="settings-apply-target__remaining">И ещё {remainingChats}</li>
                  ) : null}
                </ul>
              ) : null}
            </>
          )}
        </div>
        {error && !favoriteChanged && !targetLimitExceeded && supportedTarget ? (
          <button
            type="button"
            className="button button--ghost settings-apply-target__retry"
            disabled={isApplying}
            onClick={() => {
              if (favoriteType && !favoriteReady) {
                void Promise.allSettled([
                  favoritesActions.refreshLabels(),
                  favoritesActions.refreshAssignments('chat'),
                ]).then(onRetry);
              } else onRetry();
            }}
          >
            Повторить проверку
          </button>
        ) : null}
        <div className="settings-apply-target__actions">
          <button
            type="button"
            className="button button--accent"
            disabled={!canConfirm}
            aria-busy={isApplying || undefined}
            onClick={() => {
              if (canConfirm) {
                onConfirm();
              }
            }}
          >
            <span className="settings-apply-target__confirm-label">
              {isApplying
                ? 'Сохраняем…'
                : previewMatchesTarget && preview?.updatedChats
                  ? formatApplyTargetSaveLabel(preview.updatedChats)
                  : 'Сохранить'}
            </span>
          </button>
        </div>
      </section>
    </div>
  );
  if (typeof document === 'undefined') return content;
  return createPortal(
    content,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
