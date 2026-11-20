import type { Dispatch, SetStateAction } from 'react';
import type { PublicationDraft } from './publication-model';
import { candidateImportText, describeImportWarning } from './publication-import-review-model';
import './publication-import-review.css';

export function PublicationImportReviewPanel({
  draft,
  setDraft,
  busy,
  onRestore,
}: {
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  busy: boolean;
  onRestore: (file: File, index: number) => Promise<void>;
}) {
  const review = draft.importReview;
  if (!review) return null;
  const pending = review.warnings
    .map((warning, index) => ({ warning, index }))
    .filter(({ index }) => !review.resolved.includes(index));
  const genericLoss =
    review.omissions.includes('attachments_not_imported') && review.warnings.length === 0;
  const formatting = review.omissions.includes('formatting_not_preserved');
  if (!pending.length && !genericLoss && !formatting) return null;
  const decide = (index: number, include: boolean) =>
    setDraft((current) => {
      const data = current.importReview;
      if (!data || data.resolved.includes(index)) return current;
      const warning = data.warnings[index];
      if (!warning) return current;
      const text = include ? candidateImportText(current.text, warning) : current.text;
      if (text === null) return current;
      return { ...current, text, importReview: { ...data, resolved: [...data.resolved, index] } };
    });
  return (
    <aside className="publication-import-review" aria-label="Что перенесено">
      <strong>{pending.length ? 'Проверьте перенос' : 'После переноса'}</strong>
      {genericLoss ? <p>Часть вложений не перенесена</p> : null}
      {formatting ? <p>Форматирование упрощено</p> : null}
      {pending.map(({ warning, index }) => {
        const offerText = warning.reason === 'optional_link' || warning.reason === 'outer_comment';
        const restore =
          ['image', 'video'].includes(warning.kind) &&
          ['unavailable', 'invalid', 'too_large'].includes(warning.reason);
        return (
          <div key={index} className="publication-import-review__row">
            <span>{describeImportWarning(warning)}</span>
            {offerText && warning.value ? <small>{warning.value}</small> : null}
            <div className="publication-import-review__actions">
              {offerText ? (
                <button
                  type="button"
                  disabled={busy || candidateImportText(draft.text, warning) === null}
                  onClick={() => decide(index, true)}
                >
                  Добавить в текст
                </button>
              ) : null}
              {restore ? (
                <label>
                  Выбрать файл
                  <input
                    type="file"
                    accept={warning.kind === 'video' ? 'video/*,.mp4,.mov,.mkv,.webm' : 'image/*'}
                    disabled={busy}
                    aria-label={'Выбрать файл: ' + describeImportWarning(warning)}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void onRestore(file, index);
                    }}
                  />
                </label>
              ) : null}
              <button type="button" disabled={busy} onClick={() => decide(index, false)}>
                {offerText || restore ? 'Пропустить' : 'Принять'}
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
