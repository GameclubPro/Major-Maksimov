import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = process.env.MINIAPP_VK_TEST_BASE_URL ?? 'http://127.0.0.1:4175/app/';
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname),
  'Preview tests must stay local',
);
const profiles = [
  ['desktop-light', { viewport: { width: 1440, height: 1000 } }, 'light'],
  ['iphone-light', devices['iPhone 15'], 'light'],
  ['iphone-dark', devices['iPhone 15'], 'dark'],
  ['android-light', devices['Pixel 7'], 'light'],
  ['android-dark', devices['Pixel 7'], 'dark'],
  ['iphone-se-light', devices['iPhone SE'], 'light'],
];
const selectedProfile = process.env.MINIAPP_VK_TEST_PROFILE;
assert.ok(
  !selectedProfile || profiles.some(([name]) => name === selectedProfile),
  'Unknown VK browser test profile',
);
const server = await ensureMiniappDevServer(baseUrl, {
  reuseServer: process.env.MINIAPP_VK_TEST_REUSE_SERVER === '1',
});
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-vk-workspace-'));
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, device, colorScheme] of profiles.filter(
    ([name]) => !selectedProfile || name === selectedProfile,
  )) {
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
      await page.goto(`${baseUrl}?preview=1&profile=publisher&view=channel`);
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page
        .getByRole('button', {
          name: device.viewport.width <= 600 ? 'Посты из VK' : 'Открыть посты из VK',
          exact: true,
        })
        .click();
      await page.locator('.vk-parsing-workspace').waitFor();
      await applyNativeVisualMode(page, {
        safeTop: 0,
        safeBottom: name.startsWith('iphone') ? 20 : 0,
      });
      await page.locator('.vk-parsing-post-card').first().waitFor();
      await page.screenshot({ path: path.join(screenshots, `${name}-posts.png`) });
      const clipped = await page.locator('.vk-parsing-filter-bar button').evaluateAll((buttons) =>
        buttons
          .filter((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            const text = range.getBoundingClientRect();
            const box = button.getBoundingClientRect();
            return text.left < box.left - 1 || text.right > box.right + 1;
          })
          .map((button) => button.textContent),
      );
      assert.deepEqual(clipped, [], 'Filter text must fit its control');

      await page.getByRole('button', { name: 'Открыть фото 1', exact: true }).first().click();
      const photo = page.getByRole('dialog', { name: 'Фото из поста', exact: true });
      await photo.getByRole('img', { name: 'Фото 1 из 2', exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector('.vk-photo-viewer img')?.naturalWidth > 0,
      );
      await photo.getByRole('button', { name: 'Следующее фото', exact: true }).click();
      await photo.getByRole('img', { name: 'Фото 2 из 2', exact: true }).waitFor();
      await photo.getByRole('button', { name: 'Закрыть панель', exact: true }).click();

      const filter = page.getByRole('combobox', { name: 'Группа в ленте' });
      const sourceId = await filter.locator('option').nth(2).getAttribute('value');
      await filter.selectOption(sourceId);
      await page.getByRole('tab', { name: /Группы/u }).click();
      await page
        .locator('.vk-source-card')
        .first()
        .getByRole('button', { name: /Настройки группы/u })
        .click();
      const sourceDialog = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('combobox', { name: 'Способ доставки постов группы' }) });
      await sourceDialog.waitFor();
      await sourceDialog
        .getByRole('combobox', { name: 'Способ доставки постов группы' })
        .selectOption('QUEUE');
      const interval = sourceDialog.getByRole('spinbutton', { name: /^Интервал публикаций для/u });
      await interval.waitFor({ timeout: 5_000 }).catch(async (error) => {
        await page.screenshot({ path: path.join(screenshots, `${name}-source-failure.png`) });
        console.error(`Source failure screenshot: ${screenshots}`);
        throw error;
      });
      const previousInterval = await interval.inputValue();
      for (const invalid of ['0', '10081', '1.5', '']) {
        await interval.fill(invalid);
        assert.equal(await interval.getAttribute('aria-invalid'), 'true');
        await interval.press('Tab');
        await sourceDialog
          .getByRole('status')
          .filter({ hasText: /нужно целое число от 5 до 10080/u })
          .waitFor();
        assert.equal(await interval.inputValue(), previousInterval);
        assert.ok(await interval.getAttribute('aria-describedby'));
      }
      await interval.fill('0');
      await interval.press('Escape');
      assert.equal(await interval.inputValue(), previousInterval);
      assert.equal(await sourceDialog.locator('.vk-number-feedback').count(), 0);
      await interval.fill('5');
      await interval.press('Tab');
      await page.waitForFunction(
        () => !document.querySelector('.vk-source-config input[type="number"]')?.disabled,
      );
      assert.equal(await interval.inputValue(), '5');
      await page.screenshot({ path: path.join(screenshots, `${name}-source.png`) });
      await sourceDialog.getByRole('button', { name: 'Отключить группу', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Отключить группу?', exact: true })
        .getByRole('button', { name: 'Отмена', exact: true })
        .click();
      await sourceDialog.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page.getByRole('tab', { name: 'Посты', exact: true }).click();
      assert.equal(
        await filter.inputValue(),
        sourceId,
        'Source settings must not change the feed filter',
      );
      await filter.selectOption('');

      await page.getByRole('tab', { name: 'Автоматизация', exact: true }).click();
      const options = page.getByRole('region', { name: 'Оформление и удаление постов' });
      await options.getByRole('switch', { name: 'Первоисточник', exact: true }).check();
      await options.getByRole('button', { name: 'Своя ссылка', exact: true }).click();
      const sourceInput = options.getByRole('textbox', {
        name: 'Ссылка на первоисточник',
        exact: true,
      });
      await sourceInput.fill('https://user:password@example.com');
      await options.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await options.getByRole('alert').waitFor();
      await sourceInput.fill('https://example.com/original?article=12345678901234567890');
      await options.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('.vk-publication-options__url button')?.disabled,
      );
      await options.getByRole('switch', { name: 'Автоудаление', exact: true }).check();
      const delay = options.getByRole('combobox', {
        name: 'Срок автоудаления постов ВК',
        exact: true,
      });
      await delay.selectOption('360');
      await page.waitForFunction(
        () => document.querySelector('.vk-publication-options__delay select')?.value === '360',
      );
      await delay.selectOption('custom');
      const customMinutes = options.getByRole('spinbutton', {
        name: 'Срок автоудаления в минутах',
        exact: true,
      });
      await customMinutes.fill('90');
      await customMinutes.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector('.vk-publication-options input[type="number"]')?.value === '90',
      );
      await options.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-publication-options.png`) });
      assert.equal(
        await options.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
        'Publication options must fit',
      );
      await page.getByRole('tab', { name: 'Посты', exact: true }).click();
      await page.getByRole('tab', { name: 'Автоматизация', exact: true }).click();
      assert.equal(
        await sourceInput.inputValue(),
        'https://example.com/original?article=12345678901234567890',
      );
      assert.equal(await customMinutes.inputValue(), '90');

      await page.getByRole('radio', { name: 'Пауза', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('.vk-autopost-mode [aria-checked="true"]')?.textContent ===
          'Пауза',
      );
      await page.getByRole('radio', { name: 'Авто', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Включить автопубликацию?', exact: true })
        .getByRole('button', { name: 'Отмена', exact: true })
        .click();
      assert.equal(
        await page.getByRole('radio', { name: 'Пауза', exact: true }).getAttribute('aria-checked'),
        'true',
      );
      await page.getByRole('radio', { name: 'Авто', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Включить автопубликацию?', exact: true })
        .getByRole('button', { name: 'Включить', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('.vk-autopost-mode [aria-checked="true"]')?.textContent === 'Авто',
      );
      await page.locator('.vk-autopost-advanced > summary').click();
      await page.getByRole('button', { name: 'Время', exact: true }).click();
      const allDay = page.getByRole('switch', { name: 'Круглосуточно', exact: true });
      await allDay.check();
      await page.getByText('Нет перерыва', { exact: true }).waitFor();
      assert.equal(await allDay.isChecked(), true);
      await allDay.uncheck();
      await page.getByRole('button', { name: /^Время публикаций: с/u }).waitFor();
      assert.equal(await page.locator('.vk-autopost-panel__schedule').isVisible(), false);
      assert.equal(
        await page
          .locator('.vk-schedule-time-panel')
          .getByText('09:00 - 22:00', { exact: true })
          .count(),
        0,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-time.png`) });
      await page.getByRole('button', { name: 'Об автоматической публикации', exact: true }).click();
      const info = page.getByRole('dialog', { name: 'Об автоматической публикации', exact: true });
      await info.waitFor();
      await page.keyboard.press('Escape');
      await info.waitFor({ state: 'hidden' });

      await page.getByRole('tab', { name: 'Посты', exact: true }).click();
      await page.getByRole('button', { name: 'Редактировать', exact: true }).first().click();
      const editor = page.locator('.vk-editor-dialog');
      await editor.waitFor();
      const selectedPhoto = editor.getByRole('button', { name: 'Убрать фото 1', exact: true });
      await page.route('**/vk-photo-unavailable', (route) => route.abort());
      await selectedPhoto.locator('img').evaluate((image, url) => {
        image.src = url;
      }, `${baseUrl}vk-photo-unavailable`);
      await editor.getByText('Фото 1 недоступно', { exact: true }).waitFor({ timeout: 5_000 });
      assert.equal(await selectedPhoto.getAttribute('aria-pressed'), 'true');
      assert.ok(await selectedPhoto.getAttribute('aria-describedby'));
      assert.match(
        await selectedPhoto.evaluate(
          (button) => document.getElementById(button.getAttribute('aria-describedby'))?.textContent,
        ),
        /Фото 1 недоступно/u,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-photo-unavailable.png`) });
      const retryPhoto = editor.getByRole('button', {
        name: 'Повторить загрузку фото 1',
        exact: true,
      });
      await retryPhoto.focus();
      await retryPhoto.press('Enter');
      assert.equal(
        await selectedPhoto.evaluate((button) => button === document.activeElement),
        true,
      );
      await selectedPhoto.locator('img').waitFor();
      assert.equal(await selectedPhoto.getAttribute('aria-pressed'), 'true');
      await editor.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Редактировать', exact: true }).first().click();
      const input = editor.getByRole('textbox', { name: 'Текст VK-поста', exact: true });
      await input.fill('Несохранённый текст для проверки');
      if (!name.startsWith('desktop')) {
        const viewport = page.viewportSize();
        const reducedHeight = Math.max(viewport.width + 1, viewport.height - 260);
        await page.setViewportSize({ width: viewport.width, height: reducedHeight });
        await editor
          .getByRole('button', { name: 'Опубликовать', exact: true })
          .scrollIntoViewIfNeeded();
        const action = await editor
          .getByRole('button', { name: 'Опубликовать', exact: true })
          .boundingBox();
        assert.ok(
          action.y >= 0 && action.y + action.height <= reducedHeight + 1,
          'Publish action must stay reachable above the keyboard',
        );
        await page.screenshot({ path: path.join(screenshots, `${name}-keyboard.png`) });
        await page.setViewportSize(viewport);
      }
      await page.evaluate(() => document.querySelector('[aria-label="Обновить посты"]')?.click());
      await page.waitForTimeout(500);
      assert.match(await input.innerText(), /Несохранённый текст/u);
      await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
      const discard = page.getByRole('dialog', { name: 'Не сохранять изменения?', exact: true });
      await discard.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
      assert.match(await input.innerText(), /Несохранённый текст/u);
      await editor.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await discard.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.vk-parsing-workspace').isVisible(), true);
      if (name === 'desktop-light') {
        await page.getByRole('tab', { name: /Группы/u }).click();
        for (let count = 2; count > 0; count -= 1) {
          await page
            .locator('.vk-source-card')
            .first()
            .getByRole('button', { name: /Настройки группы/u })
            .click();
          const group = page
            .getByRole('dialog')
            .filter({ has: page.getByRole('combobox', { name: 'Способ доставки постов группы' }) });
          await group.getByRole('button', { name: 'Отключить группу', exact: true }).click();
          await page
            .getByRole('dialog', { name: 'Отключить группу?', exact: true })
            .getByRole('button', { name: 'Отключить', exact: true })
            .click();
          await page.waitForFunction(
            (remaining) => document.querySelectorAll('.vk-source-card').length === remaining,
            count - 1,
          );
        }
        await page.getByRole('tab', { name: 'Посты', exact: true }).click();
        await page.getByText('Новых постов пока нет', { exact: true }).waitFor();
        await page.getByRole('textbox', { name: 'Ссылка на группу VK' }).fill('vk.com/urban_news');
        await page.getByRole('button', { name: 'Добавить группу', exact: true }).click();
        await page.getByRole('tab', { name: /Группы/u }).click();
        await page.waitForFunction(() => document.querySelectorAll('.vk-source-card').length === 1);
      }
      await page.goto(
        `${baseUrl}publisher/channel/preview-channel?preview=1&profile=publisher&focus=vk`,
      );
      await page.locator('.vk-parsing-workspace').waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.vk-parsing-workspace').waitFor({ state: 'hidden' });
      const vkTrigger = page.locator('[data-publisher-module="vk"] [aria-expanded]');
      assert.equal(await vkTrigger.getAttribute('aria-expanded'), 'false');
      await page.evaluate(() => {
        const url = new URL(location.href);
        url.searchParams.set('unrelated', '1');
        history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      assert.equal(
        await vkTrigger.getAttribute('aria-expanded'),
        'false',
        'Manual close survives unrelated URL changes',
      );
      assert.deepEqual(errors, []);
      console.log(`${name}: passed`);
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
