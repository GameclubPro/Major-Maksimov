import { commentRestrictionSchema, type CommentRestriction } from '@maxim/contracts/channel-dialog';
import { ApiRequestError } from './api-request-error';

export function commentRestrictionLabel(restriction: CommentRestriction | undefined): string {
  if (restriction?.kind === 'BAN') return 'Бессрочная блокировка';
  if (restriction?.kind === 'MUTE' && restriction.expiresAt) {
    return `Запрет на комментарии до ${new Date(restriction.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  return 'Без ограничений';
}

export function describeCommentRestrictionError(error: unknown): string | null {
  if (
    !(error instanceof ApiRequestError) ||
    error.status !== 403 ||
    error.code !== 'COMMENT_RESTRICTED'
  ) {
    return null;
  }
  const restriction = commentRestrictionSchema.safeParse(error.payload?.restriction);
  if (restriction.success && restriction.data.kind === 'BAN') {
    return 'Вы заблокированы в комментариях этого сообщества.';
  }
  if (restriction.success && restriction.data.kind === 'MUTE') {
    return 'Вам временно запрещено писать комментарии.';
  }
  return 'Участие в комментариях этого сообщества ограничено.';
}
