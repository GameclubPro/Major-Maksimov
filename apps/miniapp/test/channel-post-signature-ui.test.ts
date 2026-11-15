import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getNetworkSettingsSectionPresentation } from '../src/pages/settings/settings-workspace-sections';

const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);
const postSignatureFieldsSource = readFileSync(
  new URL('../src/pages/settings/channel-post-signature-fields.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);

test('channel post action stays compact on the overview and opens in a drilldown', () => {
  const presentation = getNetworkSettingsSectionPresentation('channel', 'postSignature');
  assert.equal(presentation.title, 'Действие под публикацией');
  assert.equal(presentation.panelClassName, 'settings-drilldown__panel--signature');
  assert.match(
    channelSettingsSource,
    /postSignature: getNetworkSettingsSectionPresentation\('channel', 'postSignature'\)/u,
  );
  assert.match(
    channelSettingsSource,
    /<SettingsSectionToggle[\s\S]*?title=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.title\}[\s\S]*?controls="channel-settings-post-signature"/u,
  );
  assert.match(
    channelSettingsSource,
    /<SettingsDrilldownPanel[\s\S]*?id="channel-settings-post-signature"[\s\S]*?title=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.title\}[\s\S]*?className=\{SHARED_CHANNEL_SECTION_PRESENTATIONS\.postSignature\.panelClassName\}/u,
  );
  assert.doesNotMatch(
    channelSettingsSource,
    /postSignature\.enabled \? \(\s*<div className="channel-post-signature__body"/u,
  );
});

test('post actions use explicit save and protect the unfinished button editor on close', () => {
  assert.match(channelSettingsSource, /customButtonEditorOpen[\s\S]*?runNativeBackHandlers\(\)/u);
  assert.match(channelSettingsSource, /onClick=\{\(\) => savePostSignature\(postSignature\)\}/u);
  assert.match(postSignatureFieldsSource, /ChannelCustomButtonsFields/u);
  assert.match(postSignatureFieldsSource, /channel-post-actions__preview-button/u);
  assert.match(postSignatureFieldsSource, /fields\.read\('customButtons'\)/u);
  assert.match(postSignatureFieldsSource, /value: 'signature'[\s\S]*?value: 'button'/u);
});

test('settings search includes post action terminology', () => {
  assert.match(
    settingsSectionToggleSource,
    /'Действие под публикацией': 'подпись кнопка ссылка адрес реклама посты публикации канал'/u,
  );
});
