import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import type { ChannelDialogMessage } from '@maxim/contracts/channel-dialog';
import type { ApiTransport } from '../lib/api/transport';
import type { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { loadRecoverableNamedComponent } from '../lib/recoverable-lazy';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import { NATIVE_BACK_MODAL_CONFIRM_PRIORITY, useNativeBackHandler } from '../lib/native-back';
import { maxImpact } from '../lib/max-bridge';

type SheetProps = ComponentProps<typeof ActionConfirmSheet>;
function PendingDeleteSheet({
  open,
  title,
  onClose,
  failed = false,
}: Pick<SheetProps, 'open' | 'title' | 'onClose'> & { failed?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(open, panel, cancel);
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: open, priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
  );
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel.current && isTopmostModalDialog(panel.current)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, onClose]);
  const screen = document.querySelector('.channel-dialog-screen--comments');
  return open && screen
    ? createPortal(
        <div className="comment-theme-sheet comment-tools-sheet">
          <button
            type="button"
            className="comment-theme-sheet__backdrop"
            aria-label="Отмена"
            onClick={onClose}
            tabIndex={-1}
          />
          <section
            ref={panel}
            className="comment-theme-sheet__panel"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
          >
            <header className="comment-theme-sheet__head">
              <h2>{title}</h2>
            </header>
            <p role={failed ? 'alert' : 'status'}>
              {failed ? 'Не удалось открыть подтверждение.' : 'Открываем…'}
            </p>
            {failed ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => window.location.reload()}
              >
                Обновить
              </button>
            ) : null}
            <button ref={cancel} type="button" className="button button--ghost" onClick={onClose}>
              Отмена
            </button>
          </section>
        </div>,
        screen,
      )
    : null;
}
const LazySheet = lazy(() =>
  loadRecoverableNamedComponent<SheetProps>(
    () => import('../components/ui/action-confirm-sheet'),
    'ActionConfirmSheet',
    {
      /* FLAG: Keep the target cancellable after a chunk failure; refreshing is explicit. */
      recover: () => false,
      failureComponent: (props) => <PendingDeleteSheet {...props} failed />,
    },
  ),
);

type Target = {
  id: string;
  admin: boolean;
  scope: string;
  api: ApiTransport;
  returnFocus: HTMLElement | null;
};
export function useCommentDeleteConfirmation({
  api,
  scope,
  enabled,
  busy,
  messages,
  getMessage,
  onDismiss,
  onDelete,
}: {
  api: ApiTransport;
  scope: string;
  enabled: boolean;
  busy: boolean;
  messages: readonly ChannelDialogMessage[];
  getMessage: (id: string) => ChannelDialogMessage | undefined;
  onDismiss: () => void;
  onDelete: (value: { messageId: string; deletedByAdmin: boolean }) => Promise<unknown>;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const focusFrame = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(focusFrame.current);
    };
  }, []);
  const owner = useRef({ api, scope, enabled });
  owner.current = { api, scope, enabled };
  const allowed = (selected: Target, message: ChannelDialogMessage | undefined) =>
    owner.current.enabled &&
    selected.api === owner.current.api &&
    selected.scope === owner.current.scope &&
    Boolean(
      message &&
      (selected.admin ? message.canDeleteAsAdmin && !message.canDelete : message.canDelete),
    );
  const visible = Boolean(
    target &&
    allowed(
      target,
      messages.find((message) => message.id === target.id),
    ),
  );
  const restoreFocus = (selected: Target) => {
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      if (
        !mounted.current ||
        selected.scope !== owner.current.scope ||
        selected.api !== owner.current.api
      )
        return;
      const fallback = document.querySelector<HTMLElement>(
        '.channel-dialog-compose__field textarea, .channel-dialog-compose__field [contenteditable="true"]',
      );
      (selected.returnFocus?.isConnected ? selected.returnFocus : fallback)?.focus({
        preventScroll: true,
      });
    });
  };
  useEffect(() => {
    if (target && !visible && !inFlight.current) {
      setTarget(null);
      restoreFocus(target);
    }
  }, [target, visible, submitting]);
  const close = () => {
    if (inFlight.current || busy || !target) return;
    setTarget(null);
    restoreFocus(target);
  };
  return {
    request: (message: ChannelDialogMessage) => {
      if (!enabled || busy || inFlight.current || (!message.canDelete && !message.canDeleteAsAdmin))
        return;
      const bubble =
        Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
          .find((node) => node.dataset.messageId === message.id)
          ?.querySelector<HTMLElement>('.channel-dialog-message__bubble') ?? null;
      bubble?.focus({ preventScroll: true });
      onDismiss();
      setTarget({ id: message.id, admin: !message.canDelete, api, scope, returnFocus: bubble });
    },
    dialog: target ? (
      <Suspense
        fallback={
          <PendingDeleteSheet
            open={visible || submitting}
            title={
              target.admin ? 'Удалить чужой комментарий как администратор?' : 'Удалить комментарий?'
            }
            onClose={close}
          />
        }
      >
        <LazySheet
          id="comment-delete-confirm"
          open={visible || submitting}
          title={
            target.admin ? 'Удалить чужой комментарий как администратор?' : 'Удалить комментарий?'
          }
          previewTitle={messages.find((message) => message.id === target.id)?.text}
          confirmLabel="Удалить"
          confirmBusyLabel="Удаляем…"
          isBusy={busy || submitting}
          confirmDisabled={!visible}
          onClose={close}
          onConfirm={() => {
            if (busy || inFlight.current || !allowed(target, getMessage(target.id))) return;
            const selected = target;
            inFlight.current = true;
            setSubmitting(true);
            maxImpact('medium');
            void onDelete({ messageId: selected.id, deletedByAdmin: selected.admin })
              .then(() => {
                setTarget(null);
                restoreFocus(selected);
              })
              .catch(() => {
                /* FLAG: The mutation owns the visible error; retry remains explicit. */
              })
              .finally(() => {
                inFlight.current = false;
                setSubmitting(false);
              });
          }}
        />
      </Suspense>
    ) : null,
  };
}
