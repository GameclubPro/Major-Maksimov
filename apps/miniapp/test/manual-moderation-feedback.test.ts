import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import {
  describeManualModerationFeedback,
  describeManualModerationReleaseError,
} from '../src/lib/manual-moderation-feedback';

type Result = Parameters<typeof describeManualModerationFeedback>[0];
const describe = (message: string, overrides: Partial<Result> = {}) =>
  describeManualModerationFeedback({ action: 'MUTE', muteDurationHours: 6, message, ...overrides });

test('known restriction results use the confirmed action and duration', () => {
  assert.equal(describe('Мут включён на 6 ч.'), 'Сообщения ограничены на 6 ч.');
  assert.equal(
    describe('Мут включён на 336 ч.', { muteDurationHours: 336 }),
    'Сообщения ограничены на 336 ч.',
  );
  assert.equal(
    describe('Мут включён без срока.', { muteDurationHours: null }),
    'Сообщения ограничены без срока.',
  );
  assert.equal(
    describe('Мут снят. Автоматическое удаление новых сообщений остановлено.', {
      action: 'UNMUTE',
      muteDurationHours: null,
    }),
    'Ограничение снято. Участник снова может писать.',
  );
});

test('known block results remain distinct from removing a participant', () => {
  for (const [message, expected] of [
    ['Бан включён.', 'Участник заблокирован.'],
    ['Бан уже включён.', 'Участник уже заблокирован.'],
    ['Участник удалён из чата.', 'Участник удалён из чата.'],
    ['Участник уже удалён из чата.', 'Участник уже удалён из чата.'],
  ]) {
    assert.equal(describe(message, { action: 'BAN', muteDurationHours: null }), expected);
  }
});

test('confirmed unban is concise and the manual check gives the next action', () => {
  for (const message of [
    'Бан снят.',
    'Блокировка снята. Участник уже в чате, добавлять его повторно не понадобилось.',
    'Блокировка снята, участник возвращён в чат.',
  ]) {
    assert.equal(describe(message, { action: 'UNBAN', muteDurationHours: null }), 'Бан снят.');
  }
  const error = new ApiRequestError(
    400,
    '{"code":"MAX_MEMBER_RESTORE_UNAVAILABLE"}',
    'MAX больше не поддерживает возврат участника через API.',
  );
  assert.equal(
    describeManualModerationReleaseError(error, 'Не удалось снять бан.'),
    'Добавьте участника в MAX, затем проверьте.',
  );
});

test('different outcomes and multi-chat counts are not inferred from the requested action', () => {
  for (const message of [
    'Блокировка применена в 3 из 5 чатов. Ошибок: 2.',
    'Мут включён на 6 ч. Обработано чатов: 3. Пропущено: 1.',
    'Участника не удалось вернуть в чат. Проверьте права бота.',
  ]) {
    assert.equal(describe(message), message);
  }
  assert.equal(describe('Мут включён на 24 ч.'), 'Мут включён на 24 ч.');
  assert.equal(describe('Бан включён.', { action: 'UNBAN' }), 'Бан включён.');
});

test('unexpected technical payloads use the existing safe presentation boundary', () => {
  for (const message of [
    'INTERNAL_EVENT_ID: 123',
    '<html>Ошибка сервера</html>',
    'Действие выполнено {"token":"private"}',
    '',
  ]) {
    assert.equal(describe(message), 'Действие выполнено.');
  }
});
