import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DUPLICATE_PHOTO_SCOPE_OPTIONS,
  formatDuplicatePhotoScopeSummary,
} from '../src/pages/settings/settings-duplicate-photo-options';
import {
  formatDuplicateActionSummary,
  formatDuplicatePhotoModerationHint,
  resolveDuplicatePhotoPresentationPolicy,
  resolveDuplicatePhotoPolicyForDraft,
} from '../src/pages/settings/settings-duplicate-photo-status';
import { buildChatSettingsScreen } from '../src/lib/api/preview-transport-settings';
import { createPreviewState } from '../src/lib/api/preview-transport-state';
import { settingsSectionPaths } from '../src/features/network-settings/field-registry';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: SettingsDuplicatePhotoControls } =
  await import('../src/pages/settings/settings-duplicate-photo-controls');
cssHook.deregister();

const source = (name: string) =>
  readFileSync(new URL(`../src/pages/${name}`, import.meta.url), 'utf8');
const section = source('settings/shared-duplicate-settings-fields.tsx');
const photo = source('settings/settings-duplicate-photo-controls.tsx');
const state = source('settings-page-state.ts');
const full = {
  moderationMode: 'FULL' as const,
  actionCeiling: 'BAN' as const,
  allowedMatchKinds: ['canonical_sha256' as const],
};

test('image comparison offers only the administrator-selected author scope', () => {
  assert.deepEqual(
    DUPLICATE_PHOTO_SCOPE_OPTIONS.map((option) => option.value),
    ['SAME_AUTHOR', 'CHAT'],
  );
  assert.match(section, /scope=\{value\(fields\.read\('duplicatePhotoScope'\)\)\}/u);
  assert.match(
    section,
    /onScopeChange=\{\(next\) => fields\.setScalar\('duplicatePhotoScope', next\)\}/u,
  );
  assert.doesNotMatch(photo, /onEnabledChange|matchPreset|MINOR_EDITS|pdq|onMatchPresetChange/u);
  assert.doesNotMatch(state, /'duplicatePhotoEnabled'|'duplicatePhotoMatchPreset'/u);
  assert.doesNotMatch(section, /duplicatePhotoEnabled|duplicatePhotoMatchPreset/u);
});

test('unified duplicate settings have no text/image choice or hidden comparison field', () => {
  assert.match(section, /const master = fields\.read\('antiDuplicateEnabled'\)/u);
  assert.doesNotMatch(section, /duplicateCompareMode|SettingsDuplicateMessageControls/u);
  assert.doesNotMatch(state, /'duplicateCompareMode'/u);
  assert.equal(settingsSectionPaths('chat', 'duplicates').includes('duplicateCompareMode'), false);
});

test('image scope keeps useful choices and availability without implementation details', () => {
  const render = (moderationMode: 'FULL' | 'OFF') =>
    renderToStaticMarkup(
      createElement(SettingsDuplicatePhotoControls, {
        scope: 'CHAT',
        moderationPolicy: { ...full, moderationMode },
        onScopeChange() {},
      }),
    );
  const available = render('FULL');
  assert.match(available, /Чьи картинки сравнивать/u);
  assert.match(available, /Всех участников/u);
  assert.doesNotMatch(available, /Подпись|Не учитывается|Как для текста|недоступна/u);
  assert.match(render('OFF'), /Проверка картинок сейчас недоступна/u);
});

test('exact images share full reactions and never promote a perceptual-only response', () => {
  assert.deepEqual(resolveDuplicatePhotoPresentationPolicy(full), full);
  assert.equal(
    resolveDuplicatePhotoPresentationPolicy({ ...full, allowedMatchKinds: ['pdq'] }).moderationMode,
    'OFF',
  );
  assert.equal(
    resolveDuplicatePhotoPresentationPolicy({ ...full, moderationMode: 'OBSERVE' }).moderationMode,
    'OFF',
  );
  assert.deepEqual(
    resolveDuplicatePhotoPolicyForDraft({ base: full, advanced: full }, 'OFF'),
    full,
  );
});

test('the action summary retains warnings, mute and ban for shared image moderation', () => {
  const summary = formatDuplicateActionSummary(
    {
      duplicatePhotoScope: 'CHAT',
      duplicateBotMessageEnabled: true,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteDurationHours: 12,
    },
    1,
    full,
  );
  assert.match(summary, /№3/u);
  assert.match(summary, /12/u);
  assert.match(summary, /Поиск повторов картинок: среди всех участников/u);
  assert.doesNotMatch(summary, /дополнительн.*санкц|Без предупреждений и блокировок/u);
});

test('image status describes the selected scope without implementation details', () => {
  assert.match(formatDuplicatePhotoModerationHint(full, 'CHAT'), /среди всех участников/u);
  assert.match(formatDuplicatePhotoModerationHint(full, 'SAME_AUTHOR'), /у одного участника/u);
  for (const scope of ['CHAT', 'SAME_AUTHOR'] as const) {
    assert.doesNotMatch(formatDuplicatePhotoModerationHint(full, scope), /Подписи|цепочк|санкц/u);
  }
});

test('mixed image scope never implies one comparison scope for the network', () => {
  assert.equal(formatDuplicatePhotoScopeSummary(null), 'Разные значения');
});

test('the preview uses the same exact full policy for both author scopes', () => {
  const preview = buildChatSettingsScreen(createPreviewState({}), '-123');
  assert.deepEqual(preview.duplicatePhotoPolicyMatrix, { base: full, advanced: full });
});

test('disabling the master switch does not rewrite the configured reaction ladder', () => {
  const start = section.indexOf('title="Включить антидубль"');
  const end = section.indexOf('>Совпадения</h3>');
  const master = section.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(master, /state=\{master\}/u);
  assert.match(
    master,
    /onChange=\{\(enabled\) => fields\.setScalar\('antiDuplicateEnabled', enabled\)\}/u,
  );
  assert.doesNotMatch(master, /applyDuplicateFlowConfig|setChatBoolean|fields\.transact/u);
  assert.match(
    section,
    /buildDuplicateTextActionPreview\(\s*\{ \.\.\.flow, duplicateMuteDurationHours: duration \},\s*allowedCount,/u,
  );
  assert.match(
    section,
    /previewRows\.map\(\(row\) => \([\s\S]*<dt>\{row\.label\}<\/dt>\s*<dd>\{row\.action\}<\/dd>/u,
  );
});
