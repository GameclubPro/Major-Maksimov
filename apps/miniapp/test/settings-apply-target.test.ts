import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applySectionTargetPreviewResponseSchema,
  applySectionToAllResponseSchema,
} from '@maxim/contracts/settings';
import {
  createDefaultApplySettingsTarget,
  formatApplyTargetSaveLabel,
  formatApplyTargetCountLabel,
  isApplySettingsTargetPreviewCurrent,
} from '../src/pages/settings/settings-apply-target';
import { resolveSettingsSaveFavoriteType } from '../src/pages/settings/settings-save-folder';

const applyTargetSheetSource = readFileSync(
  new URL('../src/pages/settings/settings-apply-target-sheet.tsx', import.meta.url),
  'utf8',
);

test('settings apply target defaults to current chat', () => {
  assert.deepEqual(createDefaultApplySettingsTarget(), {
    mode: 'current',
    favoriteTypes: [],
    chatIds: [],
  });
});

test('apply section response fallback defaults to current target mode', () => {
  const parsed = applySectionToAllResponseSchema.parse({
    section: 'links',
    sourceChatId: 'chat-1',
    updatedChats: 1,
    appliedChatIds: ['chat-1'],
  });

  assert.equal(parsed.targetMode, 'current');
});

test('apply target confirmation rejects a preview for a different target mode', () => {
  const currentTarget = createDefaultApplySettingsTarget();
  const currentPreview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'current',
    updatedChats: 1,
    appliedChatIds: ['chat-1'],
  });

  assert.equal(isApplySettingsTargetPreviewCurrent(currentTarget, null), false);
  assert.equal(isApplySettingsTargetPreviewCurrent(currentTarget, currentPreview), true);
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...currentTarget, mode: 'all' }, currentPreview),
    false,
  );
  assert.match(applyTargetSheetSource, /const canConfirm =\s*previewMatchesTarget &&/u);
});

test('apply target confirmation compares the complete favorite selection without order dependence', () => {
  const target = {
    ...createDefaultApplySettingsTarget(),
    mode: 'favoriteTypes' as const,
    favoriteTypes: ['watch', 'important'] as const,
  };
  const preview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'favoriteTypes',
    favoriteTypes: ['important', 'watch'],
    updatedChats: 3,
    appliedChatIds: ['chat-1', 'chat-2', 'chat-3'],
  });

  assert.equal(
    isApplySettingsTargetPreviewCurrent(
      { ...target, favoriteTypes: [...target.favoriteTypes] },
      preview,
    ),
    true,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, favoriteTypes: ['important'] }, preview),
    false,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent(
      { ...target, favoriteTypes: ['important', 'partner'] },
      preview,
    ),
    false,
  );
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, favoriteTypes: [] }, preview),
    false,
  );
});

test('selected chat previews cannot confirm another chat selection', () => {
  const target = {
    ...createDefaultApplySettingsTarget(),
    mode: 'selectedChats' as const,
    chatIds: ['chat-2', 'chat-1'],
  };
  const preview = applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: 'chat-1',
    targetMode: 'selectedChats',
    updatedChats: 2,
    appliedChatIds: ['chat-1', 'chat-2'],
  });

  assert.equal(isApplySettingsTargetPreviewCurrent(target, preview), true);
  assert.equal(
    isApplySettingsTargetPreviewCurrent({ ...target, chatIds: ['chat-3', 'chat-1'] }, preview),
    false,
  );
});

