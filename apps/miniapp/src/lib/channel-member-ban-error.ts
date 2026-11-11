import { ApiRequestError } from './api-request-error';
import { getBotPermissionBlockerLabels, parseBotPermissionBlocker } from './bot-permission-error';
import { describeUserFacingError } from './user-facing-error';

export type ChannelMemberBanError = {
  message: string;
  allowRetry: boolean;
};

const UNKNOWN_RESULT_MESSAGE =
  'Результат блокировки пока не подтверждён. Обновите события перед повтором.';
const FALLBACK_MESSAGE = 'Не удалось заблокировать участника.';

export function describeChannelMemberBanError(error: unknown): ChannelMemberBanError {
  const blocker = parseBotPermissionBlocker(error);
  if (blocker) {
    const labels = getBotPermissionBlockerLabels(blocker);
    const message =
      labels.length === 1 && labels[0] === 'Права администратора'
        ? 'Назначьте бота администратором канала.'
        : labels.length === 1 && labels[0] === 'Управлять участниками'
          ? 'Боту нужно право «Управлять участниками» в этом канале.'
          : labels.every((label) => label === 'Права бота в MAX')
            ? 'Проверьте права бота в этом канале.'
            : `Боту не хватает прав в канале: «${labels.join('», «')}».`;
    return { message, allowRetry: blocker.canRecheck };
  }

  if (error instanceof ApiRequestError) {
    if (error.status === 503 && error.code === 'BOT_CAPABILITY_CHECK_UNAVAILABLE') {
      return {
        message: 'Не удалось проверить права бота. Попробуйте позже.',
        allowRetry: true,
      };
    }
    if (error.status === 409 && error.code === 'MODERATION_ACTION_IN_PROGRESS') {
      return {
        message: 'Действие для этого участника уже выполняется. Обновите события.',
        allowRetry: false,
      };
    }
    if (error.status === 409 && error.code === 'MODERATION_ACTION_STATE_CHANGED') {
      return {
        message: 'Состояние участника изменилось. Обновите события.',
        allowRetry: false,
      };
    }
    if (error.status === 401) {
      return {
        message: 'Срок входа истёк. Закройте мини-приложение и откройте его снова из MAX.',
        allowRetry: false,
      };
    }
    if (error.status === 403) {
      return { message: 'Недостаточно прав для этого действия.', allowRetry: false };
    }
    if (error.status === 429) {
      return { message: 'Слишком много запросов. Повторите позже.', allowRetry: true };
    }
    // FLAG: An unrecognized failure cannot establish that the member mutation did not run.
    if (error.status >= 500 || error.status === 408 || error.code) {
      return { message: UNKNOWN_RESULT_MESSAGE, allowRetry: false };
    }
    return {
      message: describeUserFacingError(error, FALLBACK_MESSAGE),
      allowRetry: true,
    };
  }

  return { message: UNKNOWN_RESULT_MESSAGE, allowRetry: false };
}
