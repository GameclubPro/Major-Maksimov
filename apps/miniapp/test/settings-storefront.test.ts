import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH,
  KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH,
  resolveKaravanStorefrontTexts,
  type KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';
import { StorefrontPublicationPreviewContext } from '../src/pages/settings/storefront-publication-preview';
import { SettingsStorefrontTextEditor } from '../src/pages/settings/settings-storefront-text-editor';

const sectionSource = readFileSync(
  new URL('../src/pages/settings/settings-storefront-section.tsx', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const stateSource = readFileSync(
  new URL('../src/pages/settings-page-state.ts', import.meta.url),
  'utf8',
);
const editorSource = readFileSync(
  new URL('../src/pages/settings/settings-storefront-text-editor.tsx', import.meta.url),
  'utf8',
);

const sharedFieldsSource = readFileSync(
  new URL('../src/pages/settings/shared-settings-storefront-fields.tsx', import.meta.url),
  'utf8',
);

test('storefront copy editor shares runtime defaults, text limits, and the section draft', () => {
  for (const draft of [
    {
      karavanStorefrontMessageText: '',
      karavanStorefrontOpenButtonText: '',
      karavanStorefrontCatalogButtonText: '',
      karavanStorefrontCreateButtonText: '',
    },
    {
      karavanStorefrontMessageText: '  Свой текст  ',
      karavanStorefrontOpenButtonText: '  Перейти  ',
      karavanStorefrontCatalogButtonText: '',
      karavanStorefrontCreateButtonText: '',
    },
  ] satisfies KaravanStorefrontTexts[]) {
    const resolved = resolveKaravanStorefrontTexts(draft);
    const html = renderToStaticMarkup(
      createElement(
        StorefrontPublicationPreviewContext.Provider,
        { value: { mode: 'catalog' } },
        createElement(SettingsStorefrontTextEditor, { draft, onChange: () => undefined }),
      ),
    );
    assert.ok(html.includes(`<p>${resolved.karavanStorefrontMessageText}</p>`));
    assert.ok(html.includes(`<span>${resolved.karavanStorefrontOpenButtonText}</span>`));
    const networkHtml = renderToStaticMarkup(
      createElement(SettingsStorefrontTextEditor, {
        draft,
        onChange: () => undefined,
        scope: 'network',
      }),
    );
    assert.ok(!networkHtml.includes('settings-storefront-editor__preview-buttons'));
    for (const field of Object.keys(draft)) {
      const limit =
        field === 'karavanStorefrontMessageText'
          ? KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH
          : KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH;
      assert.match(networkHtml, new RegExp(`id="${field}"[^>]*maxLength="${limit}"`, 'u'));
    }
  }
  assert.match(editorSource, /aria-pressed=\{variant === value\}/u);
  assert.match(editorSource, /Вернуть стандартные тексты витрины/u);
  assert.match(
    sectionSource,
    /<SettingsStorefrontTextEditor draft=\{draft\} onChange=\{onTextChange\}/u,
  );
  assert.match(pageSource, /onTextChange=\{setFieldValue\}/u);
  assert.match(pageSource, /sharedContent=\{renderSharedChatSection\('storefront'\)\}/u);
  assert.match(
    sharedFieldsSource,
    /<SettingsStorefrontTextEditor fields=\{fields\} scope=\{scope\} \/>/u,
  );
  for (const field of ['Message', 'OpenButton', 'CatalogButton', 'CreateButton']) {
    assert.ok(stateSource.includes(`'karavanStorefront${field}Text'`));
  }
});

test('storefront settings expose the admin-only toggle and keep the allowlist conditional', () => {
  assert.match(sectionSource, /karavanStorefrontAdminsOnly/u);
  assert.match(sectionSource, /draft\.karavanStorefrontEnabled\s*\?/u);
  assert.match(sectionSource, /settings-storefront__allowlist/u);
  assert.match(sectionSource, /Добавить пользователя/u);
  assert.match(sectionSource, /openMaxBotLinkAndClose/u);
  assert.match(sectionSource, /revokeKaravanStorefrontAllowlistEntry/u);
});

test('chat settings page scopes both storefront settings fields and passes the authenticated transport', () => {
  assert.match(
    stateSource,
    /storefront:\s*\[\s*'karavanStorefrontEnabled',\s*'karavanStorefrontAdminsOnly'/u,
  );
  assert.match(pageSource, /<SettingsStorefrontSection/u);
  assert.match(pageSource, /api=\{api\}/u);
  assert.match(pageSource, /chatId=\{chatId\}/u);
  assert.match(pageSource, /onAdminsOnlyChange=/u);
});

test('unknown and unavailable modes never invent a bot response', () => {
  const draft = {
    karavanStorefrontMessageText: '',
    karavanStorefrontOpenButtonText: '',
    karavanStorefrontCatalogButtonText: '',
    karavanStorefrontCreateButtonText: '',
  };
  for (const value of [
    null,
    { mode: 'unavailable', reason: 'closed' },
    { mode: 'unavailable', reason: 'connection' },
    { mode: 'unavailable', reason: 'verification' },
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(
        StorefrontPublicationPreviewContext.Provider,
        { value },
        createElement(SettingsStorefrontTextEditor, { draft, onChange: () => undefined }),
      ),
    );
    assert.ok(!html.includes('settings-storefront-editor__preview-buttons'));
    assert.ok(html.includes('role="status"'));
  }
});

test('an administrative storefront has one fixed button and no seller or catalog scenario', () => {
  const html = renderToStaticMarkup(
    createElement(
      StorefrontPublicationPreviewContext.Provider,
      { value: { mode: 'administration_storefront' } },
      createElement(SettingsStorefrontTextEditor, {
        draft: {
          karavanStorefrontMessageText: 'Товары нашего чата',
          karavanStorefrontOpenButtonText: 'В нашу витрину',
          karavanStorefrontCatalogButtonText: 'Чужие витрины',
          karavanStorefrontCreateButtonText: 'Создать свою витрину',
        },
        onChange: () => undefined,
      }),
    ),
  );
  assert.equal(
    (html.match(/class="settings-storefront-editor__preview-button"/gu) ?? []).length,
    1,
  );
  assert.ok(html.includes('<span>В нашу витрину</span>'));
  assert.ok(html.includes('Кнопка витрины чата'));
  assert.ok(html.includes('Администратор'));
  assert.ok(!html.includes('Сценарий примера'));
  assert.ok(!html.includes('id="karavanStorefrontCatalogButtonText"'));
  assert.ok(!html.includes('id="karavanStorefrontCreateButtonText"'));
  assert.ok(!html.includes('Чужие витрины'));
});

test('a closed administrative storefront keeps only its own button settings without inventing a response', () => {
  const html = renderToStaticMarkup(
    createElement(
      StorefrontPublicationPreviewContext.Provider,
      { value: { mode: 'unavailable', reason: 'closed', format: 'storefront' } },
      createElement(SettingsStorefrontTextEditor, {
        draft: {
          karavanStorefrontMessageText: '',
          karavanStorefrontOpenButtonText: '',
          karavanStorefrontCatalogButtonText: '',
          karavanStorefrontCreateButtonText: '',
        },
        onChange: () => undefined,
      }),
    ),
  );
  assert.ok(!html.includes('settings-storefront-editor__preview-buttons'));
  assert.ok(html.includes('id="karavanStorefrontOpenButtonText"'));
  assert.ok(!html.includes('id="karavanStorefrontCatalogButtonText"'));
  assert.ok(!html.includes('id="karavanStorefrontCreateButtonText"'));
});
