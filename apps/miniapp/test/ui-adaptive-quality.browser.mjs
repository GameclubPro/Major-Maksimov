import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output = await mkdtemp('/tmp/maxim-ui-adaptive-');
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
console.log(`Adaptive quality artifacts: ${output}`);
try {
  for (const engine of [webkit, chromium]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: 320, height: 504 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          locale: 'ru-RU',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(
            context,
            { platform: engine === webkit ? 'ios' : 'android' },
            { colorScheme: theme },
          );
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${base}chat/preview-chat/settings?preview=1`);
          const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
          await search.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          for (const query of ['Биржик', 'Рекламная биржа', 'взаимопиар']) {
            await search.fill(query);
            await search.blur();
            for (const viewport of [
              { width: 320, height: 504 },
              { width: 844, height: 286 },
            ]) {
              await page.setViewportSize(viewport);
              await settleVisualFrame(page);
              await page.locator('.marketplace-profile-card:not([hidden])').waitFor();
              assert.equal(await page.getByText('Ничего не найдено', { exact: true }).count(), 0);
              await page
                .getByRole('button', { name: 'Рекламная биржа', exact: true })
                .scrollIntoViewIfNeeded();
            }
          }
          await page.screenshot({
            path: `${output}/${engine.name()}-${theme}-marketplace-landscape.png`,
          });
          await page.goto(
            `${base}channel/preview-channel/dialog/suggest?preview=1&profile=publisher&token=preview-suggest-token-0001&title=Подмена`,
          );
          const destination = page.getByLabel('Канал-получатель: Новости Южного', { exact: true });
          await destination.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          for (const tab of ['Предпросмотр', 'Написать']) {
            await page.getByRole('tab', { name: tab, exact: true }).click();
            assert.equal(await destination.isVisible(), true);
            assert.equal(await page.getByText('Подмена', { exact: true }).count(), 0);
          }
          const editor = page.getByRole('textbox', { name: 'Текст объявления', exact: true });
          assert.equal(
            await editor.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              const y = rect.top + parseFloat(getComputedStyle(node).paddingTop) + 12;
              return node.contains(document.elementFromPoint(rect.left + 15, y));
            }),
            true,
            'the empty suggestion first line is reachable without scrolling past its toolbar',
          );
          await page.screenshot({
            path: `${output}/${engine.name()}-${theme}-destination-landscape.png`,
          });
          await context.route('**/src/main.tsx*', (route) =>
            route.fulfill({
              contentType: 'application/javascript',
              body: `import ${JSON.stringify(new URL('test/fixtures/publication-mobile-editors-harness.tsx', base).href)};`,
            }),
          );
          await page.goto(base);
          await page.locator('.publication-target-picker__summary').click();
          const picker = page.getByRole('dialog', { name: 'Получатели', exact: true });
          const list = picker.locator('.publication-target-picker__list');
          for (const viewport of [
            { width: 844, height: 286 },
            { width: 667, height: 320 },
            { width: 320, height: 504 },
            { width: 393, height: 749 },
          ]) {
            await page.setViewportSize(viewport);
            await settleVisualFrame(page);
            const metric = await list.evaluate((node) => ({
              list: node.getBoundingClientRect().toJSON(),
              row: node.querySelector('.publication-target-row').getBoundingClientRect().toJSON(),
            }));
            assert.ok(metric.list.height >= metric.row.height, JSON.stringify(metric));
            if (viewport.width > 600)
              assert.ok(metric.list.height >= metric.row.height * 2, JSON.stringify(metric));
            await list.evaluate((node) => {
              node.scrollTop = node.scrollHeight;
            });
            const last = list.locator('.publication-target-row').filter({ hasText: 'Канал 200 ·' });
            await last.waitFor();
            await last.click();
            assert.equal(await last.getAttribute('aria-pressed'), 'true');
            await page.screenshot({
              path: `${output}/${engine.name()}-${theme}-picker-${viewport.width}.png`,
            });
            await last.click();
          }
          await picker.getByRole('button', { name: 'Завершить выбор получателей' }).click();
          await picker.waitFor({ state: 'detached' });
          assert.deepEqual(errors, []);
          console.log(
            `${engine.name()}/${theme}: orientation search, destination and virtualized picker passed`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}
