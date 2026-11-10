import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const rulesControllerSource = readFileSync(
  new URL('../src/pages/settings/use-settings-rules.ts', import.meta.url),
  'utf8',
);
const publisherModulesSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);
const settingsOverviewFilterSource = readFileSync(
  new URL('../src/lib/settings-overview-filter.ts', import.meta.url),
  'utf8',
);
const managedGiveawaySource = readFileSync(
  new URL('../src/components/managed-giveaway-card.tsx', import.meta.url),
  'utf8',
);
const settingsDrilldownSource = readFileSync(
  new URL('../src/components/ui/settings-drilldown-panel.tsx', import.meta.url),
  'utf8',
);
const speechStyleSource = readFileSync(
  new URL('../src/pages/settings/settings-speech-style-panel.tsx', import.meta.url),
  'utf8',
);
const sharedSpeechStyleFieldsSource = readFileSync(
  new URL('../src/pages/settings/shared-speech-style-fields.tsx', import.meta.url),
  'utf8',
);
const settingsNightSectionSource = readFileSync(
  new URL('../src/pages/settings/settings-night-section.tsx', import.meta.url),
  'utf8',
);
const sharedStopWordsFieldsSource = readFileSync(
  new URL('../src/pages/settings/shared-stop-words-settings-fields.tsx', import.meta.url),
  'utf8',
);
const nightModeTimeFieldsSource = readFileSync(
  new URL('../src/pages/settings/night-mode-time-fields.tsx', import.meta.url),
  'utf8',
);
const broadcastAutopostPolishSource = readFileSync(
  new URL('../src/styles/broadcast-autopost-polish.css', import.meta.url),
  'utf8',
);

test('chat comment settings belong to Publik instead of Major settings', () => {
  assert.doesNotMatch(settingsPageSource, /handleSaveComments|mutateCommentsAsync/u);
  assert.match(publisherModulesSource, /<PublisherCommentsModule/u);
  assert.match(publisherModulesSource, /updatePublisherModules/u);
});

