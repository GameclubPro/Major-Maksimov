import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import type { PublicationSummary } from '@maxim/contracts/publication';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { listPublications } from '../../lib/api/publication-client';
import { deleteServerPublicationDraft } from '../../lib/api/publication-drafts-client';
import type { ApiTransport } from '../../lib/api/transport';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { createPublicationRequestId } from './publication-request-identity';
import { mergePublicationPages } from './publication-pagination';
import './publication-drafts.css';

export function PublicationDraftsSheet({
  api,
  busy,
  onClose,
  onOpen,
  onDeleted,
  protectedDraftId,
}: {
  api: ApiTransport;
  busy: boolean;
  onClose: () => void;
  onOpen?: (id: string, copy: boolean) => void;
  protectedDraftId?: string;
  onDeleted: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState<PublicationSummary | null>(null);
  const drafts = useInfiniteQuery({
    queryKey: ['publications', 'list', 'drafts'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, { view: 'drafts', limit: 20, cursor: pageParam ?? undefined }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 0,
  });
  const remove = useMutation({
    mutationFn: (draft: PublicationSummary) =>
      deleteServerPublicationDraft(api, draft.id, {
        requestId: createPublicationRequestId(),
        expectedRevision: draft.version,
      }),
    onSuccess: async (_, draft) => {
      setDeleting(null);
      onDeleted(draft.id);
      await drafts.refetch();
    },
  });
  const blocked = busy || remove.isPending;
  const DraftTitle = onOpen ? 'button' : 'div';
  useDialogFocusTrap(!deleting, panel, close);
  useNativeBackHandler(
    () => {
      if (!blocked) onClose();
      return true;
    },
    { enabled: !deleting, priority: 730 },
  );
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel.current && isTopmostModalDialog(panel.current)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!blocked) onClose();
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', escape);
    };
  }, [blocked, onClose]);
  return createPortal(
    <>
      <div className="publication-drafts-sheet">
        <button
          className="publication-drafts-sheet__backdrop"
          type="button"
          tabIndex={-1}
          aria-label="Закрыть черновики"
          disabled={blocked}
          onClick={onClose}
        />
        <section
          className="publication-drafts-sheet__panel"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="publication-drafts-title"
          tabIndex={-1}
        >
          <header>
            <h2 id="publication-drafts-title">Черновики</h2>
            <button
              type="button"
              ref={close}
              disabled={blocked}
              onClick={onClose}
              aria-label="Закрыть"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
            </button>
          </header>
          <div className="publication-drafts-sheet__body" aria-busy={drafts.isFetching || blocked}>
            {drafts.isPending ? <p role="status">Загрузка...</p> : null}
            {drafts.isError ? (
              <p role="alert">
                Не удалось загрузить черновики.{' '}
                <button type="button" onClick={() => void drafts.refetch()}>
                  <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
                  Повторить
                </button>
              </p>
            ) : null}
            {drafts.isSuccess && !drafts.data.pages[0]?.items.length ? (
              <p>Нет сохранённых черновиков</p>
            ) : null}
            {mergePublicationPages(drafts.data?.pages).map((draft) => (
              <article
                className={`publication-drafts-sheet__row${onOpen ? '' : ' is-manage'}`}
                key={draft.id}
              >
                <DraftTitle
                  className="publication-drafts-sheet__open"
                  {...(onOpen
                    ? {
                        type: 'button' as const,
                        disabled: blocked,
                        onClick: () => onOpen(draft.id, false),
                      }
                    : {})}
                >
                  <strong>
                    {draft.title || (
                      <MaxMarkdownPreview
                        value={draft.contentPreview || 'Без названия'}
                        sourceFormat={draft.contentPreviewFormat}
                        normalizeWhitespace
                      />
                    )}
                  </strong>
                  <small>
                    {new Intl.DateTimeFormat('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(draft.updatedAt))}
                  </small>
                </DraftTitle>
                {onOpen ? (
                  <button
                    type="button"
                    disabled={blocked}
                    title="Создать копию"
                    aria-label="Создать копию черновика"
                    onClick={() => onOpen?.(draft.id, true)}
                  >
                    <IconoirSprite variant="iconoir" icon="Copy" aria-hidden />
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={blocked || draft.id === protectedDraftId}
                  title={draft.id === protectedDraftId ? 'Открыт в редакторе' : 'Удалить'}
                  aria-label="Удалить черновик"
                  onClick={() => {
                    remove.reset();
                    setDeleting(draft);
                  }}
                >
                  <IconoirSprite variant="iconoir" icon="Trash" aria-hidden />
                </button>
              </article>
            ))}
            {drafts.hasNextPage ? (
              <button
                type="button"
                disabled={drafts.isFetchingNextPage}
                onClick={() => void drafts.fetchNextPage()}
              >
                Показать ещё
              </button>
            ) : null}
          </div>
        </section>
      </div>
      <ActionConfirmSheet
        id="publication-server-draft-delete"
        open={Boolean(deleting)}
        title="Удалить черновик?"
        summary={
          remove.isError
            ? describeUserFacingError(remove.error, 'Не удалось удалить черновик.')
            : 'Черновик исчезнет на всех устройствах.'
        }
        confirmLabel="Удалить"
        confirmBusyLabel="Удаляем..."
        cancelLabel="Оставить"
        tone="danger"
        isBusy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}
