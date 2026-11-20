import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const eventsPageSource = readFileSync(
  new URL('../src/pages/events-page.tsx', import.meta.url),
  'utf8',
);
const historyControlsSource = readFileSync(
  new URL('../src/components/violation-moderation-controls.tsx', import.meta.url),
  'utf8',
);
const confirmSheetSource = readFileSync(
  new URL('../src/components/ui/action-confirm-sheet.tsx', import.meta.url),
  'utf8',
);
const confirmSheetCss = readFileSync(
  new URL('../src/components/ui/action-confirm-sheet.css', import.meta.url),
  'utf8',
);

test('event confirmations load only when an action opens them', () => {
  assert.match(
    eventsPageSource,
    /import type \{ ActionConfirmSheet as ActionConfirmSheetComponent \}/u,
  );
  assert.match(eventsPageSource, /\(\) => import\('\.\.\/components\/ui\/action-confirm-sheet'\)/u);
  assert.match(
    eventsPageSource,
    /return props\.open \? \(\s*<Suspense fallback=\{null\}>\s*<LazyActionConfirmSheet/u,
  );
});

test('manual moderation shows progress on the selected scope action', () => {
  assert.match(eventsPageSource, /setPendingScopeChoice\(scope\);/u);
  assert.match(
    eventsPageSource,
    /confirmBusy=\{[\s\S]*?pendingScopeChoice === 'current_chat'[\s\S]*?extraActionBusy=\{[\s\S]*?pendingScopeChoice === 'all_chats'/u,
  );
  assert.match(confirmSheetSource, /const isConfirmBusy = confirmBusy \?\? isBusy;/u);
  assert.match(confirmSheetSource, /isConfirmBusy \? confirmBusyLabel : confirmLabel/u);
});

test('disabled confirmation actions have a visible state', () => {
  assert.match(confirmSheetCss, /\.action-confirm-sheet__button:disabled\s*\{[\s\S]*?opacity:/u);
});

test('participant confirmations and mutation results stay bound to their original chat and user', () => {
  assert.match(
    eventsPageSource,
    /setPendingScopeAction\(\{ \.\.\.action, chatId: chatId \?\? '' \}\)/u,
  );
  assert.match(eventsPageSource, /pendingScopeAction\.chatId !== chatId/u);
  assert.match(
    eventsPageSource,
    /open=\{Boolean\(pendingScopeAction && pendingScopeAction\.chatId === chatId\)\}/u,
  );
  assert.match(
    eventsPageSource,
    /applyManualModerationAction\(api, actionChatId, userId, payload\)/u,
  );
  assert.match(
    eventsPageSource,
    /selectedParticipant\?\.chatId === variables\.chatId &&[\s\S]*?selectedParticipant\.userId === variables\.userId/u,
  );
});

test('history actions keep the confirmation visible until the request settles', () => {
  const actionStart = historyControlsSource.indexOf('const applyAction =');
  const actionEnd = historyControlsSource.indexOf('const openScopeAction =', actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  const action = historyControlsSource.slice(actionStart, actionEnd);
  assert.match(action, /if \(applyLock\.current \|\| applyMutation\.isPending\) return;/u);
  assert.match(action, /applyLock\.current = true;/u);
  assert.doesNotMatch(action, /setPendingScopeAction\(null\)/u);
  assert.match(
    historyControlsSource,
    /confirmBusy=\{applyMutation\.isPending && pendingScopeChoice === 'current_chat'\}/u,
  );
  assert.match(
    historyControlsSource,
    /extraActionBusy=\{applyMutation\.isPending && pendingScopeChoice === 'all_chats'\}/u,
  );
});
