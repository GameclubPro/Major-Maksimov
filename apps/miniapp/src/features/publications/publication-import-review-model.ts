import type { PublicationImportReview } from '@maxim/contracts/publication-draft';
import type { PublisherPostImportWarning } from '@maxim/contracts/publisher';
import { MAX_PUBLICATION_TEXT_LENGTH } from '@maxim/contracts/publication';

const kinds = {
  image: 'Фото',
  video: 'Видео',
  link: 'Ссылка',
  text: 'Текст',
  attachment: 'Вложение',
} as const;
const reasons = {
  unavailable: 'не удалось загрузить',
  too_large: 'превышен размер файла',
  invalid: 'файл не читается',
  limit: 'превышен лимит',
  unsupported: 'формат не поддерживается',
  duplicate: 'повтор',
  optional_link: 'добавить ссылку из карточки?',
  outer_comment: 'добавить комментарий к пересылке?',
  outer_media: 'взято из сообщения с пересылкой',
} as const;

export function describeImportWarning(warning: PublisherPostImportWarning) {
  const prefix = 'Сообщение ' + warning.messageIndex;
  if (warning.kind === 'text' && warning.reason === 'too_large') {
    return prefix + ' · Текст слишком длинный';
  }
  return (
    prefix +
    ' · ' +
    kinds[warning.kind] +
    (warning.itemIndex ? ' №' + warning.itemIndex : '') +
    ' — ' +
    reasons[warning.reason]
  );
}

export function reviewNeedsChoice(review: PublicationImportReview | undefined) {
  return Boolean(review?.warnings.some((_, index) => !review.resolved.includes(index)));
}

export function candidateImportText(text: string, warning: PublisherPostImportWarning) {
  if (!warning.value || !['optional_link', 'outer_comment'].includes(warning.reason)) return null;
  const value = warning.value.trim();
  if (!value) return null;
  if (warning.reason === 'optional_link') {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  const result = text ? text + '\n\n' + value : value;
  return result.length <= MAX_PUBLICATION_TEXT_LENGTH ? result : null;
}

export function restoredMediaPosition(
  review: PublicationImportReview,
  index: number,
  length: number,
) {
  const position = review.warnings[index]?.mediaPosition;
  if (position === undefined) return length;
  const missingEarlier = review.warnings.filter(
    (warning, i) =>
      warning.mediaPosition !== undefined &&
      warning.mediaPosition < position &&
      !review.restored?.includes(i) &&
      warning.reason !== 'outer_media',
  ).length;
  return Math.max(0, Math.min(length, position - missingEarlier));
}
