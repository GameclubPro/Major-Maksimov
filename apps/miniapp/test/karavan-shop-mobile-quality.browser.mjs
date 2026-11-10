import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/mobile-quality-`);
const output = await mkdtemp('/tmp/maxim-shop-mobile-quality-');
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
console.log(`Shop mobile quality artifacts: ${output}`);
try {
  for (const [engine, width, theme] of [
    [webkit, 320, 'light'],
    [chromium, 412, 'dark'],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    const context = await browser.newContext({
      viewport: { width, height: 600 },
      isMobile: true,
      hasTouch: true,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    try {
      await installMaxBridgeShimInitScript(context, {
        platform: engine === webkit ? 'ios' : 'android',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const begin = async (scenario, screen) => {
        await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
        await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
        const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
        await home.getByRole('button', { name: 'Настройки', exact: true }).click();
        await page
          .getByRole('dialog', { name: 'Настройки', exact: true })
          .getByRole('button', { name: screen, exact: true })
          .click();
        return page.getByRole('dialog', { name: screen, exact: true });
      };
      const visible = async (locator) =>
        assert.ok(
          await locator.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const area = element.closest('.settings-drilldown__body').getBoundingClientRect();
            return box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
          }),
          'the error or consequence must be inside the visible panel body',
        );
      const shot = async (name) => {
        await settleVisualFrame(page);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${name}.png` });
      };
      let panel;
      panel = await begin('daily_full_categories', 'Категории и правила');
      await panel.locator('.karavan-shop__category').first().waitFor();
      assert.equal(await panel.locator('.karavan-shop__category').count(), 17);
      const category = panel
        .locator('.karavan-shop__category')
        .filter({ hasText: 'Услуги' })
        .first();
      await category.locator('summary').click();
      await category.getByRole('checkbox', { name: 'Вся категория', exact: true }).check();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const preview = panel.getByRole('region', { name: 'Изменения категорий', exact: true });
      await preview.waitFor();
      await visible(preview.getByText(/Скроются объявления:/));
      assert.equal(await panel.locator('.karavan-shop__category').count(), 0);
      assert.equal(
        await page.evaluate(
          () =>
            window.__shopRequests.filter((r) => r.body?.command?.operation === 'rules_update')
              .length,
        ),
        0,
      );
      await shot('category-review');
      await panel.getByRole('button', { name: 'Изменить выбор', exact: true }).click();
      await category.locator('summary').click();
      assert.equal(
        await category.getByRole('checkbox', { name: 'Вся категория', exact: true }).isChecked(),
        true,
      );

      await page.goto(`${url}?theme=${theme}&scenario=daily_content_pages`);
      await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Магазин чата', exact: true })
        .getByRole('button', { name: 'Товары и услуги', exact: true })
        .click();
      panel = page.getByRole('dialog', { name: 'Товары и услуги', exact: true });
      await panel.getByRole('tab', { name: 'Продавцы', exact: true }).click();
      const content = panel
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: 'Товары и услуги' }) })
        .first();
      await content.locator('summary').click();
      await content.getByText('Товар 24', { exact: true }).waitFor();
      await content.getByRole('button', { name: 'Показать ещё', exact: true }).click();
      await content.getByText('Товар 48', { exact: true }).waitFor();
      assert.equal(await content.locator('.karavan-shop__identity strong').count(), 48);
      await content.getByRole('button', { name: 'Показать ещё', exact: true }).click();
      await content.getByText('Товар 72', { exact: true }).waitFor();
      assert.equal(await content.locator('.karavan-shop__identity strong').count(), 72);
      await content.getByText('Товар 25', { exact: true }).scrollIntoViewIfNeeded();
      await visible(content.getByText('Товар 25', { exact: true }));
      await content.getByRole('combobox', { name: 'Раздел', exact: true }).selectOption('property');
      await content.getByText('Объект 1', { exact: true }).waitFor();
      assert.equal(await content.getByText('Товар 1', { exact: true }).count(), 0);
      assert.equal(await content.locator('.karavan-shop__identity strong').count(), 24);
      await shot('listing-pages');
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()}/${width}/${theme}: consequence review and retained pages passed`,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
