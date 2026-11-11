import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const cssHook = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const {
  MESSAGE_COUNT_LIMIT_MAX,
  MESSAGE_COUNT_LIMIT_MIN,
  MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS,
  MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS,
  MESSAGE_LENGTH_MAX,
  MESSAGE_LENGTH_MIN,
  MESSAGE_LENGTH_STEP,
  MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP,
  MESSAGE_LIMITS_BOT_BUTTON_GROUP,
  MaxMessageLengthSlider,
  PHOTO_COOLDOWN_MAX_HOURS,
  PHOTO_COOLDOWN_MIN_HOURS,
  STICKER_COOLDOWN_MAX_MINUTES,
  STICKER_COOLDOWN_MIN_MINUTES,
} = await import('../src/pages/settings/settings-limits-controls');
cssHook.deregister();

function readSettingsSource(name: string) {
  return readFileSync(new URL(`../src/pages/settings/${name}.tsx`, import.meta.url), 'utf8');
}

const sectionSource = readSettingsSource('settings-limits-section');
const editorSource = readSettingsSource('settings-limits-editor');
const controlsSource = readSettingsSource('settings-limits-controls');

test('limits catalog keeps its overview and save shell eager while loading only an open editor', () => {
  assert.match(sectionSource, /<SettingsSectionToggle/u);
  assert.match(sectionSource, /title=\{SECTION_PRESENTATION\.title\}/u);
  assert.match(sectionSource, /footer=\{renderSectionSaveFooter\('limits'\)\}/u);
  assert.match(sectionSource, /confirmCloseWhen=\{isSectionDirty\('limits'\)\}/u);
  assert.match(sectionSource, /recoverableLazyNamedComponent<SettingsLimitsSectionProps>/u);
  assert.match(sectionSource, /\(\) => import\('\.\/settings-limits-editor'\)/u);
  assert.match(
    sectionSource,
    /\{expanded \? \(\s*<Suspense fallback=\{<Spinner[^>]+\/>\}>\s*<LazySettingsLimitsEditor \{\.\.\.props\} \/>/u,
  );
  assert.doesNotMatch(sectionSource, /<input|BroadcastLinkButtonsEditor|MaxMessageLengthSlider/u);
});

test('lazy limits modules never load the full settings helper module at runtime', () => {
  for (const source of [sectionSource, editorSource, controlsSource]) {
    const parsed = ts.createSourceFile(
      'settings.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const node of parsed.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './settings-page-helpers'
      ) {
        assert.equal(node.importClause?.isTypeOnly, true);
      }
    }
  }
  assert.match(
    editorSource,
    /import \{ EditToggleButton \} from '\.\/settings-edit-toggle-button'/u,
  );
  assert.match(
    editorSource,
    /\(\) => import\('\.\.\/\.\.\/components\/bot-speech-message-editor'\)/u,
  );
  assert.match(editorSource, /<Suspense fallback=\{null\}>\s*<LazyBotMessageEditor/u);
});

test('limits editor preserves the task order and its original controls', () => {
  const sections = ['Защита от спама', 'Лимиты активности', 'Разрешённые типы', 'Действия бота'];
  const positions = sections.map((title) => editorSource.indexOf(`<span>${title}</span>`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );
  for (const field of [
    'antiSpamEnabled',
    'deleteSpammersEnabled',
    'photoMessagesEnabled',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'forwardedMessagesEnabled',
    'phoneNumbersEnabled',
  ]) {
    assert.ok(editorSource.includes(`checked={draft.${field}}`), field);
  }
  assert.match(editorSource, /<BroadcastLinkButtonsEditor/u);
  assert.match(editorSource, /renderAdminContactToggle\(/u);
  assert.match(editorSource, /renderMuteStageToggle\(/u);
});

test('focused limits constants retain the same bounds and message field ownership', () => {
  assert.deepEqual([MESSAGE_COUNT_LIMIT_MIN, MESSAGE_COUNT_LIMIT_MAX], [1, 10]);
  assert.deepEqual(
    [MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS, MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS],
    [1, 24],
  );
  assert.deepEqual([MESSAGE_LENGTH_MIN, MESSAGE_LENGTH_MAX, MESSAGE_LENGTH_STEP], [50, 1500, 10]);
  assert.deepEqual([PHOTO_COOLDOWN_MIN_HOURS, PHOTO_COOLDOWN_MAX_HOURS], [1, 24]);
  assert.deepEqual([STICKER_COOLDOWN_MIN_MINUTES, STICKER_COOLDOWN_MAX_MINUTES], [1, 60]);
  assert.deepEqual(MESSAGE_LIMITS_BOT_BUTTON_GROUP, {
    buttonsKey: 'messageLimitsBotButtons',
    enabledKey: 'messageLimitsBotButtonEnabled',
    urlKey: 'messageLimitsBotButtonUrl',
    textKey: 'messageLimitsBotButtonText',
  });
  assert.deepEqual(MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP, {
    enabledKey: 'messageLimitsAdminContactButtonEnabled',
    urlKey: 'messageLimitsAdminContactButtonUrl',
  });
});

test('extracted length slider renders its accessible value and configured bounds', () => {
  const html = renderToStaticMarkup(
    createElement(MaxMessageLengthSlider, {
      value: 120,
      min: MESSAGE_LENGTH_MIN,
      max: MESSAGE_LENGTH_MAX,
      step: MESSAGE_LENGTH_STEP,
      onCommit: () => undefined,
      onError: () => undefined,
    }),
  );
  assert.match(html, /aria-label="Лимит длины сообщения"/u);
  assert.match(html, /min="50"/u);
  assert.match(html, /max="1500"/u);
  assert.match(html, /step="10"/u);
  assert.match(html, /value="120"/u);
  assert.match(html, /aria-label="Лимит длины сообщения, символы"/u);
  assert.match(html, /type="number"/u);
  assert.match(html, /step="1"/u);
  assert.match(html, />симв\.</u);
});