test('overview entries keep desktop context and a separate title-only smartphone presentation', () => {
  const renderSource = settingsSectionToggleSource.slice(
    settingsSectionToggleSource.indexOf('export function SettingsSectionToggle'),
  );

  assert.match(renderSource, /const trimmedSummary = summary\?\.trim\(\) \?\? '';/u);
  assert.match(renderSource, /const trimmedStatus = status\?\.trim\(\) \?\? '';/u);
  assert.match(renderSource, /aria-label=\{title\}/u);
  assert.match(
    renderSource,
    /aria-describedby=\{navigationOnly \? undefined : descriptionIds \|\| undefined\}/u,
  );
  assert.match(renderSource, /data-settings-search=\{searchText\}/u);
  assert.match(renderSource, /settings-section__icon-badge/u);
  assert.match(renderSource, /settings-section__title">\{title\}<\/span>/u);
  assert.match(
    renderSource,
    /id=\{summaryId\} className="settings-section__summary">[\s\S]*?\{trimmedSummary\}/u,
  );
  assert.match(renderSource, /settings-section__status-chip/u);
  assert.match(renderSource, /useSmartphoneLayout\(\)/u);
  assert.match(renderSource, /const navigationOnly = useSmartphoneLayout\(\);/u);
  assert.match(
    renderSource,
    /data-settings-navigation-entry=\{navigationOnly \? 'true' : undefined\}/u,
  );
  assert.match(renderSource, /!navigationOnly && trimmedSummary/u);
  assert.match(renderSource, /!navigationOnly && trimmedStatus/u);
  assert.match(renderSource, /!navigationOnly && \(paused \|\| typeof enabled === 'boolean'\)/u);
  assert.match(renderSource, /settings-section__chevron/u);
  assert.match(renderSource, /<AppIcon icon="NavArrowRight"/u);
});

test('settings search retains its metadata index and domain aliases independently of rendered entry copy', () => {
  assert.match(settingsSectionToggleSource, /SETTINGS_SECTION_SEARCH_ALIASES/u);
  assert.match(
    settingsOverviewFilterSource,
    /querySelectorAll<HTMLElement>\('\[data-settings-search\]'\)/u,
  );
  assert.match(settingsOverviewFilterSource, /entry\.textContent/u);
});

test('rules reset uses the in-app confirmation sheet', () => {
  assert.doesNotMatch(settingsPageSource, /window\.confirm\(/u);
  assert.match(settingsPageSource, /id="rules-reset-confirmation"/u);
  assert.match(settingsPageSource, /onConfirm=\{confirmResetPublishedRules\}/u);
});

test('rules publication does not replace a missing new link with the previous post URL', () => {
  assert.match(rulesControllerSource, /const rulesPublication = rulesDraft \?\? serverRules;/u);
  assert.match(
    rulesControllerSource,
    /rulesPublishedUrl = rulesPublication\?\.publishedUrl \?\? null/u,
  );
  assert.doesNotMatch(
    rulesControllerSource,
    /rulesDraft\?\.publishedUrl \?\? serverRules\?\.publishedUrl/u,
  );
});

test('rules autosave keeps draft editors enabled so mobile keyboard focus survives', () => {
  assert.match(
    rulesControllerSource,
    /const isRulesDraftEditingDisabled =\s*isPreparingRulesPublish \|\|\s*isPublishingRules \|\|\s*isResettingPublishedRules \|\|\s*isUpdatingRulesAttachment;/u,
  );
  assert.match(
    rulesControllerSource,
    /const isRulesBusy = isSavingRules \|\| isRulesDraftEditingDisabled \|\| isPreparingRulesImage;/u,
  );

  const rulesComposerSource = settingsPageSource.slice(
    settingsPageSource.indexOf(
      '<LazyBroadcastContentComposer',
      settingsPageSource.indexOf('rules-panel'),
    ),
    settingsPageSource.indexOf('</Suspense>', settingsPageSource.indexOf('rules-panel')),
  );
  assert.match(rulesComposerSource, /disabled=\{isRulesDraftEditingDisabled\}/u);
  assert.match(rulesComposerSource, /onImagePreparationChange=/u);
  assert.match(
    rulesComposerSource,
    /onImagePreparationChange=\{handleRulesImagePreparationChange\}/u,
  );
  assert.match(rulesControllerSource, /rulesImagePreparingRef\.current = preparing/u);
  assert.match(rulesControllerSource, /!targetDraft \|\| rulesImagePreparingRef\.current/u);
  assert.match(rulesComposerSource, /sourceFormat=\{rulesDraft\.textFormat\}/u);
  assert.match(rulesComposerSource, /textFormat: 'markdown'/u);
  assert.doesNotMatch(rulesComposerSource, /disabled=\{isRulesBusy\}/u);

  const rulesButtonsSheetStart = settingsPageSource.indexOf('<LazyBroadcastButtonsSheet');
  const rulesButtonsSheetSource = settingsPageSource.slice(
    rulesButtonsSheetStart,
    settingsPageSource.indexOf('/>', rulesButtonsSheetStart),
  );
  assert.match(rulesButtonsSheetSource, /disabled=\{isRulesDraftEditingDisabled\}/u);
});

test('rules expose an explicit save action and commit successful saves to query cache', () => {
  assert.match(rulesControllerSource, /async function handleSaveRulesDraft\(\)/u);
  assert.match(
    rulesControllerSource,
    /queryClient\.setQueryData<ChatSettingsScreenResponse \| undefined>\(\s*\['settings-screen', requestScope\.chatId\],[\s\S]*?mergeSavedRulesIntoSettingsScreen\(current, saved\)/u,
  );
  assert.match(
    settingsPageSource,
    /className="button button--ghost rules-publish-bar__save"[\s\S]*?handleSaveRulesDraft\(\)[\s\S]*?rulesSaveLabel/u,
  );
  assert.match(
    rulesControllerSource,
    /handleSaveRulesDraft\(\)[\s\S]*?runRulesSaveAttempt\([\s\S]*?if \(!isCurrentRulesScope\(\) \|\| !attempt\?\.isCurrent\) \{\s*return;\s*\}[\s\S]*?Черновик правил сохранён/u,
  );
  assert.match(
    rulesControllerSource,
    /handlePublishRules\(\)[\s\S]*?runRulesSaveAttempt\([\s\S]*?if \(!attempt\.isCurrent\)[\s\S]*?Правила изменились[\s\S]*?return;[\s\S]*?publishRulesMutation\.mutate\(\{[\s\S]*?mode: hasPublishedRules && !isRulesResetPending \? rulesPublicationMode : 'new_message'/u,
  );
});

test('rules publication errors keep their actionable detail visible', () => {
  assert.match(rulesControllerSource, /title: 'Не удалось опубликовать правила'/u);
  assert.match(rulesControllerSource, /description: formatApiError\(error\)/u);
  assert.match(
    broadcastAutopostPolishSource,
    /body\.settings-drilldown-open \.toast--danger \.toast__body p \{[\s\S]*?display: block;/u,
  );
  assert.doesNotMatch(
    broadcastAutopostPolishSource.match(
      /body\.settings-drilldown-open \.toast--danger \.toast__body p \{[^}]*\}/u,
    )?.[0] ?? '',
    /line-clamp|overflow: hidden/u,
  );
});

test('giveaway editors can intercept parent panel close requests', () => {
  assert.match(managedGiveawaySource, /export type ManagedGiveawayCardHandle/u);
  assert.match(managedGiveawaySource, /useImperativeHandle\(/u);
  assert.match(managedGiveawaySource, /requestClose: \(\) =>/u);
  assert.match(
    managedGiveawaySource,
    /setPendingConfirmation\(\{ kind: 'discard-editor', origin: 'back', closePanel: true \}\)/u,
  );
  assert.match(managedGiveawaySource, /clearEditor\(\);[\s\S]*?onClosePanel\(\);/u);
  assert.match(
    managedGiveawaySource,
    /enabled: isEditingOpen && pendingConfirmation === null, priority: 640/u,
  );
});

test('manual night close wins over the disabled schedule status', () => {
  assert.match(
    settingsPageSource,
    /const nightCardStatus = nightForceCloseSummary\s*\? 'Закрыто'\s*: draft\?\.nightModeEnabled/u,
  );
});

test('night schedule validation is shown next to the time controls', () => {
  assert.match(
    settingsPageSource,
    /const parsed = updateSettingsRequestSchema\.safeParse\(normalizedValue\);/u,
  );
  assert.match(
    settingsPageSource,
    /const nightTimeError =\s*fieldErrors\.nightModeEndTimeMinutes \?\? fieldErrors\.nightModeStartTimeMinutes;/u,
  );
  assert.match(settingsNightSectionSource, /error=\{nightTimeError\}/u);
  assert.match(nightModeTimeFieldsSource, /label="Открывать в"[\s\S]*?error=\{error\}/u);
});

test('stop-word image scanning is an explicit persisted switch', () => {
  assert.match(
    sharedStopWordsFieldsSource,
    /toggle\('stopWordsPolicy\.imageScanEnabled', 'Проверять изображения'\)/u,
  );
  assert.match(
    readFileSync(new URL('../src/pages/settings/use-settings-draft.ts', import.meta.url), 'utf8'),
    /await saveStopWordsSettings\(api,/u,
  );
});

test('speech style opens on the selected radio and supports arrow navigation', () => {
  assert.match(settingsDrilldownSource, /initialFocusRef \?\? panelRef/u);
  assert.match(speechStyleSource, /initialFocusRef=\{selectedOptionRef\}/u);
  assert.match(
    speechStyleSource,
    /<SharedSpeechStyleFields[\s\S]*?selectedStyle=\{selectedStyle\}[\s\S]*?onSelect=\{onSelect\}[\s\S]*?initialFocusRef=\{selectedOptionRef\}/u,
  );
  assert.match(
    sharedSpeechStyleFieldsSource,
    /const selectedOptionRef = initialFocusRef \?\? ownSelectedOptionRef/u,
  );
  assert.match(sharedSpeechStyleFieldsSource, /role="radiogroup" aria-label="Стиль речи бота"/u);
  assert.match(sharedSpeechStyleFieldsSource, /role="radio"/u);
  assert.match(sharedSpeechStyleFieldsSource, /aria-checked=\{selectedStyle === option\.value\}/u);
  assert.match(
    sharedSpeechStyleFieldsSource,
    /if \(selectedStyle === option\.value\) \{\s*selectedOptionRef\.current = node;/u,
  );
  assert.match(
    sharedSpeechStyleFieldsSource,
    /tabIndex=\{selectedStyle === option\.value \|\| \(!selectedStyle && index === 0\) \? 0 : -1\}/u,
  );
  assert.match(
    sharedSpeechStyleFieldsSource,
    /onKeyDown=\{\(event\) => \{[\s\S]*?resolveRadioGroupNavigationIndex\(\s*index,\s*BOT_SPEECH_STYLE_OPTIONS\.length,\s*event\.key,\s*\)[\s\S]*?if \(nextIndex === null\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?onSelect\(nextOption\.value\)[\s\S]*?optionRefs\.current\[nextIndex\]\?\.focus\(\)/u,
  );
});