test('direct confirmation names recipients without another scope selector', () => {
  assert.match(applyTargetSheetSource, /sampleChats\.slice\(0, 4\)/u);
  assert.match(applyTargetSheetSource, /aria-label="Выбранные чаты"/u);
  assert.match(applyTargetSheetSource, /<span>\{chat\.title\}<\/span>/u);
  assert.doesNotMatch(applyTargetSheetSource, /onTargetChange|aria-pressed|Область применения/u);
  assert.match(applyTargetSheetSource, /Настройки «\{sectionLabel\}» будут заменены/u);
  assert.match(
    applyTargetSheetSource,
    /onClick=\{\(\) => \{\s*if \(canConfirm\) \{\s*onConfirm\(\)/u,
  );
});

test('an in-flight apply consumes native Back and Escape before parent dialogs can close', () => {
  assert.match(
    applyTargetSheetSource,
    /useNativeBackHandler\(\s*\(\) => \{\s*if \(isApplying\) \{\s*return true;/u,
  );
  assert.match(
    applyTargetSheetSource,
    /if \(!panel \|\| !isTopmostModalDialog\(panel\)\) \{\s*return;\s*\}\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*if \(!isApplying\) \{\s*onClose\(\);/u,
  );
  assert.doesNotMatch(applyTargetSheetSource, /event\.key !== 'Escape' \|\| isApplying/u);
});

test('target counts use the correct Russian form including teens', () => {
  for (const [count, expected] of [
    [0, '0 чатов'],
    [1, '1 чат'],
    [2, '2 чата'],
    [5, '5 чатов'],
    [11, '11 чатов'],
    [21, '21 чат'],
    [22, '22 чата'],
    [111, '111 чатов'],
  ] as const) {
    assert.equal(formatApplyTargetCountLabel(count), expected);
  }
});

test('settings target picker shares authenticated labels and invalidates stale membership previews', () => {
  assert.match(applyTargetSheetSource, /useHomeEntityFavorites\(\)/u);
  assert.doesNotMatch(
    applyTargetSheetSource,
    /getMe|hydrateHomeEntityFavoriteLabelMigrationCandidate/u,
  );
  assert.match(applyTargetSheetSource, /previewEpochRef\.current\.epoch === compositionEpoch/u);
  assert.doesNotMatch(
    applyTargetSheetSource,
    /updateManagedEntityFavoriteLabels|mode: 'initialize'/u,
  );
  assert.doesNotMatch(
    applyTargetSheetSource,
    /saveHomeEntityFavoriteLabels|readHomeEntityFavoriteLabels|getHomeEntityFavoritesFallbackScope/u,
  );
  assert.match(applyTargetSheetSource, /favoriteReady &&\s*!favoriteChanged &&\s*supportedTarget/u);
  assert.match(applyTargetSheetSource, /preview\?\.sourceChatId === sheet\.sourceChatId/u);
});

test('folder save uses a matching origin or one confirmed membership, never an arbitrary category', () => {
  const favorites = {
    chat: { important: ['a'], watch: ['b'], broadcast: [], test: [], partner: [], service: [] },
    channel: { important: ['c'], watch: [], broadcast: [], test: [], partner: [], service: [] },
  };
  const route = (entityId: string, filter: string, entityType = 'chat') => ({
    managedEntityWorkspace: {
      version: 1,
      entityId,
      entityType,
      origin: null,
      homeSnapshot: { filter },
      statsPreference: {},
    },
  });
  assert.equal(resolveSettingsSaveFavoriteType('a', null, favorites), 'important');
  assert.equal(resolveSettingsSaveFavoriteType('c', null, favorites), null);
  assert.equal(
    resolveSettingsSaveFavoriteType('a', route('a', 'important'), favorites),
    'important',
  );
  assert.equal(resolveSettingsSaveFavoriteType('a', route('a', 'watch'), favorites), null);
  assert.equal(resolveSettingsSaveFavoriteType('a', route('b', 'watch'), favorites), 'important');
  assert.equal(
    resolveSettingsSaveFavoriteType('a', route('a', 'watch', 'channel'), favorites),
    'important',
  );
  const ambiguous = { ...favorites, chat: { ...favorites.chat, watch: ['a'] } };
  assert.equal(resolveSettingsSaveFavoriteType('a', null, ambiguous), null);
  assert.equal(resolveSettingsSaveFavoriteType('a', route('a', 'watch'), ambiguous), 'watch');
});

test('save labels use the correct prepositional form', () => {
  for (const [count, expected] of [
    [1, 'Сохранить в 1 чате'],
    [2, 'Сохранить в 2 чатах'],
    [11, 'Сохранить в 11 чатах'],
    [21, 'Сохранить в 21 чате'],
    [111, 'Сохранить в 111 чатах'],
  ] as const)
    assert.equal(formatApplyTargetSaveLabel(count), expected);
});
