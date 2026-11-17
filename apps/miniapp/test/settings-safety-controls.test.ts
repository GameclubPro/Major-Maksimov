import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsSectionSaveFooter } from '../src/pages/settings/settings-section-save-footer';

const stopWordsSource = readFileSync(
  new URL('../src/pages/settings/shared-stop-words-settings-fields.tsx', import.meta.url),
  'utf8',
);
const stopWordsSectionSource = readFileSync(
  new URL('../src/pages/settings/settings-stop-words-section.tsx', import.meta.url),
  'utf8',
);
const commandSource = readFileSync(
  new URL('../src/pages/settings/shared-settings-command-fields.tsx', import.meta.url),
  'utf8',
);
const stopWordsToolsSource = readFileSync(
  new URL('../src/pages/settings/settings-stop-words-single-tools.tsx', import.meta.url),
  'utf8',
);
const sharedFieldsSource = readFileSync(
  new URL('../src/pages/settings/shared-chat-settings-fields.tsx', import.meta.url),
  'utf8',
);
const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const commandConfigSource = readFileSync(
  new URL('../src/pages/settings/settings-admin-command-config.ts', import.meta.url),
  'utf8',
);
const hintSource = readFileSync(
  new URL('../src/pages/settings/settings-hint-anchor.tsx', import.meta.url),
  'utf8',
);
const duplicatePhotoSource = readFileSync(
  new URL('../src/pages/settings/settings-duplicate-photo-controls.tsx', import.meta.url),
  'utf8',
);

function renderFooter(overrides: Partial<Parameters<typeof SettingsSectionSaveFooter>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SettingsSectionSaveFooter, {
      section: 'links',
      hasChanges: true,
      isSavingSettings: false,
      savingSection: null,
      isApplyingSectionToAll: false,
      applyingSection: null,
      onSaveSection: () => undefined,
      ...overrides,
    }),
  );
}

test('a section cannot start saving while another section is still being saved or applied', () => {
  assert.doesNotMatch(renderFooter(), /disabled=""/u);
  assert.match(renderFooter({ isSavingSettings: true, savingSection: 'night' }), /disabled=""/u);
  assert.match(
    renderFooter({ isApplyingSectionToAll: true, applyingSection: 'stopWords' }),
    /disabled=""/u,
  );
});

test('the active save action announces that it is busy', () => {
  const html = renderFooter({ isApplyingSectionToAll: true, applyingSection: 'links' });
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /Сохраняем/u);
});

test('a review-blocked stop-word action stays disabled without claiming a pending save', () => {
  const html = renderFooter({ section: 'stopWords', savingSection: 'stopWords', disabled: true });
  assert.match(html, /disabled=""/u);
  assert.match(html, /Сохранить в этом чате/u);
  assert.doesNotMatch(html, /aria-busy|Сохраняем/u);
});

test('stop-word catalog mounts the recoverable editor only when its panel is open', () => {
  assert.match(stopWordsSectionSource, /<SettingsSectionToggle/u);
  assert.match(stopWordsSectionSource, /<SettingsDrilldownPanel/u);
  assert.match(stopWordsSectionSource, /\{expanded \? props\.sharedContent : null\}/u);
  assert.match(settingsPageSource, /sharedContent=\{renderSharedChatSection\('stopWords'\)\}/u);
  assert.match(
    sharedFieldsSource,
    /const LazySharedStopWordsSettingsFields = recoverableLazyNamedComponent<BodyProps>/u,
  );
  assert.match(sharedFieldsSource, /\(\) => import\('\.\/shared-stop-words-settings-fields'\)/u);
  assert.match(
    sharedFieldsSource,
    /<Suspense fallback=\{<Spinner label="Загружаем стоп-слова" \/>\}>\s*<LazySharedStopWordsSettingsFields \{\.\.\.props\} \/>/u,
  );
  assert.doesNotMatch(
    stopWordsSectionSource,
    /<input|LazyMessageLimitsBlockedWordPresets|useHintPopoverAutoPosition/u,
  );
  assert.match(stopWordsSource, /import type \{ SharedChatSettingsSectionProps \}/u);
  assert.doesNotMatch(stopWordsSource, /GlassCard/u);
  assert.match(stopWordsSource, /import.*prepareStopWordsLists/u);
  assert.match(stopWordsSource, /context\.stopWordsTools\?\.preview/u);
  assert.match(stopWordsToolsSource, /previewStopWords/u);
});

