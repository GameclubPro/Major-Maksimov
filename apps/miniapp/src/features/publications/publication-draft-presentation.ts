import { describeUserFacingError } from '../../lib/user-facing-error';
import type { DraftSaveState } from './publication-draft-autosave';

export function publicationDraftNeedsAttention(state: DraftSaveState): boolean {
  return ['error', 'conflict', 'unavailable'].includes(state.status);
}

export function publicationDraftSaveLabel(
  state: DraftSaveState,
  dirty: boolean,
  deviceCopyIsCurrent = false,
): string {
  if (state.status === 'saving') return 'Сохраняется...';
  if (publicationDraftNeedsAttention(state) || dirty) {
    return deviceCopyIsCurrent ? 'На этом устройстве' : 'Не сохранено';
  }
  return state.status === 'saved' ? 'Сохранено' : '';
}

export function publicationDraftProblem(state: DraftSaveState): { title: string; detail: string } {
  if (state.status === 'conflict')
    return {
      title: 'Черновик изменился',
      detail: 'Есть сохранённый вариант. Ваши правки остались здесь.',
    };
  if (state.status === 'unavailable')
    return {
      title: 'Черновик недоступен',
      detail: 'Он мог быть удалён или опубликован. Ваши правки остались здесь.',
    };
  return {
    title: 'Не удалось сохранить',
    detail: describeUserFacingError(state.error, 'Изменения пока не сохранены.'),
  };
}
