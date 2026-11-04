import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  resolveCaptureDevice,
  settleVisualFrame,
  setPhoneKeyboard,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { clickSettingsOverviewEntry } from './settings-overview-browser-helpers.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-commercial-screen-'));
try {
  for (const device of ['iphone-se', 'iphone', 'android']) {
    const capture = resolveCaptureDevice(presets[device]);
    const browser = await { chromium, webkit }[capture.browserName].launch(
      captureBrowserLaunchOptions(capture.browserName, base),
    );
    try {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          ...capture.contextOptions,
          colorScheme: theme,
          locale: 'ru-RU',
          timezoneId: 'Europe/Moscow',
        });
        await installNativeVisualModeInitScript(context);
        await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
        await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: '/* Local bridge */' }),
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}chat/preview-chat/settings?preview=1&device=${device}`);
        await applyNativeVisualMode(page, capture.profile);
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        const panel = page.locator('.settings-drilldown__panel--commercial');
        await panel.locator('.commercial-studio').waitFor();
        await settleVisualFrame(page);
        assert.equal(
          await panel.getByRole('button', { name: 'Сохранить', exact: true }).count(),
          0,
          'Opening must not change saved thresholds',
        );
        assert.equal(await panel.locator('details').count(), 0);
        assert.equal(await panel.locator('.commercial-studio__profiles').count(), 0);
        assert.equal(await panel.locator('.commercial-policy__category').count(), 4);
        assert.equal(await panel.getByRole('switch').count(), 4);
        assert.equal(await panel.locator('textarea').count(), 0);
        assert.doesNotMatch(
          await panel.innerText(),
          /Продам свой|Ищу электрика|Выполняю электромонтаж/u,
        );
        await panel.getByRole('button', { name: 'Как работает фильтр рекламы' }).click();
        assert.match(
          await panel.locator('.commercial-studio__hero').innerText(),
          /Неоднозначные сообщения остаются/u,
        );
        await panel.getByRole('button', { name: 'Как работает фильтр рекламы' }).click();
        await page.screenshot({ path: join(screenshots, `${device}-${theme}.png`) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(
          await panel
            .locator(
              '.commercial-studio button, .commercial-studio__ai > div, .settings-native-toggle__title',
            )
            .evaluateAll((nodes) =>
              nodes
                .filter(
                  (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2,
                )
                .map((node) => node.textContent),
            ),
          [],
          `${device}/${theme}: clipped control`,
        );
        const toggle = panel.getByRole('checkbox', { name: 'Удалять рекламу', exact: true });
        await toggle.uncheck();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(await toggle.isChecked(), false);
        await toggle.check();
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(await toggle.isChecked(), false);
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(await toggle.isChecked(), true);
        const services = panel.getByRole('switch', { name: 'Разрешить: Услуги', exact: true });
        assert.equal(await services.getAttribute('aria-checked'), 'false');
        await services.click();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(await services.getAttribute('aria-checked'), 'true');
        await services.click();
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(await services.getAttribute('aria-checked'), 'true');

        await panel.getByRole('button', { name: 'Исключения', exact: true }).click();
        const exceptions = page.getByRole('dialog', { name: 'Исключения', exact: true });
        await exceptions.getByRole('button', { name: 'Добавить', exact: true }).first().click();
        const editor = page.getByRole('dialog', { name: 'Новое исключение', exact: true });
        await editor.getByRole('button', { name: 'Выбрать участника', exact: true }).click();
        const authorPicker = page.getByRole('dialog', { name: 'Выбрать участника', exact: true });
        await authorPicker.getByRole('searchbox', { name: 'Поиск участника' }).fill('Сергей');
        await authorPicker.getByRole('button', { name: 'Сергей Маркет', exact: true }).click();
        await editor.getByRole('checkbox', { name: 'Магазины и бизнес', exact: true }).check();
        await editor.getByRole('button', { name: 'До даты', exact: true }).click();
        await page.screenshot({ path: join(screenshots, `${device}-${theme}-exception.png`) });
        await editor.getByRole('button', { name: 'Добавить', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        assert.match(await exceptions.innerText(), /Сергей Маркет/u);
        assert.match(await exceptions.innerText(), /Магазины и бизнес/u);
        assert.match(await exceptions.innerText(), /До /u);
        await exceptions.getByRole('button', { name: 'Готово', exact: true }).click();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        await panel.getByRole('button', { name: 'Исключения', exact: true }).click();
        assert.match(await exceptions.innerText(), /Сергей Маркет/u);
        await exceptions.getByRole('button', { name: /Сергей Маркет.*Магазины и бизнес/u }).click();
        const editSaved = page.getByRole('dialog', { name: 'Изменить исключение', exact: true });
        await editSaved.getByRole('checkbox', { name: 'Услуги', exact: true }).check();
        await editSaved.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        assert.doesNotMatch(
          await exceptions.locator('.commercial-policy__exceptions').innerText(),
          /Услуги/u,
        );
        await exceptions.getByRole('button', { name: 'Готово', exact: true }).click();

        await panel.getByRole('button', { name: 'Проверить сообщение', exact: true }).click();
        const preview = page.getByRole('dialog', { name: 'Проверить сообщение', exact: true });
        await preview
          .getByRole('textbox', { name: 'Сообщение для проверки' })
          .fill('Товары в наличии');
        await preview.getByRole('button', { name: 'Проверить', exact: true }).click();
        await preview.locator('.commercial-policy__result').waitFor();
        assert.match(await preview.locator('.commercial-policy__result').innerText(), /Удалить/u);
        await preview.getByRole('button', { name: 'Выбрать участника', exact: true }).click();
        await authorPicker.getByRole('searchbox', { name: 'Поиск участника' }).fill('Сергей');
        await authorPicker.getByRole('button', { name: 'Сергей Маркет', exact: true }).click();
        assert.equal(
          await preview.locator('.commercial-policy__result').count(),
          0,
          'Changed author invalidates preview',
        );
        await preview.getByRole('button', { name: 'Проверить', exact: true }).click();
        await preview.locator('.commercial-policy__result').waitFor();
        assert.match(await preview.locator('.commercial-policy__result').innerText(), /Оставить/u);
        assert.match(
          await preview.locator('.commercial-policy__result').innerText(),
          /действует исключение/u,
        );
        await page.screenshot({ path: join(screenshots, `${device}-${theme}-preview.png`) });
        await preview
          .getByRole('textbox', { name: 'Сообщение для проверки' })
          .fill('Обычное сообщение');
        assert.equal(
          await preview.locator('.commercial-policy__result').count(),
          0,
          'Changed text invalidates preview',
        );
        await preview.getByRole('textbox', { name: 'Сообщение для проверки' }).focus();
        await setPhoneKeyboard(page, { height: 250, mode: 'visual', open: true });
        await settleVisualFrame(page);
        const geometry = await preview
          .getByRole('button', { name: 'Проверить', exact: true })
          .boundingBox();
        const keyboardTop = await page.evaluate(
          () => (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight),
        );
        assert.ok(
          geometry && geometry.y + geometry.height <= keyboardTop + 2,
          `${device}/${theme}: keyboard covers preview action`,
        );
        await page.screenshot({ path: join(screenshots, `${device}-${theme}-keyboard.png`) });
        await setPhoneKeyboard(page, { open: false });
        await preview.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await panel.getByRole('button', { name: 'Журнал', exact: true }).click();
        await page.locator('.events-feed').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('filter'), 'COMMERCIAL');
        assert.equal(
          await page.getByRole('combobox', { name: 'Тип события' }).inputValue(),
          'COMMERCIAL',
        );
        await page
          .getByRole('button', { name: /Показать детали нарушения:/u })
          .first()
          .click();
        await page.getByRole('button', { name: 'Ошибка распознавания', exact: true }).click();
        await page.getByRole('button', { name: 'Отметка отправлена', exact: true }).waitFor();
        await page.getByRole('link', { name: 'Добавить исключение', exact: true }).click();
        await page.getByRole('dialog', { name: 'Новое исключение', exact: true }).waitFor();
        assert.match(
          await page.getByRole('dialog', { name: 'Новое исключение', exact: true }).innerText(),
          /Сергей Маркет/u,
        );
        assert.deepEqual(errors, []);
        await context.close();
        console.log(
          `PASS ${device}/${theme}: categories, exceptions, expiry form, preview, keyboard, filtered journal, feedback and layout`,
        );
      }
    } finally {
      await browser.close();
    }
  }
  const narrowBrowser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 360, 375, 390, 414, 430]) {
      for (const theme of ['light', 'dark']) {
        const context = await narrowBrowser.newContext({
          viewport: { width, height: 640 },
          colorScheme: theme,
          isMobile: true,
          hasTouch: true,
          locale: 'ru-RU',
        });
        await installNativeVisualModeInitScript(context);
        await installMaxBridgeShimInitScript(
          context,
          { ...presets.android, safeTop: 0, safeBottom: 0 },
          { colorScheme: theme },
        );
        const page = await context.newPage();
        await page.goto(`${base}chat/preview-chat/settings?preview=1&device=android`);
        await applyNativeVisualMode(page, presets.android);
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        await page.locator('.commercial-policy__categories').waitFor();
        await settleVisualFrame(page);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${width}/${theme}: document overflow`,
        );
        const clipped = await page
          .locator(
            '.commercial-policy__category-name, .commercial-policy__permission, .commercial-policy__tools button',
          )
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.scrollWidth > node.clientWidth + 2)
              .map((node) => node.textContent),
          );
        assert.deepEqual(clipped, [], `${width}/${theme}: clipped policy controls`);
        await page.screenshot({ path: join(screenshots, `width-${width}-${theme}.png`) });
        await context.close();
      }
    }
  } finally {
    await narrowBrowser.close();
  }
  const smallIos = await webkit.launch(captureBrowserLaunchOptions('webkit', base));
  try {
    for (const theme of ['light', 'dark']) {
      const capture = resolveCaptureDevice(presets['iphone-se']);
      const context = await smallIos.newContext({
        ...capture.contextOptions,
        viewport: { width: 320, height: 600 },
        screen: { width: 320, height: 664 },
        colorScheme: theme,
        locale: 'ru-RU',
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
      const page = await context.newPage();
      await page.goto(`${base}chat/preview-chat/settings?preview=1&device=iphone-se`);
      await applyNativeVisualMode(page, capture.profile);
      await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
      const panel = page.locator('.settings-drilldown__panel--commercial');
      await panel.locator('.commercial-policy__categories').waitFor();
      await panel.getByRole('button', { name: 'Проверить сообщение', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'Проверить сообщение', exact: true });
      await preview.getByRole('textbox', { name: 'Сообщение для проверки' }).fill('Текст проверки');
      await preview.getByRole('textbox', { name: 'Сообщение для проверки' }).focus();
      await setPhoneKeyboard(page, { height: 240, mode: 'visual', open: true });
      await settleVisualFrame(page);
      const action = await preview
        .getByRole('button', { name: 'Проверить', exact: true })
        .boundingBox();
      const viewportBottom = await page.evaluate(
        () => (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight),
      );
      assert.ok(
        action && action.y + action.height <= viewportBottom + 2,
        `WebKit320/${theme}: keyboard hides action`,
      );
      const body = preview.locator('.settings-drilldown__body');
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert.ok(
        await body.evaluate((element) => element.scrollTop > 0),
        `WebKit320/${theme}: form must scroll above keyboard`,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: join(screenshots, `webkit-320-${theme}-keyboard.png`) });
      await setPhoneKeyboard(page, { open: false });
      await preview.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await panel.getByRole('button', { name: 'Исключения', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Исключения', exact: true })
        .getByRole('button', { name: 'Добавить', exact: true })
        .first()
        .click();
      const editor = page.getByRole('dialog', { name: 'Новое исключение', exact: true });
      await editor.getByRole('button', { name: 'До даты', exact: true }).click();
      await settleVisualFrame(page);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const controls = await editor
        .locator('button, .commercial-policy__choice, .date-field')
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2,
            )
            .map((node) => node.textContent),
        );
      assert.deepEqual(controls, [], `WebKit320/${theme}: clipped exception form`);
      await page.screenshot({ path: join(screenshots, `webkit-320-${theme}-exception.png`) });
      await context.close();
    }
  } finally {
    await smallIos.close();
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}?preview=1`);
    await page.locator('.bottom-nav').waitFor();
    await page.evaluate(async () => {
      const moduleUrl = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name))?.name;
      const ReactModule = await import(moduleUrl('react.js'));
      const React = ReactModule.default ?? ReactModule;
      const ReactDOM = await import(moduleUrl('react-dom_client.js'));
      const { SharedCommercialSettingsFields } =
        await import('/app/src/pages/settings/shared-commercial-settings-fields.tsx');
      const { createNetworkSettingsFieldAdapter } =
        await import('/app/src/features/network-settings/network-settings-field-bindings.ts');
      const { settingsSectionPaths } =
        await import('/app/src/features/network-settings/field-registry.ts');
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host);
      window.__commercialMount = (mode) => {
        window.__commercialChanges = [];
        function Fixture() {
          const [changes, setChanges] = React.useState([]);
          const fields = Object.fromEntries(
            settingsSectionPaths('chat', 'commercialFilter').map((path) => [
              path,
              { kind: mode === 'loading' ? 'loading' : 'mixed' },
            ]),
          );
          if (mode !== 'loading')
            fields.commercialAdsFilterEnabled = { kind: 'common', value: true };
          if (mode === 'custom' || mode === 'readonly')
            fields.commercialAdsPolicy = {
              kind: 'common',
              value: {
                version: 1,
                categories: {
                  PERSONAL_SALE: 'ALLOW',
                  SERVICES: 'BLOCK',
                  BUSINESS: 'BLOCK',
                  COMMUNITIES: 'BLOCK',
                },
                exceptions: [],
              },
            };
          if (mode === 'custom' || mode === 'readonly')
            Object.assign(
              fields,
              Object.fromEntries(
                Object.entries({
                  commercialAdsSensitivity: 'BALANCED',
                  commercialAdsWarnThreshold: 60,
                  commercialAdsDeleteThreshold: 61,
                  textFiltersWarnEnabled: false,
                  textFiltersMuteEnabled: false,
                  textFiltersBanEnabled: true,
                  textFiltersBotMessageEnabled: false,
                }).map(([path, value]) => [path, { kind: 'common', value }]),
              ),
            );
          const adapter = createNetworkSettingsFieldAdapter({
            entityType: 'chat',
            section: 'commercialFilter',
            fields,
            changes,
            errors: {},
            readOnly: mode === 'readonly',
            onChanges: setChanges,
            onError() {},
          });
          window.__commercialChanges = changes;
          return React.createElement(SharedCommercialSettingsFields, {
            fields: adapter,
            actions: null,
          });
        }
        root.render(React.createElement(Fixture, { key: mode }));
      };
    });
    for (const mode of ['custom', 'mixed', 'readonly', 'loading']) {
      await page.evaluate((mode) => window.__commercialMount(mode), mode);
      await page.getByRole('button', { name: 'Мягко', exact: true }).waitFor();
      await settleVisualFrame(page);
      assert.deepEqual(await page.evaluate(() => window.__commercialChanges), []);
      assert.equal(
        await page
          .getByRole('switch', { name: 'Разрешить: Личные продажи', exact: true })
          .isDisabled(),
        true,
        'AI-off cannot introduce a private-sales block',
      );
      assert.equal(
        await page.locator('.commercial-studio__profiles [aria-pressed="true"]').count(),
        0,
      );
      if (mode === 'readonly' || mode === 'loading') {
        assert.equal(
          await page.getByRole('button', { name: 'Строго', exact: true }).isDisabled(),
          true,
        );
        assert.equal(await page.getByRole('checkbox').isDisabled(), true);
      } else {
        if (mode === 'custom') {
          await page.getByText('Повторные нарушения', { exact: true }).click();
          assert.match(
            await page.locator('.commercial-studio__ladder li').nth(2).innerText(),
            /Блокировка/u,
            'Third strike ban when mute is disabled',
          );
        }
        await page.getByRole('button', { name: 'Баланс', exact: true }).click();
        assert.deepEqual(
          await page.evaluate(() =>
            Object.fromEntries(
              window.__commercialChanges.map((change) => [change.path, change.value]),
            ),
          ),
          {
            ...(mode === 'mixed' ? { commercialAdsSensitivity: 'BALANCED' } : {}),
            commercialAdsWarnThreshold: 45,
            commercialAdsDeleteThreshold: 65,
          },
        );
      }
    }
    console.log(
      'PASS custom and mixed profiles stay untouched; explicit profile writes only its bundle; read-only/loading disabled; actual sanction ladder',
    );
  } finally {
    await browser.close();
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await stopChildProcess(server);
}
