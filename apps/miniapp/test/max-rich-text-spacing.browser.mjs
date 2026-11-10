import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-text-spacing-'));
const headline = 'РЕКЛАМА ✅';
const region = 'Новокузнецк и близлежащие районы';
const cta = 'Подписаться на нас 👇';
let browser;
try {
  for (const [engine, browserType] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    browser = await browserType.launch({
      headless: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(?:all|https?|no)_proxy$/iu.test(key)),
      ),
    });
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // FLAG: Exercise local editor/preview components without contacting MAX or publishing.
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      const editor = page.getByRole('textbox', { name: 'Greeting', exact: true });
      const markdown = () => page.getByTestId('markdown').textContent();
      const open = async (value = '') => {
        const url = new URL('test/browser/rich-text.html', base);
        url.searchParams.set('composer', '1');
        url.searchParams.set('value', value);
        await page.goto(url.href);
        await editor.waitFor();
        await page.waitForFunction(
          () => document.querySelector('[contenteditable="true"][aria-disabled]') === null,
        );
        await page.evaluate((theme) => {
          document.documentElement.dataset.maxTheme = theme;
          document.body.dataset.miniappProfile = 'publisher';
        }, theme);
        await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
      };
      for (const breaks of [1, 2, 3, 5]) {
        await open();
        await editor.fill(headline);
        await page.keyboard.press('Enter');
        await page.keyboard.insertText(region);
        assert.equal(await markdown(), `${headline}\n${region}`, `${engine}: single Enter`);
        for (let index = 0; index < breaks; index += 1) await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Жирный', exact: true }).click();
        await page.keyboard.insertText(cta);
        const expected = `${headline}\n${region}${'\n'.repeat(breaks)}**${cta}**`;
        assert.equal(await markdown(), expected, `${engine}-${theme}: ${breaks} native Enters`);
        await open(expected);
        // Trigger serialization after reopening as well as checking the rendered preview.
        await editor.evaluate((element) =>
          element.dispatchEvent(new Event('input', { bubbles: true })),
        );
        assert.equal(await markdown(), expected, `${engine}-${theme}: reopen and serialize`);
        const preview = page.locator('.max-markdown-preview');
        assert.equal(await preview.locator('br').count(), breaks + 1);
        assert.equal(await preview.locator('strong').textContent(), cta);
        const distance = await preview.evaluate((element) => {
          const regionNode = [...element.childNodes].find(
            (node) => node.textContent === 'Новокузнецк и близлежащие районы',
          );
          const range = document.createRange();
          range.selectNodeContents(regionNode);
          const regionRects = [...range.getClientRects()];
          const regionRect = regionRects.at(-1);
          range.selectNodeContents(element.firstChild);
          const headlineRect = [...range.getClientRects()].at(-1);
          const ctaRect = element.querySelector('strong').getBoundingClientRect();
          const rowHeight = regionRects[0].top - headlineRect.top;
          return (ctaRect.top - regionRect.top) / rowHeight;
        });
        assert.ok(
          Math.abs(distance - breaks) < 0.1,
          `${engine}-${theme}: visible rows ${distance}, expected ${breaks}`,
        );
        if (breaks === 2)
          await page.screenshot({ path: join(screenshots, `${engine}-${theme}.png`) });
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `PASS ${engine}-${theme}: native Enter, formatted paragraphs, preview and reopen`,
      );
    }
    await browser.close();
    browser = null;
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
