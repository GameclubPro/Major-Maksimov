import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dialogSource = readFileSync(
  new URL('../src/components/bot-permission-required-dialog.tsx', import.meta.url),
  'utf8',
);
const botPermissionErrorSource = readFileSync(
  new URL('../src/lib/bot-permission-error.ts', import.meta.url),
  'utf8',
);
const chatSettingsSaveErrorSource = readFileSync(
  new URL('../src/lib/chat-settings-save-error.ts', import.meta.url),
  'utf8',
);
const actionSheetSource = readFileSync(
  new URL('../src/components/ui/action-confirm-sheet.tsx', import.meta.url),
  'utf8',
);
const chatSettingsSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const sectionApplySubmitSource = readFileSync(
  new URL('../src/pages/settings/settings-section-apply-submit.ts', import.meta.url),
  'utf8',
);
const chatSettingsWorkspaceSource = readFileSync(
  new URL('../src/pages/settings/chat-settings-workspace.tsx', import.meta.url),
  'utf8',
);
const publisherPolicySource = readFileSync(
  new URL('../src/components/publisher-policy-card.tsx', import.meta.url),
  'utf8',
);
const publisherModulesSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const publisherAutoRepliesSource = readFileSync(
  new URL('../src/pages/publisher-auto-replies-page.tsx', import.meta.url),
  'utf8',
);

test('permission blocker uses an accessible alert dialog and lists missing rights', () => {
  assert.match(dialogSource, /role="alertdialog"/u);
  assert.match(dialogSource, /permissionLabels\.map/u);
  assert.match(dialogSource, /Проверить снова/u);
  assert.match(dialogSource, /blocker\?\.canRecheck === false \? onClose : onRecheck/u);
  assert.match(actionSheetSource, /role=\{role\}/u);
});

test('chat moderation saves roll rejected enables back before showing the dialog', () => {
  assert.match(chatSettingsSource, /handleSettingsPermissionError/u);
  assert.match(chatSettingsSource, /resolveChatSettingsSaveError\(/u);
  assert.match(botPermissionErrorSource, /export function revertRejectedFeatureChanges/u);
  assert.match(chatSettingsSaveErrorSource, /revertRejectedFeatureChanges\(/u);
  assert.match(chatSettingsSource, /recheckBotCapabilities: true/u);
  assert.match(chatSettingsSource, /onSettingsSaveError/u);
  assert.match(chatSettingsWorkspaceSource, /onSettingsSaveError\?\.\(error\)/u);
  assert.match(chatSettingsSource, /<LazyBotPermissionRequiredDialog/u);
});

test('bulk apply keeps an already-saved source while blocking unready targets', () => {
  assert.match(
    chatSettingsSource,
    /if \(variables\.isCurrentScope\?\.\(\) !== false\) \{\s*applyTargetSavedSourceRef\.current = saved;/u,
  );
  assert.match(
    sectionApplySubmitSource,
    /const savedSource = \{\s*sourceChatId,\s*section,\s*settings: savedSourceSettings,\s*\.\.\.\(savedStopWords \? \{ stopWordsReceipt: savedStopWords \} : \{\}\),?\s*\};\s*onSourceSaved\(savedSource\);/u,
  );
  assert.match(
    sectionApplySubmitSource,
    /onSourceSaved\(savedSource\);\s*if \(isCurrentScope\?\.\(\) === false\) throw[\s\S]*?const result = await applySettingsSectionToAll\(/u,
  );
  assert.match(
    chatSettingsSource,
    /const sourceSaved =\s*savedSource\?\.section === variables\.section &&\s*savedSource\?\.sourceChatId === variables\.sourceChatId/u,
  );
  assert.match(
    chatSettingsSource,
    /if \(sourceSaved && savedSource\) \{\s*if \(savedSource\.stopWordsReceipt\) \{\s*await syncSavedStopWords\(\s*savedSource\.stopWordsReceipt,\s*variables\.sourceSettings,\s*variables\.sourceSettings,\s*variables\.sourceChatId,?\s*\);\s*if \(variables\.isCurrentScope\?\.\(\) === false\) return;/u,
  );
  assert.match(
    chatSettingsSource,
    /syncSavedSectionSettings\(\s*savedSource\.section,\s*(?:savedSource\.settings|\{[\s\S]*?savedSource\.settings)/u,
  );
  assert.match(chatSettingsSource, /setPermissionBlocker\(resolution\.blocker\)/u);
  assert.match(chatSettingsSaveErrorSource, /getChatSettingsConcurrentUpdatePresentation/u);
  assert.match(chatSettingsSource, /description: resolution\.description/u);
});

test('Publisher enable switches surface structured blockers without optimistic enabling', () => {
  assert.match(publisherPolicySource, /const blocker = parseBotPermissionBlocker\(error\)/u);
  assert.match(publisherPolicySource, /checked=\{policy\?\.publikEnabled \?\? false\}/u);
  assert.match(publisherPolicySource, /<LazyBotPermissionRequiredDialog/u);
  assert.match(publisherPolicySource, /retryPublisherPolicyEnablement/u);
  assert.match(publisherPolicySource, /retryPublisherPolicyEnablement\(\{/u);
  assert.match(publisherPolicySource, /recheckMutation\.mutate\(\)/u);
  assert.doesNotMatch(
    publisherPolicySource,
    /onRecheck=\{\(\) => \{\s*setPermissionBlocker\(null\)/u,
  );
  assert.match(publisherModulesSource, /const blocker = parseBotPermissionBlocker\(error\)/u);
  assert.match(publisherModulesSource, /<LazyBotPermissionRequiredDialog/u);
});

test('Publisher auto-reply module, rule, and editor enables share the permission dialog', () => {
  assert.match(publisherAutoRepliesSource, /onPermissionBlocker\(permissionBlocker\)/u);
  assert.match(publisherAutoRepliesSource, /refreshPublisherEntity\(api, 'chat', chatId\)/u);
  assert.match(
    publisherAutoRepliesSource,
    /<LazyBotPermissionRequiredDialog[\s\S]*publisher-auto-reply-permission/u,
  );
});
