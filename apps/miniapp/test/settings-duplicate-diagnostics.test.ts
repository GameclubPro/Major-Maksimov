import type {
  DuplicateDeletionAttempt,
  DuplicateObservationDiagnostics,
} from '@maxim/contracts/settings';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { chatSettingsSchema, duplicateDiagnosticsResponseSchema } from '@maxim/contracts/settings';
import SettingsDuplicateDiagnostics from '../src/pages/settings/settings-duplicate-diagnostics';
import { formatDuplicateAllowanceLabel } from '../src/pages/settings/settings-duplicate-flow';
import { formatDuplicateSettingsSummary } from '../src/pages/settings/settings-duplicate-photo-status';
import type { ApiTransport } from '../src/lib/api/transport';

const time = '2026-09-14T12:00:00.000Z';
test('settings summary uses the same message numbering as the controls and keeps disabled state explicit', () => {
  const settings = chatSettingsSchema.parse({
    antiDuplicateEnabled: true,
    duplicateBotMessageEnabled: false,
    duplicateWarnEnabled: true,
    duplicateWarnMaxCount: 2,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
  });
  assert.equal(
    formatDuplicateSettingsSummary(settings, 12),
    'удаление с сообщения №3 • 12 ч • картинки недоступны',
  );
  assert.equal(formatDuplicateSettingsSummary(null, 12), 'Выключено');
  assert.equal(
    formatDuplicateSettingsSummary(settings, 12, {
      moderationMode: 'FULL',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['canonical_sha256'],
    }),
    'удаление с сообщения №3 • 12 ч • картинки включены',
  );
  assert.equal(
    formatDuplicateSettingsSummary({ ...settings, duplicateCompareMode: 'TEXT' }, 12, {
      moderationMode: 'FULL',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['canonical_sha256'],
    }),
    'удаление с сообщения №3 • 12 ч • картинки включены',
  );
});
function render(
  state: 'CONFIRMED' | 'MISSING' | 'UNKNOWN',
  options = { available: true, limited: false, failed: false },
  attempts: DuplicateDeletionAttempt[] = [],
  observation?: DuplicateObservationDiagnostics,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['duplicate-diagnostics', 'user', 'chat'];
  client.setQueryData(
    key,
    duplicateDiagnosticsResponseSchema.parse({
      generatedAt: time,
      enabled: true,
      mode: 'FULL',
      capability: { state, checkedAt: time },
      observation,
      history: {
        available: options.available,
        since: time,
        sampledIntents: 0,
        limited: options.limited,
        attempts,
      },
    }),
  );
  if (options.failed)
    client
      .getQueryCache()
      .find({ queryKey: key })!
      .setState({ status: 'error', error: new Error('offline') });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        IsRestoringProvider,
        { value: true },
        createElement(SettingsDuplicateDiagnostics, {
          api: {} as ApiTransport,
          chatId: 'chat',
          userId: 'user',
        }),
      ),
    ),
  );
  client.clear();
  return html;
}
test('message numbering presents the stored allowance without changing its meaning', () => {
  assert.equal(formatDuplicateAllowanceLabel(0), 'удаление с сообщения №2');
  assert.equal(formatDuplicateAllowanceLabel(1), 'удаление с сообщения №3');
  assert.equal(formatDuplicateAllowanceLabel(19), 'удаление с сообщения №21');
});
test('permission state is distinct from the enabled setting', () => {
  assert.match(render('CONFIRMED'), /Права удаления подтверждены/);
  const missing = render('MISSING');
  assert.match(missing, /Нет прав удаления/);
  assert.match(missing, /Сохранённая настройка/);
  assert.match(missing, /Включена/);
  assert.match(render('UNKNOWN'), /Права удаления не подтверждены/);
});
test('refresh errors never reuse the old confirmed badge', () => {
  const html = render('CONFIRMED', { available: true, limited: false, failed: true });
  assert.doesNotMatch(html, />Права удаления подтверждены</);
  assert.match(html, /Не удалось обновить проверку/);
});
test('unknown and capped history do not claim there were no attempts', () => {
  const unavailable = render('UNKNOWN', { available: false, limited: false, failed: false });
  assert.match(unavailable, /История временно недоступна/);
  assert.doesNotMatch(unavailable, /Попыток удаления не было/);
  const partial = render('CONFIRMED', { available: true, limited: true, failed: false });
  assert.match(partial, /Неполная выборка/);
  assert.doesNotMatch(partial, /Попыток удаления не было/);
});

test('keeps missing and zero coverage distinct and never presents a comparison as deletion', () => {
  const missing = {
    state: 'NO_DATA' as const,
    since: time,
    until: time,
    basis: 'ATTEMPTS' as const,
    completeness: 'BEST_EFFORT' as const,
    supportedAttempts: null,
    verifiedAttempts: null,
    coverage: null,
    outcomes: [],
  };
  assert.match(render('CONFIRMED', undefined, [], missing), /Данные о проверках ещё не поступили/);
  assert.doesNotMatch(render('CONFIRMED', undefined, [], missing), /\(0%\)/);
  const zero = render('CONFIRMED', undefined, [], {
    ...missing,
    state: 'AVAILABLE',
    supportedAttempts: 2,
    verifiedAttempts: 0,
    coverage: 0,
    outcomes: [{ outcome: 'COMPARISON_FAILED', count: 2 }],
  });
  assert.match(zero, /0 из 2 поддерживаемых попыток \(0%\)/);
  assert.match(zero, /Сравнение не завершилось/);
  assert.match(zero, /Повторные попытки учитываются отдельно/);
  assert.match(zero, /Результат сравнения не подтверждает удаление/);
  assert.doesNotMatch(zero, />Удалено</);
});

test('shows the fixed original window without confusing it with delivery retries', () => {
  const html = render('CONFIRMED', undefined, [
    {
      id: 'attempt',
      createdAt: time,
      updatedAt: time,
      outcome: 'DELETED',
      reason: null,
      nextAttemptAt: null,
      original: {
        messageId: 'original-id',
        publishedAt: time,
        repeatAllowedAt: '2026-09-15T12:00:00.000Z',
      },
    },
  ]);
  assert.match(html, /Оригинал:/);
  assert.match(html, /Повтор разрешён с/);
  assert.match(html, /original-id/);
  assert.doesNotMatch(html, /Следующая попытка:/);
});
