import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chatSettingsSchema,
  type ChatClosureStatus,
  type NightModeNoticeObservation,
} from '@maxim/contracts/settings';
import SettingsChatClosureStatus from '../src/pages/settings/settings-chat-closure-status';
import {
  getNightTimezoneOptions,
  RUSSIAN_TIMEZONE_OPTIONS,
} from '../src/pages/settings/settings-timezones';
import { getNightStatusRefreshDelay } from '../src/pages/settings/use-settings-screen-query';
import { createPreviewOpenChatClosure } from '../src/lib/api/preview-chat-closure';

function observation(scheduledFor: string): NightModeNoticeObservation {
  return {
    enabledNow: true,
    latest: {
      sessionKey: scheduledFor,
      scheduledFor,
      catchUp: { state: 'expired', endsAt: scheduledFor },
      scheduling: 'recorded',
      delivery: { outcome: 'sent', reason: 'successful_receipt', sentAt: scheduledFor },
    },
  };
}
function status(): ChatClosureStatus {
  return {
    observedAt: '2026-10-30T12:00:00.000Z',
    scheduleEnabled: true,
    restriction: 'open',
    timezone: 'Europe/Moscow',
    opensAt: null,
    deleteRoute: 'available',
    notice: 'delivered',
    recovery: 'idle',
    notices: {
      expectationBasis: 'current_schedule',
      boundary: 'daily',
      evidenceScope: 'exact_send_ledger',
      sendRouteNow: 'available',
      close: observation('2026-10-29T19:00:00.000Z'),
      open: observation('2026-10-30T04:00:00.000Z'),
      recovery: { scope: 'latest_occurrences', observation: 'complete', obligations: [] },
    },
  };
}
function render(value: ChatClosureStatus, refreshFailed = false) {
  return renderToStaticMarkup(
    createElement(SettingsChatClosureStatus, { status: value, refreshFailed }),
  );
}
test('night status shows the current chat state without delivery or recovery diagnostics', () => {
  const value = status();
  value.recovery = 'action_required';
  value.notices!.close.latest!.delivery = {
    outcome: 'not_recorded',
    reason: 'ledger_missing',
    sentAt: null,
  };
  value.notices!.open.latest!.delivery = { outcome: 'unknown', reason: 'ambiguous', sentAt: null };
  value.notices!.recovery.observation = 'partial';
  const html = render(value);
  assert.match(html, /Чат открыт/);
  assert.doesNotMatch(
    html,
    /Уведомление о закрытии|Уведомление об открытии|подтвержден|По расписанию|отправки|восстановлен|Проверено|data-outcome/iu,
  );
});
test('closed chat shows its next opening in the saved timezone', () => {
  const value = status();
  value.restriction = 'night';
  value.opensAt = '2026-10-31T04:00:00.000Z';
  const html = render(value);
  assert.match(html, /Чат закрыт/);
  assert.match(html, /Открытие: 31 октября.*07:00/);
});
test('missing bot permissions keep an actionable error for deletion and enabled notices', () => {
  const value = status();
  value.deleteRoute = 'unavailable';
  value.notices!.sendRouteNow = 'unavailable';
  const html = render(value);
  assert.match(html, /Бот не может удалять сообщения/);
  assert.match(html, /Бот не может отправлять уведомления/);
  assert.match(html, /Проверьте его права администратора/);
  value.notices!.close.enabledNow = false;
  value.notices!.open.enabledNow = false;
  assert.doesNotMatch(render(value), /Бот не может отправлять уведомления/);
});
test('failed refresh marks the retained state as old and offers a retry', () => {
  const html = render(status(), true);
  assert.match(html, /Не удалось обновить состояние/);
  assert.match(html, /Обновите экран/);
  assert.match(html, /Последнее состояние: Чат открыт/);
});
test('old payloads and continuous schedules do not add technical copy', () => {
  const value = status();
  value.notices!.boundary = 'continuous';
  value.notices!.close.latest = null;
  value.notices!.open.latest = null;
  assert.equal(render(value), render(status()));
  delete value.notices;
  assert.equal(render(value), render(status()));
});
test('saved international timezones remain selectable and never receive Moscow labels', () => {
  for (const [timezone, openingTime] of [
    ['Europe/Berlin', '05:00'],
    ['America/New_York', '00:00'],
  ]) {
    const options = getNightTimezoneOptions(timezone);
    assert.equal(options[0].value, timezone);
    assert.doesNotMatch(options[0].label, /Москва|Московское/);
    const value = status();
    value.timezone = timezone;
    value.restriction = 'night';
    value.opensAt = '2026-10-31T04:00:00.000Z';
    assert.ok(render(value).includes(openingTime));
    assert.doesNotMatch(render(value), /Московское время/);
  }
  assert.equal(getNightTimezoneOptions('Europe/Moscow'), RUSSIAN_TIMEZONE_OPTIONS);
});
test('refresh delay follows the saved next boundary and bounds stale or distant refreshes', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  assert.equal(getNightStatusRefreshDelay('2026-10-30T12:00:10.000Z', now), 10_250);
  assert.equal(getNightStatusRefreshDelay('2026-10-30T12:00:00.100Z', now), 1_000);
  for (const boundary of [
    null,
    undefined,
    'invalid',
    '2026-10-29T12:00:00.000Z',
    '2026-10-31T12:00:00.000Z',
  ]) {
    assert.equal(getNightStatusRefreshDelay(boundary, now), 60_000);
  }
});
test('preview exposes independent switches with no fabricated historical sends', () => {
  const preview = createPreviewOpenChatClosure(
    chatSettingsSchema.parse({
      nightModeBotMessageEnabled: true,
      nightModeOpenMessageEnabled: false,
    }),
    new Date('2026-10-30T12:00:00.000Z'),
  );
  assert.equal(preview.notices?.close.enabledNow, true);
  assert.equal(preview.notices?.open.enabledNow, false);
  assert.equal(preview.notices?.close.latest, null);
  assert.equal(preview.notices?.open.latest, null);
});
