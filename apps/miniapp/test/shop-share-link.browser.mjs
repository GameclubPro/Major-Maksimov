import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

export async function runShopManualShareChecks({ base, output }) {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    if (process.env.SHOP_SHARE_ENGINE && process.env.SHOP_SHARE_ENGINE !== name) continue;
    const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
    try {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: 320, height: 504 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(
            context,
            { platform: name === 'webkit' ? 'ios' : 'android' },
            { colorScheme: theme },
          );
          await context.route('**/src/main.tsx*', (route) =>
            route.fulfill({
              contentType: 'application/javascript',
              body: `import ${JSON.stringify(new URL('test/shop-share-link.fixture.tsx', base).href)};`,
            }),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(base);
          const button = page.getByRole('button', { name: 'Поделиться ссылкой', exact: true });
          await button.waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.dataset.maxTheme), theme);
          const manual = page.getByRole('textbox', { name: 'Ссылка для копирования', exact: true });
          assert.equal(await manual.count(), 0);
          await button.click();
          await manual.waitFor();
          const first = await manual.inputValue();
          assert.match(first, /private_first$/u);
          assert.equal(await manual.getAttribute('readonly'), '');
          await manual.focus();
          assert.equal(
            await manual.evaluate((node) => node.selectionEnd - node.selectionStart),
            first.length,
          );
          await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
          const bounds = await manual.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              width: innerWidth,
              root: document.documentElement.scrollWidth,
            };
          });
          assert.ok(
            bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.root <= bounds.width + 1,
            JSON.stringify(bounds),
          );
          await page.screenshot({ path: `${output}/share-${name}-${theme}-manual.png` });
          await page.evaluate(() => (document.documentElement.style.fontSize = '16px'));
          await page.evaluate(() =>
            window.shareFixture.setUrl(
              'https://max.ru/synthetic_seller_bot?startapp=private_second',
            ),
          );
          await manual.waitFor({ state: 'detached' });
          await button.click();
          await manual.waitFor();
          assert.match(await manual.inputValue(), /private_second$/u);
          await page.evaluate(() => window.shareFixture.setDisabled(true));
          await manual.waitFor({ state: 'detached' });
          assert.equal(await button.isDisabled(), true);
          await page.evaluate(() => {
            window.shareFixture.setDisabled(false);
            window.shareFixture.nativeMode = 'hold';
            window.shareFixture.clipboard.length = 0;
          });
          await button.click();
          await page.waitForFunction(() => typeof window.shareFixture.releaseNative === 'function');
          await page.evaluate(() => window.shareFixture.setDisabled(true));
          await settleVisualFrame(page);
          await page.evaluate(() => window.shareFixture.releaseNative());
          await settleVisualFrame(page);
          assert.deepEqual(await page.evaluate(() => window.shareFixture.clipboard), []);
          assert.equal(await manual.count(), 0);
          await page.evaluate(() => {
            window.shareFixture.setDisabled(false);
            window.shareFixture.releaseNative = null;
          });
          await button.click();
          await page.waitForFunction(() => typeof window.shareFixture.releaseNative === 'function');
          await page.evaluate(() =>
            window.shareFixture.setUrl(
              'https://max.ru/synthetic_seller_bot?startapp=private_third',
            ),
          );
          await settleVisualFrame(page);
          await page.evaluate(() => window.shareFixture.releaseNative());
          await settleVisualFrame(page);
          assert.deepEqual(await page.evaluate(() => window.shareFixture.clipboard), []);
          assert.equal(await manual.count(), 0);
          await page.evaluate(() => {
            window.shareFixture.nativeMode = 'reject';
            window.shareFixture.clipboardMode = 'success';
          });
          await button.click();
          await page.getByRole('status').filter({ hasText: 'Ссылка скопирована' }).waitFor();
          assert.equal(await manual.count(), 0);
          assert.deepEqual(await page.evaluate(() => window.shareFixture.clipboard), [
            'https://max.ru/synthetic_seller_bot?startapp=private_third',
          ]);
          await page.evaluate(() => {
            window.shareFixture.nativeMode = 'success';
            window.shareFixture.clipboard.length = 0;
          });
          await button.click();
          await settleVisualFrame(page);
          assert.deepEqual(await page.evaluate(() => window.shareFixture.clipboard), []);
          await page.evaluate(() => {
            window.shareFixture.nativeMode = 'hold';
            window.shareFixture.releaseNative = null;
          });
          await button.click();
          await page.waitForFunction(() => typeof window.shareFixture.releaseNative === 'function');
          await page.evaluate(() => window.shareFixture.setMounted(false));
          await page.locator('.karavan-shop__share').waitFor({ state: 'detached' });
          await page.evaluate(() => window.shareFixture.releaseNative());
          await settleVisualFrame(page);
          assert.deepEqual(await page.evaluate(() => window.shareFixture.clipboard), []);
          await page.evaluate(() => {
            window.shareFixture.setMounted(true);
            window.shareFixture.nativeMode = 'reject';
            window.shareFixture.clipboardMode = 'hold';
          });
          await button.waitFor();
          await button.click();
          await page.waitForFunction(
            () => typeof window.shareFixture.rejectClipboard === 'function',
          );
          await page.evaluate(() =>
            window.shareFixture.setUrl(
              'https://max.ru/synthetic_seller_bot?startapp=private_fourth',
            ),
          );
          await settleVisualFrame(page);
          await page.evaluate(() => window.shareFixture.rejectClipboard());
          await settleVisualFrame(page);
          assert.equal(await manual.count(), 0);
          assert.equal(await page.getByRole('status').count(), 0);
          for (const missing of [null, undefined]) {
            await page.evaluate(
              (isNull) => window.shareFixture.setUrl(isNull ? null : undefined),
              missing === null,
            );
            await settleVisualFrame(page);
            assert.equal(await button.isDisabled(), true);
            assert.equal(await manual.count(), 0);
          }
          assert.deepEqual(errors, []);
          console.log(
            `Shop manual share ${name}/${theme}: fallback/select/current URL/permission races/null URL passed.`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
  const output = await mkdtemp('/tmp/maxim-shop-share-');
  const server = await ensureMiniappDevServer(base);
  console.log(`Shop share artifacts: ${output}`);
  try {
    await runShopManualShareChecks({ base, output });
  } finally {
    await stopChildProcess(server);
  }
}
