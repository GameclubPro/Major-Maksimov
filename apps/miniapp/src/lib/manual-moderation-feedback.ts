import type { ManualModerationActionResult } from '@maxim/contracts';
import { ApiRequestError } from './api-request-error';
import { describeUserFacingError } from './user-facing-error';

export const MAX_UNBAN_CHECK_LABEL = 'Проверить снятие в MAX';
export const MAX_UNBAN_CHECK_GUIDANCE = 'Добавьте участника в MAX, затем проверьте.';

export function describeManualModerationReleaseError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === 'MAX_MEMBER_RESTORE_UNAVAILABLE') {
    return MAX_UNBAN_CHECK_GUIDANCE;
  }
  return describeUserFacingError(error, fallback);
}

export function describeManualModerationFeedback({
  action,
  message,
  muteDurationHours,
}: Pick<ManualModerationActionResult, 'action' | 'message' | 'muteDurationHours'>): string {
  // FLAG: Preserve removal-only and partial results; rewrite only matching, known outcomes.
  if (action === 'MUTE') {
    if (muteDurationHours !== null && message === `Мут включён на ${muteDurationHours} ч.`) {
      return `Сообщения ограничены на ${muteDurationHours} ч.`;
    }
    if (muteDurationHours === null && message === 'Мут включён без срока.') {
      return 'Сообщения ограничены без срока.';
    }
  }
  if (
    action === 'UNMUTE' &&
    message === 'Мут снят. Автоматическое удаление новых сообщений остановлено.'
  ) {
    return 'Ограничение снято. Участник снова может писать.';
  }
  if (action === 'BAN') {
    if (message === 'Бан включён.') return 'Участник заблокирован.';
    if (message === 'Бан уже включён.') return 'Участник уже заблокирован.';
  }
  if (
    action === 'UNBAN' &&
    (message === 'Блокировка снята. Участник уже в чате, добавлять его повторно не понадобилось.' ||
      message === 'Блокировка снята, участник возвращён в чат.')
  ) {
    return 'Бан снят.';
  }
  return describeUserFacingError(new Error(message), 'Действие выполнено.');
}

export const MUTE_DURATION_MIN_HOURS = 1;
export const MUTE_DURATION_MAX_HOURS = 336;

export function clampMuteDurationHours(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : MUTE_DURATION_MIN_HOURS;
  return Math.max(MUTE_DURATION_MIN_HOURS, Math.min(MUTE_DURATION_MAX_HOURS, normalized));
}
