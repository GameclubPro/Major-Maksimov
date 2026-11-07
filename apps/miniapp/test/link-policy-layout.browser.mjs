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
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const output = mkdtempSync(join(tmpdir(), 'maxim-link-policy-layout-'));

async function checkLabels(group, label) {
  const problems = await group.evaluate((element) => {
    const issues = [];
    const buttons = [...element.querySelectorAll('[role="radio"]')];
    if (buttons.length !== 4) issues.push('Expected all four link policies');
    for (const [index, button] of buttons.entries()) {
      const box = button.getBoundingClientRect();
      if (box.width < 44 || box.height < 44) issues.push('Policy target smaller than 44px');
      if (box.left < -1 || box.right > innerWidth + 1) issues.push('Policy outside viewport');
      for (const other of buttons.slice(index + 1)) {
        const bounds = other.getBoundingClientRect();
        if (
          Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left) > 1 &&
          Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top) > 1
        )
          issues.push('Policy targets overlap');
      }
      const node = [...button.querySelectorAll('span')].find((span) =>
        span.textContent.trim(),
      )?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) {
        issues.push('Policy label missing');
        continue;
      }
      for (const match of node.textContent.matchAll(/\S+/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1)
          issues.push(`Word split across lines: ${match[0]}`);
        if (rects.some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1))
          issues.push(`Policy label clipped: ${match[0]}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Page overflow');
    return issues;
  });
  assert.deepEqual(problems, [], `${label}: ${JSON.stringify(problems)}`);
}

try {
  for (const [engine, browserType] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await browserType.launch(captureBrowserLaunchOptions(engine, base));
    try {
      for (const width of [280, 320, 393]) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: 740 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
            colorScheme: theme,
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
              {},
              { colorScheme: theme, platform: 'ios' },
            );
            await installNativeVisualModeInitScript(context);
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`${base}chat/preview-chat/settings?preview=1&focus=links`);
            const group = page.getByRole('radiogroup', { name: 'Режим модерации ссылок' });
            await group.waitFor();
            await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
            for (const fontSize of [16, 20]) {
              await page.evaluate(async (size) => {
                document.documentElement.style.fontSize = `${size}px`;
                await document.fonts.ready;
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
              }, fontSize);
              await checkLabels(group, `${engine} ${width}px ${theme} ${fontSize}px text`);
              if (fontSize === 16 && width === 393) {
                const rows = await group
                  .getByRole('radio')
                  .evaluateAll((nodes) =>
                    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
                  );
                assert.equal(
                  new Set(rows).size,
                  2,
                  'Ordinary smartphone uses the approved two-column panel',
                );
              }
            }
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '16px';
            });
            for (const name of [
              'Разрешать все',
              'Удалять все',
              'Разрешать по списку',
              'Запрещать по списку',
            ]) {
              const option = group.getByRole('radio', { name, exact: true });
              await option.click();
              assert.equal(await option.getAttribute('aria-checked'), 'true');
            }
            await page.getByRole('button', { name: 'Добавить', exact: true }).click();
            const editor = page.getByRole('region', { name: 'Добавление правила' });
            const select = editor.getByRole('combobox', { name: 'Область правила' });
            await select.scrollIntoViewIfNeeded();
            assert.equal(
              await select.evaluate((node) => getComputedStyle(node).appearance),
              'none',
            );
            const values = await select
              .locator('option')
              .evaluateAll((nodes) => nodes.map((node) => node.value));
            for (const value of values) {
              await select.selectOption(value);
              assert.equal(await select.inputValue(), value);
            }
            await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
            assert.equal(
              await page.locator('.links-panel').getByText('МАЙОР', { exact: true }).count(),
              0,
            );
            await group.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: join(output, `${engine}-${width}-${theme}.png`),
              animations: 'disabled',
            });
            assert.deepEqual(errors, []);
            console.log(
              `PASS ${engine} ${width}px ${theme}: four modes, two-column panel, large text, themed rule scope`,
            );
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Link policy screenshots: ${output}`);
} finally {
  await stopChildProcess(server);
}
