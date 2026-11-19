import { formatPublicationMediaSummary } from './publication-page-formatters';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import type { PublicationSummary } from '@maxim/contracts/publication';
import type { PublisherPostImportSession } from '@maxim/contracts/publisher';

import { useState } from 'react';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { cn } from '../../lib/cn';
import { resolvePublisherPostImportPresentation } from './publisher-post-import-model';
import './publisher-post-import-status.css';

function resolveDraftPreview(publication: PublicationSummary): string {
  if (publication.contentPreview.trim()) {
    return publication.contentPreview;
  }
  return formatPublicationMediaSummary(publication) ?? 'Без текста';
}

export type PublisherPostImportStatusProps = {
  readError?: string | null;
  onReadRetry?: () => void;
  session: PublisherPostImportSession | null;
  drafts: PublicationSummary[];
  busy?: boolean;
  hasMoreDrafts?: boolean;
  loadingMoreDrafts?: boolean;
  onOpenBot: (botUrl: string) => void;
  onOpenDraft: (publicationId: string) => void;
  onLoadMoreDrafts?: () => void;
  onRetry: () => void;
  onCancel: () => void;
};

export function PublisherPostImportStatus({
  session,
  readError,
  onReadRetry,
  drafts,
  busy = false,
  hasMoreDrafts = false,
  loadingMoreDrafts = false,
  onOpenBot,
  onOpenDraft,
  onLoadMoreDrafts,
  onRetry,
  onCancel,
}: PublisherPostImportStatusProps) {
  const [draftsExpanded, setDraftsExpanded] = useState(false);
  const presentation = session ? resolvePublisherPostImportPresentation(session) : null;
  const activePublicationId = session?.status === 'ready' ? session.publicationId : null;
  const visibleDrafts = drafts.filter((draft) => draft.id !== activePublicationId);
  const displayedDrafts = draftsExpanded ? visibleDrafts : visibleDrafts.slice(0, 3);
  const hasHiddenDrafts = visibleDrafts.length > displayedDrafts.length || hasMoreDrafts;
  const actionLabel =
    presentation?.action === 'open-bot'
      ? 'Открыть Публика'
      : presentation?.action === 'open-draft'
        ? 'Продолжить'
        : presentation?.action === 'retry'
          ? 'Повторить'
          : null;
  const cancelable = session?.status === 'waiting' || session?.status === 'processing';

  if (!readError && !presentation && visibleDrafts.length === 0) {
    return null;
  }

  return (
    <div className="publisher-post-imports">
      {readError ? (
        <div className="publisher-post-import-status is-danger" role="alert">
          <span className="publisher-post-import-status__copy">
            <strong>{readError}</strong>
          </span>
          <button
            type="button"
            className="publisher-post-import-status__action"
            onClick={onReadRetry}
          >
            Загрузить снова
          </button>
        </div>
      ) : presentation && session ? (
        <div
          className={cn('publisher-post-import-status', `is-${presentation.tone}`)}
          role={presentation.tone === 'danger' ? 'alert' : 'status'}
          aria-busy={session.status === 'processing' || busy || undefined}
        >
          <span className="publisher-post-import-status__icon" aria-hidden>
            {session.status === 'waiting' ? (
              <IconoirSprite variant="iconoir" icon="Forward" />
            ) : session.status === 'processing' ? (
              <IconoirSprite variant="iconoir" icon="RefreshDouble" className="is-spinning" />
            ) : presentation.tone === 'ready' ? (
              <IconoirSprite variant="iconoir" icon="CheckCircle" />
            ) : (
              <IconoirSprite variant="iconoir" icon="WarningCircle" />
            )}
          </span>
          <span className="publisher-post-import-status__copy">
            <strong>{presentation.title}</strong>
            {presentation.detail ? <small>{presentation.detail}</small> : null}
          </span>
          {actionLabel ? (
            <button
              type="button"
              className="publisher-post-import-status__action"
              disabled={busy}
              onClick={() => {
                if (presentation.action === 'open-bot' && session.botUrl) {
                  onOpenBot(session.botUrl);
                } else if (presentation.action === 'open-draft' && session.publicationId) {
                  onOpenDraft(session.publicationId);
                } else if (presentation.action === 'retry') {
                  onRetry();
                }
              }}
            >
              {actionLabel}
            </button>
          ) : null}
          {cancelable ? (
            <button
              type="button"
              className="publisher-post-import-status__cancel"
              onClick={onCancel}
              disabled={busy}
              aria-label="Отменить перенос"
              title="Отменить"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {visibleDrafts.length > 0 ? (
        <section className="publisher-server-drafts" aria-labelledby="publisher-drafts-title">
          <h2 id="publisher-drafts-title">Черновики</h2>
          <div className="publisher-server-drafts__list">
            {displayedDrafts.map((publication) => (
              <button
                key={publication.id}
                type="button"
                className="publisher-server-draft"
                onClick={() => onOpenDraft(publication.id)}
                disabled={busy}
              >
                <IconoirSprite variant="iconoir" icon="PageEdit" aria-hidden />
                <span>
                  <strong>{publication.title.trim() || 'Черновик'}</strong>
                  <MaxMarkdownPreview
                    value={resolveDraftPreview(publication)}
                    sourceFormat={publication.contentPreviewFormat}
                    className="publisher-server-draft__preview"
                    normalizeWhitespace
                  />
                </span>
                <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
              </button>
            ))}
          </div>
          {hasHiddenDrafts || (draftsExpanded && visibleDrafts.length > 3) ? (
            <button
              type="button"
              className="publisher-server-drafts__more"
              onClick={() => {
                if (!draftsExpanded) {
                  setDraftsExpanded(true);
                  if (visibleDrafts.length <= 3 && hasMoreDrafts) {
                    onLoadMoreDrafts?.();
                  }
                  return;
                }
                if (hasMoreDrafts) {
                  onLoadMoreDrafts?.();
                } else {
                  setDraftsExpanded(false);
                }
              }}
              disabled={loadingMoreDrafts}
            >
              {loadingMoreDrafts
                ? 'Загрузка...'
                : !draftsExpanded
                  ? 'Все черновики'
                  : hasMoreDrafts
                    ? 'Показать ещё'
                    : 'Свернуть'}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