test('stop-list keyboard submission preserves composition and multiline entry', () => {
  assert.match(stopWordsSource, /!event\.nativeEvent\.isComposing/u);
  assert.match(stopWordsSource, /!event\.shiftKey/u);
  assert.match(stopWordsSource, /prepared\.errors\.length/u);
  assert.match(stopWordsSource, /const resultId = useId\(\)/u);
  assert.match(stopWordsSource, /aria-describedby=\{resultId\}/u);
  assert.match(
    stopWordsSource,
    /<div id=\{resultId\} className="stop-words-editor__input-result"/u,
  );
});

test('stop-list controls own their sanctions and expose image runtime status', () => {
  for (const field of ['botMessageEnabled', 'warnEnabled', 'muteEnabled', 'banEnabled']) {
    assert.ok(stopWordsSource.includes(`'stopWordsPolicy.sanctions.${field}'`));
  }
  assert.match(stopWordsSource, /context\.stopWordsTools\?\.imageScan/u);
  assert.match(stopWordsToolsSource, /imageScanStatus/u);
  assert.match(stopWordsToolsSource, /'shadow'/u);
  assert.doesNotMatch(stopWordsSource, /действия берутся из раздела «Ограничения»/u);
});

test('command fields preserve case and expose limits, errors, and individual explanations', () => {
  assert.match(commandSource, /maxLength=\{ADMIN_COMMAND_NAME_MAX_LENGTH\}/u);
  assert.match(commandSource, /autoCapitalize="none"/u);
  assert.match(commandSource, /autoCorrect="off"/u);
  assert.match(commandSource, /aria-invalid=\{Boolean\(error\)\}/u);
  assert.match(
    commandSource,
    /import \{ commandCategories[^}]*\} from '\.\/settings-admin-command-config'/u,
  );
  assert.equal(commandConfigSource.match(/hintKey: 'admin/gu)?.length, 7);
  assert.match(commandSource, /hintKey=\{item\.hintKey\}/u);
});

test('settings help is labelled and describes its trigger only while visible', () => {
  assert.match(hintSource, /data-hint-key=\{hintKey\}/u);
  assert.match(hintSource, /title=\{label\}/u);
  assert.match(
    hintSource,
    /aria-describedby=\{isOpen \? `settings-hint-\$\{hintKey\}` : undefined\}/u,
  );
  assert.match(hintSource, /role="note"\s*aria-label=\{label\}/u);
});

test('lazy settings help does not import the full settings helper module at runtime', () => {
  for (const source of [commandSource]) {
    assert.match(source, /import \{ SettingsHintAnchor \} from '\.\/settings-hint-anchor'/u);
    assert.match(source, /import type \{[^}]*HintKey[^}]*\} from '\.\/settings-page-helpers'/u);
  }
  assert.doesNotMatch(duplicatePhotoSource, /settings-page-helpers/u);
  assert.doesNotMatch(hintSource, /@maxim\/contracts|settings-page-helpers/u);
});

test('unchanged settings retain explicit bulk actions while current save is disabled', () => {
  const html = renderFooter({
    hasChanges: false,
    onSaveAll: () => undefined,
    folder: { type: 'important', label: 'Рабочие', onSave: () => undefined },
  });
  assert.match(html, /settings-save-actions__current[^>]*disabled/u);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
  assert.match(html, /Сохранить в папке «Рабочие»/u);
  assert.doesNotMatch(html, /Ещё чаты|Другие чаты|<select|aria-haspopup="menu"/u);
});

test('a version conflict blocks bulk copying while preserving the comparison action', () => {
  const html = renderFooter({
    hasChanges: true,
    onSaveAll: () => undefined,
    folder: { type: 'important', label: 'Рабочие', onSave: () => undefined },
    conflict: { viewingSaved: false, onToggle: () => undefined },
  });
  assert.match(html, /Сравнить с сохранённым/u);
  assert.match(html, /Сохранить мой вариант/u);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});
