import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import {
  isMaxApiNoticeActive,
  MAX_API_NOTICE,
  maxApiNoticeAcknowledgementKey,
} from '../lib/max-api-notice';
import { NATIVE_BACK_MODAL_CONFIRM_PRIORITY, useNativeBackHandler } from '../lib/native-back';
import { hydrateMirroredItem, readLocalMirrorItem, saveMirroredItem } from '../lib/native-storage';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import './max-api-notice.css';

export function MaxApiNotice({ userId }: { userId: string }) {
  const storageKey = maxApiNoticeAcknowledgementKey(userId);
  const [dismissed, setDismissed] = useState(() => readLocalMirrorItem(storageKey) === '1');
  const [active, setActive] = useState(isMaxApiNoticeActive);
  const [storageReady, setStorageReady] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const open = active && storageReady && !dismissed;
  const overlayStyle = useVisualViewportOverlayStyle(open);
  useDialogFocusTrap(open, panelRef, buttonRef);
  const dismiss = useCallback(() => setDismissed(true), []);
  useNativeBackHandler(
    () => {
      if (!panelRef.current || !isTopmostModalDialog(panelRef.current)) return false;
      dismiss();
      return true;
    },
    { enabled: open, priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
  );

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => setStorageReady(true), 500);
    void hydrateMirroredItem(storageKey).then((value) => {
      if (cancelled) return;
      if (value === '1') setDismissed(true);
      setStorageReady(true);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [storageKey]);

  useEffect(() => {
    const refresh = () => setActive(isMaxApiNoticeActive());
    const timeout = window.setTimeout(refresh, Math.max(0, MAX_API_NOTICE.expiresAt - Date.now()));
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !panelRef.current || !isTopmostModalDialog(panelRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dismiss, open]);

  if (!open) return null;

  return createPortal(
    <div className="max-api-notice" style={overlayStyle}>
      <section
        ref={panelRef}
        className="max-api-notice__panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="max-api-notice-title"
        aria-describedby="max-api-notice-message"
        tabIndex={-1}
      >
        <time dateTime="2026-11-12">{MAX_API_NOTICE.date}</time>
        <h2 id="max-api-notice-title">{MAX_API_NOTICE.title}</h2>
        <p id="max-api-notice-message">{MAX_API_NOTICE.message}</p>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            saveMirroredItem(storageKey, '1');
            dismiss();
          }}
        >
          Ознакомлен
        </button>
      </section>
    </div>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
