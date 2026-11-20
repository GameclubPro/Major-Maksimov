import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import {
  NATIVE_BACK_MODAL_CONFIRM_PRIORITY,
  isElementInTopmostNativeBackModal,
  useNativeBackHandler,
} from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import './action-confirm-sheet.css';

type ActionConfirmSheetProps = {
  id: string;
  className?: string;
  open: boolean;
  role?: 'dialog' | 'alertdialog';
  title: string;
  summary?: string;
  previewTitle?: ReactNode;
  previewMeta?: ReactNode;
  confirmLabel: string;
  confirmBusyLabel?: string;
  confirmBusy?: boolean;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
  isBusy?: boolean;
  extraActionLabel?: string;
  extraActionBusyLabel?: string;
  extraActionBusy?: boolean;
  extraActionDisabled?: boolean;
  extraActionTone?: 'ghost' | 'danger' | 'accent';
  actionOrder?: 'extra-cancel-confirm' | 'confirm-extra-cancel';
  onExtraAction?: () => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function ActionConfirmSheet({
  id,
  className,
  open,
  role = 'dialog',
  title,
  summary,
  previewTitle,
  previewMeta,
  confirmLabel,
  confirmBusyLabel = 'Сохраняем...',
  confirmBusy,
  confirmDisabled = false,
  cancelLabel = 'Отмена',
  tone = 'danger',
  isBusy = false,
  extraActionLabel,
  extraActionBusyLabel = '...',
  extraActionBusy = false,
  extraActionDisabled = false,
  extraActionTone = 'ghost',
  actionOrder = 'extra-cancel-confirm',
  onExtraAction,
  onClose,
  onConfirm,
}: ActionConfirmSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const overlayStyle = useVisualViewportOverlayStyle(open);
  useDialogFocusTrap(open, panelRef, cancelButtonRef);
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) {
        const cancelButton = cancelButtonRef.current;
        (cancelButton && !cancelButton.disabled ? cancelButton : panel).focus({
          preventScroll: true,
        });
      }
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isBusy, open]);
  useNativeBackHandler(
    () => {
      const panel = panelRef.current;
      if (panel && !isElementInTopmostNativeBackModal(panel)) return false;
      if (isBusy) {
        return true;
      }

      onClose();
      return true;
    },
    { enabled: open, priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !panelRef.current || !isTopmostModalDialog(panelRef.current)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (!isBusy) {
        onClose();
      }
    };

    body.classList.add('action-confirm-sheet-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.classList.remove('action-confirm-sheet-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBusy, onClose, open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const titleId = `${id}-title`;
  const summaryId = summary ? `${id}-summary` : undefined;
  const isConfirmBusy = confirmBusy ?? isBusy;
  const extraActionButton =
    extraActionLabel && onExtraAction ? (
      <button
        type="button"
        className={cn(
          'action-confirm-sheet__button',
          `action-confirm-sheet__button--${extraActionTone}`,
        )}
        onClick={onExtraAction}
        disabled={isBusy || extraActionBusy || extraActionDisabled}
      >
        {extraActionBusy ? extraActionBusyLabel : extraActionLabel}
      </button>
    ) : null;
  const cancelButton = (
    <button
      ref={cancelButtonRef}
      type="button"
      className="action-confirm-sheet__button action-confirm-sheet__button--ghost"
      onClick={onClose}
      disabled={isBusy}
    >
      {cancelLabel}
    </button>
  );
  const confirmButton = (
    <button
      type="button"
      className={cn(
        'action-confirm-sheet__button',
        tone === 'danger'
          ? 'action-confirm-sheet__button--danger'
          : 'action-confirm-sheet__button--accent',
      )}
      onClick={onConfirm}
      disabled={isBusy || confirmDisabled}
    >
      {isConfirmBusy ? confirmBusyLabel : confirmLabel}
    </button>
  );

  return createPortal(
    <div className={cn('action-confirm-sheet', className)} aria-hidden={!open} style={overlayStyle}>
      <button
        type="button"
        className="action-confirm-sheet__backdrop"
        aria-label="Закрыть подтверждение"
        onClick={onClose}
        disabled={isBusy}
        tabIndex={-1}
      />

      <section
        ref={panelRef}
        className={cn('action-confirm-sheet__panel', `action-confirm-sheet__panel--${tone}`)}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabIndex={-1}
      >
        <div className="action-confirm-sheet__grabber" aria-hidden />

        <div className="action-confirm-sheet__body">
          <div className="action-confirm-sheet__head">
            <strong id={titleId}>{title}</strong>
            {summary ? <small id={summaryId}>{summary}</small> : null}
          </div>

          {previewTitle || previewMeta ? (
            <div className="action-confirm-sheet__preview">
              {previewTitle ? (
                <div className="action-confirm-sheet__preview-title">{previewTitle}</div>
              ) : null}
              {previewMeta ? (
                <div className="action-confirm-sheet__preview-meta">{previewMeta}</div>
              ) : null}
            </div>
          ) : null}

          <div className="action-confirm-sheet__actions">
            {actionOrder === 'confirm-extra-cancel' ? (
              <>
                {confirmButton}
                {extraActionButton}
                {cancelButton}
              </>
            ) : (
              <>
                {extraActionButton}
                {cancelButton}
                {confirmButton}
              </>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
