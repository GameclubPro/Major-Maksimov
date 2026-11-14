import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';

import type { DraftSaveState } from './publication-draft-autosave';
import {
  publicationDraftNeedsAttention,
  publicationDraftProblem,
  publicationDraftSaveLabel,
} from './publication-draft-presentation';
import './publication-drafts.css';

export function PublicationDraftSaveIndicator({
  state,
  dirty,
}: {
  state: DraftSaveState;
  dirty: boolean;
}) {
  return (
    <small className="publication-draft-indicator" role="status">
      {publicationDraftSaveLabel(state, dirty)}
    </small>
  );
}

export function PublicationDraftStatus({
  state,
  busy,
  onRetry,
  onReload,
  onCopy,
  onDrafts,
}: {
  state: DraftSaveState;
  busy: boolean;
  onRetry: () => void;
  onReload: () => void;
  onCopy: () => void;
  onDrafts: () => void;
}) {
  if (!publicationDraftNeedsAttention(state)) return null;
  const problem = publicationDraftProblem(state);
  return (
    <div className="publication-draft-status is-error" role="alert">
      <span>
        <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
        <strong>{problem.title}</strong>
      </span>
      <small>{problem.detail}</small>
      <div>
        <button type="button" disabled={busy} onClick={onDrafts}>
          <IconoirSprite variant="iconoir" icon="Post" aria-hidden />
          Черновики
        </button>
        {state.status === 'conflict' || state.status === 'unavailable' ? (
          <>
            {state.status === 'conflict' ? (
              <button type="button" disabled={busy} onClick={onReload}>
                <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
                Обновить
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={onCopy}>
              <IconoirSprite variant="iconoir" icon="Copy" aria-hidden />
              Сохранить копию
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={onRetry}>
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}
