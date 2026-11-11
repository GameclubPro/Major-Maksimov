import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiErrorMessage } from '../src/lib/api-error';
import { createApiRequestError } from '../src/lib/api-request-error';
import { describeChannelMemberBanError } from '../src/lib/channel-member-ban-error';

function apiError(status: number, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return createApiRequestError(
    status,
    body,
    buildApiErrorMessage(status, body, 'application/json'),
  );
}

test('explains confirmed member capability failures without rendering server diagnostics', () => {
  const result = describeChannelMemberBanError(
    apiError(409, {
      code: 'BOT_CAPABILITY_REQUIRED',
      missingPermissions: ['add_remove_members'],
      message: 'MAXIM SQL add_remove_members exception',
      botId: 'private-bot-id',
      canRecheck: true,
    }),
  );
  assert.deepEqual(result, {
    message: 'Боту нужно право «Управлять участниками» в этом канале.',
    allowRetry: true,
  });
  assert.doesNotMatch(result.message, /MAXIM|SQL|add_remove_members|private-bot-id/iu);
});

test('keeps administrator denial separate from member management and respects recheck policy', () => {
  assert.deepEqual(
    describeChannelMemberBanError(
      apiError(409, {
        code: 'BOT_CAPABILITY_REQUIRED',
        missingPermissions: ['administrator'],
        canRecheck: false,
      }),
    ),
    { message: 'Назначьте бота администратором канала.', allowRetry: false },
  );
  assert.deepEqual(
    describeChannelMemberBanError(
      apiError(403, {
        code: 'BOT_PERMISSIONS_REQUIRED',
        missingPermissions: ['future_permission'],
      }),
    ),
    { message: 'Проверьте права бота в этом канале.', allowRetry: true },
  );
});

test('does not expose an unrelated forbidden response as bot permission evidence', () => {
  assert.deepEqual(
    describeChannelMemberBanError(
      apiError(403, { code: 'ACCESS_DENIED', message: 'Секретная диагностика сервера' }),
    ),
    { message: 'Недостаточно прав для этого действия.', allowRetry: false },
  );
});

test('allows a manual attempt after a known pre-mutation capability check failure', () => {
  assert.deepEqual(
    describeChannelMemberBanError(apiError(503, { code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE' })),
    { message: 'Не удалось проверить права бота. Попробуйте позже.', allowRetry: true },
  );
});

test('requires a read before another command for in-progress and changed sanction state', () => {
  for (const code of ['MODERATION_ACTION_IN_PROGRESS', 'MODERATION_ACTION_STATE_CHANGED']) {
    const result = describeChannelMemberBanError(apiError(409, { code }));
    assert.equal(result.allowRetry, false);
    assert.match(result.message, /Обновите события/u);
  }
});

test('blocks a second mutation when the result is unknown, including sanitized server failures', () => {
  for (const error of [
    apiError(503, { code: 'MODERATION_ACTION_STATUS_UNCERTAIN', message: 'Действие не выполнено' }),
    apiError(500, { code: 'BOT_CAPABILITY_REQUIRED', missingPermissions: ['add_remove_members'] }),
    apiError(504, {}),
    apiError(408, {}),
    apiError(409, { code: 'FUTURE_OPERATION_FAILURE', message: 'Попробуйте снова' }),
    new TypeError('Failed to fetch'),
    new Error('request timeout'),
    new DOMException('Aborted', 'AbortError'),
    new Error('Internal error'),
    new Error('Попробуйте заблокировать снова.'),
    undefined,
  ]) {
    assert.deepEqual(describeChannelMemberBanError(error), {
      message: 'Результат блокировки пока не подтверждён. Обновите события перед повтором.',
      allowRetry: false,
    });
  }
});

test('keeps useful definitive target guidance and throttling separate from unknown outcomes', () => {
  const message = 'Участник уже вышел из канала или был удалён.';
  assert.deepEqual(describeChannelMemberBanError(apiError(400, { message })), {
    message,
    allowRetry: true,
  });
  assert.deepEqual(describeChannelMemberBanError(apiError(429, {})), {
    message: 'Слишком много запросов. Повторите позже.',
    allowRetry: true,
  });
});
