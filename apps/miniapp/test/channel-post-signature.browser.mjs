import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-post-signature-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme] of [
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light'],
    ['iphone-light', devices['iPhone SE'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${baseUrl}channel/preview-channel/settings?preview=1`);
      await applyNativeVisualMode(page, {
        safeTop: 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      const entry = page.getByRole('button', { name: 'Действие под публикацией', exact: true });
      await entry.click();
      const panel = page.locator('.settings-drilldown__panel--signature');
      await panel.waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        const { PREVIEW_REQUEST_HANDLERS } = await import('/app/src/lib/api/preview-transport.ts');
        const { ApiRequestError } = await import('/app/src/lib/api-request-error.ts');
        const { PREVIEW_NOT_HANDLED } =
          await import('/app/src/lib/api/preview-transport-runtime.ts');
        window.signatureTest = {
          requests: [],
          delay: false,
          release: null,
          saved: null,
          fail: false,
        };
        PREVIEW_REQUEST_HANDLERS.unshift(async ({ url, method, init, state }) => {
          if (!url.pathname.endsWith('/post-signature') || method !== 'PATCH')
            return PREVIEW_NOT_HANDLED;
          const payload = JSON.parse(init.body);
          const test = window.signatureTest;
          test.requests.push(payload);
          if (payload.expectedRevision !== (state.channelPostSignature.revision ?? 0))
            throw new ApiRequestError(
              409,
              JSON.stringify({ code: 'CHANNEL_SETTINGS_CONCURRENT_UPDATE' }),
              'Настройки изменились',
            );
          if (test.requests.length > 20) throw new Error('Signature save loop');
          if (test.delay) {
            test.delay = false;
            await new Promise((resolve) => {
              test.release = resolve;
            });
          }
          if (test.fail) {
            test.fail = false;
            throw new Error('Нет соединения');
          }
          const saved = {
            ...state.channelPostSignature,
            ...payload,
            revision: (state.channelPostSignature.revision ?? 0) + 1,
          };
          if (saved.text === 'server-normalize') saved.text = 'Server normalized';
          state.channelPostSignature = saved;
          test.saved = saved;
          return structuredClone(saved);
        });
      });
      await panel.locator('.channel-post-actions__signature-settings > summary').click();
      const text = panel.locator('#channel-post-signature-text');
      const url = panel.locator('#channel-post-signature-url');
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      const saved = panel.getByText('Сохранено', { exact: true });
      await panel.getByRole('checkbox', { name: 'Добавлять подпись' }).check();
      await text.fill('Read channel');
      await text.blur();
      assert.equal(await page.evaluate(() => window.signatureTest.requests.length), 0);
      await save.click();
      await saved.waitFor();
      await panel.getByRole('radio', { name: 'Кнопка', exact: true }).click();
      await save.click();
      await saved.waitFor();
      assert.equal(await page.evaluate(() => window.signatureTest.saved.presentation), 'button');
      await text.fill('');
      assert.equal(await text.getAttribute('aria-invalid'), 'true');
      assert.equal(await save.isDisabled(), true);
      await text.fill('Read channel');
      await url.fill('javascript:alert(1)');
      assert.equal(await url.getAttribute('aria-invalid'), 'true');
      await url.fill('https://example.com/read');
      await save.click();
      await saved.waitFor();
      await page.evaluate(() => {
        window.signatureTest.delay = true;
      });
      await text.fill('First edit');
      await save.click();
      await page.waitForFunction(() => window.signatureTest.release !== null);
      assert.equal(await text.isDisabled(), true);
      await page.evaluate(() => window.signatureTest.release());
      await saved.waitFor();
      const beforeNormalization = await page.evaluate(() => window.signatureTest.requests.length);
      await text.fill('server-normalize');
      await save.click();
      await saved.waitFor();
      assert.equal(await text.inputValue(), 'Server normalized');
      assert.equal(
        await page.evaluate(() => window.signatureTest.requests.length),
        beforeNormalization + 1,
      );
      await panel.locator('.channel-post-actions__signature-settings > summary').click();

      const add = panel.getByRole('button', { name: 'Добавить кнопку', exact: true });
      const editor = panel
        .getByRole('region', { name: 'Свои кнопки' })
        .locator('.channel-custom-buttons__editor');
      await add.click();
      await editor.getByLabel('Название').fill('Каталог');
      await editor.getByLabel('Ссылка', { exact: true }).fill('javascript:alert(1)');
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      await editor.getByRole('alert').waitFor();
      await editor.getByLabel('Ссылка', { exact: true }).fill('https://example.com1/catalog');
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      await editor
        .getByRole('alert')
        .getByText('Проверьте адрес сайта в ссылке, например https://example.com.')
        .waitFor();
      assert.equal(await panel.locator('.channel-custom-buttons__item').count(), 0);
      await editor.screenshot({ path: path.join(screenshots, `${name}-invalid-host.png`) });
      await editor.getByLabel('Ссылка', { exact: true }).fill('https://example.com/catalog#new');
      assert.equal(await save.isDisabled(), true);
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      await panel.getByRole('button', { name: 'Изменить кнопку «Каталог»' }).waitFor();
      assert.equal(
        await panel.getByRole('checkbox', { name: 'Добавлять свои кнопки' }).isChecked(),
        true,
      );
      assert.equal(
        await panel
          .locator('.channel-post-actions__preview-button', { hasText: 'Каталог' })
          .count(),
        1,
      );
      await page.evaluate(() => {
        window.signatureTest.fail = true;
      });
      await save.click();
      await panel.getByText('Не сохранено', { exact: true }).waitFor();
      await save.click();
      await saved.waitFor();
      assert.equal(
        await page.evaluate(() => window.signatureTest.saved.customButtons[0].text),
        'Каталог',
      );

      await add.click();
      await editor.getByLabel('Название').fill('Контакты');
      await editor.getByLabel('Ссылка', { exact: true }).fill('https://example.com/catalog#new');
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      await editor.getByText('Кнопка с этой ссылкой уже есть.').waitFor();
      await editor.getByLabel('Ссылка', { exact: true }).fill('https://example.com/contacts');
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      const grip = panel.getByRole('button', { name: 'Переместить «Контакты»' });
      await grip.focus();
      await grip.press('ArrowUp');
      assert.equal(
        await panel.locator('.channel-custom-buttons__item strong').first().textContent(),
        'Контакты',
      );
      const preview = panel.locator('.channel-post-actions__preview');
      if (
        !(await preview.getAttribute('open')) &&
        !(await preview.evaluate((element) => element.open))
      )
        await preview.locator('summary').click();
      const compactRow = preview
        .locator('.channel-post-actions__preview-row')
        .filter({ hasText: 'Каталог' });
      assert.deepEqual(
        await compactRow.locator('.channel-post-actions__preview-button').allTextContents(),
        ['Контакты', 'Каталог'],
      );
      const boxes = await compactRow
        .locator('.channel-post-actions__preview-button')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return {
              x,
              y,
              width,
              height,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            };
          }),
        );
      assert.equal(boxes[0].y, boxes[1].y);
      assert.ok(boxes[1].x > boxes[0].x);
      for (const box of boxes) {
        assert.ok(box.height >= 44);
        assert.ok(box.scrollWidth <= box.clientWidth);
      }
      await preview.screenshot({ path: path.join(screenshots, `${name}-compact-preview.png`) });
      await panel.getByRole('button', { name: 'Изменить кнопку «Контакты»' }).click();
      await editor.getByRole('button', { name: 'Удалить', exact: true }).click();
      await panel.getByRole('button', { name: 'Вернуть', exact: true }).click();
      assert.equal(await panel.locator('.channel-custom-buttons__item').count(), 2);
      await panel.getByRole('checkbox', { name: 'Добавлять свои кнопки' }).uncheck();
      assert.equal(await panel.locator('.channel-custom-buttons__item').count(), 2);
      assert.equal(
        await panel
          .locator('.channel-post-actions__preview-button', { hasText: 'Каталог' })
          .count(),
        0,
      );
      await panel.getByRole('checkbox', { name: 'Добавлять свои кнопки' }).check();
      await save.click();
      await saved.waitFor();
      await page.evaluate(async () => {
        const { PREVIEW_REQUEST_HANDLERS } = await import('/app/src/lib/api/preview-transport.ts');
        const { PREVIEW_NOT_HANDLED } =
          await import('/app/src/lib/api/preview-transport-runtime.ts');
        let applied = false;
        const once = async ({ state }) => {
          if (applied) return PREVIEW_NOT_HANDLED;
          applied = true;
          state.channelPostSignature.revision = (state.channelPostSignature.revision ?? 0) + 1;
          state.channelPostSignature.text = 'Другой администратор';
          return PREVIEW_NOT_HANDLED;
        };
        PREVIEW_REQUEST_HANDLERS.unshift(once);
      });
      await panel.getByRole('button', { name: 'Изменить кнопку «Каталог»' }).click();
      await editor.getByLabel('Название').fill('Мой каталог');
      await editor.getByRole('button', { name: 'Готово', exact: true }).click();
      await save.click();
      await panel.getByText('Не сохранено', { exact: true }).waitFor();
      assert.match(
        await panel.locator('.channel-post-actions__save-error').innerText(),
        /Ваши правки сохранены в черновике/,
      );
      await panel.getByRole('button', { name: 'Изменить кнопку «Мой каталог»' }).waitFor();
      await save.click();
      await saved.waitFor();
      assert.equal(
        await page.evaluate(() => window.signatureTest.saved.text),
        'Другой администратор',
      );
      await add.click();
      await editor.getByLabel('Название').fill('Несохранённая');
      await editor.getByLabel('Ссылка', { exact: true }).fill('https://example.com/draft');
      await editor.screenshot({ path: path.join(screenshots, `${name}-editor.png`) });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await editor.getByRole('button', { name: 'Готово', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
      );
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      await editor.getByRole('button', { name: 'Назад к кнопкам' }).click();
      await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      assert.equal(await panel.locator('.channel-custom-buttons__item').count(), 2);
      await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
      const layout = await panel.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth,
        screenFits: document.documentElement.scrollWidth <= innerWidth,
      }));
      assert.deepEqual(layout, { fits: true, screenFits: true });
      assert.deepEqual(errors, []);
      console.log(
        `${name}: explicit save, custom buttons, validation, retry, reorder, undo and draft protection passed`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
