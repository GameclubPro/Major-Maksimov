import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

const base =
  process.env.SUGGEST_COMPOSER_BASE_URL || (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output =
  process.env.SUGGEST_COMPOSER_OUTPUT || (await mkdtemp('/tmp/maxim-suggest-composer-'));
await mkdir(output, { recursive: true });
const title = 'Барахолка Новороссийск • Анапа • Геленджик | Купи/Продай';
const results = [];
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.SUGGEST_COMPOSER_REUSE_SERVER === '1',
});
console.log(`Suggestion composer artifacts: ${output}`);

async function checkControls(page, selector) {
  const boxes = await page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getClientRects().length)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          name: node.getAttribute('aria-label') || node.title || node.textContent.trim(),
          ...box.toJSON(),
          hit: node.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          ),
          viewport: innerWidth,
        };
      }),
  );
  assert.ok(boxes.length, selector);
  for (const box of boxes) {
    if (!box.hit || box.left < -1 || box.right > box.viewport + 1) {
      await page.screenshot({ path: `${output}/failure.png` });
      console.error(
        await page.evaluate(
          ({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return {
              html: hit?.outerHTML,
              rect: hit?.getBoundingClientRect().toJSON(),
              parent: hit?.parentElement?.outerHTML,
              parentRect: hit?.parentElement?.getBoundingClientRect().toJSON(),
            };
          },
          {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          },
        ),
      );
    }
    assert.ok(box.left >= -1 && box.right <= box.viewport + 1, `offscreen ${JSON.stringify(box)}`);
    assert.ok(box.hit, `occluded ${JSON.stringify(box)}`);
    assert.ok(box.width >= 43.5 && box.height >= 43.5, `small target ${JSON.stringify(box)}`);
  }
  return boxes;
}

try {
  for (const engine of [chromium, webkit]) {
    if (
      process.env.SUGGEST_COMPOSER_ENGINE &&
      process.env.SUGGEST_COMPOSER_ENGINE !== engine.name()
    )
      continue;
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      for (const theme of ['light', 'dark']) {
        if (process.env.SUGGEST_COMPOSER_THEME && process.env.SUGGEST_COMPOSER_THEME !== theme)
          continue;
        const context = await browser.newContext({
          viewport: { width: 393, height: 780 },
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
          await installNativeVisualModeInitScript(context);
          await installMaxBridgeShimInitScript(
            context,
            { platform: engine === webkit ? 'ios' : 'android' },
            { colorScheme: theme },
          );
          await context.route('**/src/main.tsx*', (route) =>
            route.fulfill({
              contentType: 'application/javascript',
              body: `import ${JSON.stringify(new URL('test/channel-suggestion-mobile.fixture.tsx', base).href)};`,
            }),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(base);
          const editor = page.getByRole('textbox', { name: 'Текст объявления', exact: true });
          await editor.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await page.evaluate((title) => window.suggestionLayoutTest.setTitle(title), title);
          await settleVisualFrame(page);
          const controls =
            '.channel-suggest-tabs button, .channel-suggest-composer__bar button, .channel-suggest-composer__bar label, .channel-suggest-composer__modifier-row button';
          await checkControls(page, controls);
          const background = await page
            .locator('.channel-dialog-screen--suggest')
            .evaluate((node) => getComputedStyle(node).backgroundColor);
          const destination = page.getByRole('button', {
            name: `Канал-получатель: ${title}`,
            exact: true,
          });
          await destination.click();
          assert.equal(await destination.getAttribute('aria-expanded'), 'true');
          const nameFits = await destination
            .locator('span')
            .first()
            .evaluate(
              (node) =>
                node.scrollHeight <= node.clientHeight + 1 &&
                node.scrollWidth <= node.clientWidth + 1,
            );
          assert.ok(nameFits, 'expanded channel name is readable');
          await destination.click();
          const draft = 'Объявление с фото.\nОписание товара и цена.\nПоследняя строка.';
          await editor.fill(draft);
          await editor.evaluate((node) => {
            const range = document.createRange();
            range.setStart(node.firstChild, 0);
            range.setEnd(node.firstChild, 10);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          });
          await page.getByRole('button', { name: 'Жирный', exact: true }).tap();
          assert.equal(await editor.locator('strong,b').first().innerText(), 'Объявление');
          await editor.blur();
          const photo = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 650;
            const paint = canvas.getContext('2d');
            paint.fillStyle = '#6295ab';
            paint.fillRect(0, 0, 300, 650);
            paint.fillStyle = '#efb99a';
            paint.fillRect(50, 150, 200, 350);
            const first = canvas.toDataURL('image/png').split(',')[1];
            paint.fillStyle = '#455268';
            paint.fillRect(60, 80, 170, 250);
            return [first, canvas.toDataURL('image/png').split(',')[1]];
          });
          await page.locator('input[type=file][accept="image/*"]').setInputFiles([
            { name: 'first.png', mimeType: 'image/png', buffer: Buffer.from(photo[0], 'base64') },
            { name: 'second.png', mimeType: 'image/png', buffer: Buffer.from(photo[1], 'base64') },
          ]);
          await page.getByRole('button', { name: 'Убрать first.png', exact: true }).waitFor();
          for (const viewport of [
            { width: 280, height: 740 },
            { width: 320, height: 568 },
            { width: 360, height: 780 },
            { width: 393, height: 780 },
            { width: 412, height: 852 },
            { width: 568, height: 320 },
            { width: 667, height: 320 },
          ]) {
            for (const font of [16, 32]) {
              await page.setViewportSize(viewport);
              await page.evaluate(
                (font) => (document.documentElement.style.fontSize = `${font}px`),
                font,
              );
              await applyNativeVisualMode(page, {
                safeTop: 0,
                safeBottom: viewport.width === 412 ? 24 : 0,
              });
              await page.locator('.channel-suggest-body').evaluate((node) => (node.scrollTop = 0));
              await settleVisualFrame(page);
              const boxes = await checkControls(page, controls);
              const geometry = await page.evaluate(() => {
                const toolbar = document
                  .querySelector('.channel-suggest-composer__modifier-row')
                  .getBoundingClientRect();
                const body = document
                  .querySelector('.channel-suggest-body')
                  .getBoundingClientRect();
                const editor = document.querySelector('.max-rich-text-editor__surface');
                return {
                  toolbar: toolbar.toJSON(),
                  body: body.toJSON(),
                  editorFont: parseFloat(getComputedStyle(editor).fontSize),
                };
              });
              assert.ok(geometry.body.top >= geometry.toolbar.bottom - 1, JSON.stringify(geometry));
              assert.ok(geometry.body.height >= 60, JSON.stringify(geometry));
              assert.equal(geometry.editorFont, font, 'text scaling reaches the editor');
              assert.equal(
                await page
                  .locator('.channel-dialog-screen--suggest')
                  .evaluate((node) => getComputedStyle(node).backgroundColor),
                background,
                'page background is preserved',
              );
              await destination.click();
              assert.equal(await destination.getAttribute('aria-expanded'), 'true');
              assert.equal(
                await page.locator('.channel-suggest-body').evaluate((node) => node.clientHeight),
                Math.round(geometry.body.height),
                'reading the recipient does not consume editor space',
              );
              await destination.press('Escape');
              assert.equal(await destination.getAttribute('aria-expanded'), 'false');
              results.push({ engine: engine.name(), theme, viewport, font, geometry, boxes });
            }
          }
          await page.setViewportSize({ width: 393, height: 780 });
          await page.evaluate(() => (document.documentElement.style.fontSize = '16px'));
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          const body = page.locator('.channel-suggest-body');
          for (const scroll of [0, 60, 100, 160]) {
            await body.evaluate((node, scroll) => (node.scrollTop = scroll), scroll);
            await settleVisualFrame(page);
            await checkControls(page, controls);
          }
          await page
            .getByRole('button', { name: 'Открыть фото 1', exact: true })
            .scrollIntoViewIfNeeded();
          await page.getByRole('button', { name: 'Открыть фото 1', exact: true }).click();
          const viewer = page.getByRole('dialog', { name: 'Просмотр фото', exact: true });
          await viewer.waitFor();
          await page.screenshot({ path: `${output}/${engine.name()}-${theme}-viewer.png` });
          await viewer.getByRole('button', { name: 'Увеличить фото', exact: true }).click();
          assert.equal(await viewer.locator('[data-zoomed]').getAttribute('data-zoomed'), 'true');
          await viewer.getByRole('button', { name: 'Следующее фото', exact: true }).click();
          assert.equal(await viewer.locator('[data-zoomed]').getAttribute('data-zoomed'), 'false');
          await page.keyboard.press('Escape');
          await viewer.waitFor({ state: 'detached' });
          assert.equal(
            await page
              .getByRole('button', { name: 'Открыть фото 1', exact: true })
              .evaluate((node) => document.activeElement === node),
            true,
          );
          await page.getByRole('button', { name: 'Переместить фото 1 позже', exact: true }).click();
          await page.getByRole('button', { name: 'Убрать second.png', exact: true }).click();
          assert.equal(await page.locator('.channel-suggest-composer__image-remove').count(), 1);
          await page.getByRole('tab', { name: 'Предпросмотр', exact: true }).click();
          await page.getByRole('button', { name: 'Открыть фото 1', exact: true }).click();
          await viewer.waitFor();
          await page.evaluate(async () => {
            const { runNativeBackHandlers } = await import('/app/src/lib/native-back.ts');
            return runNativeBackHandlers();
          });
          await viewer.waitFor({ state: 'detached' });
          await page.getByRole('tab', { name: 'Мои · 80+', exact: true }).click();
          assert.equal(await page.locator('.channel-suggest-composer__bar').isVisible(), false);
          await page.getByRole('tab', { name: 'Написать', exact: true }).click();
          assert.equal(await editor.innerText(), draft);
          assert.equal(await page.locator('.channel-suggest-composer__image-remove').count(), 1);
          await editor.focus();
          await page.setViewportSize({ width: 393, height: 480 });
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await settleVisualFrame(page);
          await checkControls(page, controls);
          await page.screenshot({ path: `${output}/${engine.name()}-${theme}-keyboard.png` });
          await editor.blur();
          await page.setViewportSize({ width: 393, height: 780 });
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await body.evaluate((node) => (node.scrollTop = 0));
          await page.screenshot({ path: `${output}/${engine.name()}-${theme}.png` });
          await page.getByRole('button', { name: 'Убрать first.png', exact: true }).click();
          await editor.fill('Первая строка');
          for (const width of [280, 320]) {
            for (const font of [16, 32]) {
              await editor.blur();
              await page.setViewportSize({ width, height: 360 });
              await page.evaluate(
                (size) => (document.documentElement.style.fontSize = `${size}px`),
                font,
              );
              await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
              await editor.focus();
              await page.waitForTimeout(400);
              await checkControls(
                page,
                '.channel-suggest-tabs button, .channel-suggest-composer__bar button, .channel-suggest-composer__bar label',
              );
              for (let button = 1; button <= 7; button++) {
                const selector = `.channel-suggest-composer__modifier-row button:nth-child(${button})`;
                await page.locator(selector).scrollIntoViewIfNeeded();
                await checkControls(page, selector);
              }
              await editor.focus();
              await page.waitForTimeout(400);
              const compact = await editor.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const body = node.closest('.channel-suggest-body').getBoundingClientRect();
                const style = getComputedStyle(node);
                const y =
                  rect.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
                return {
                  body: body.toJSON(),
                  editor: rect.toJSON(),
                  firstLine: node.contains(document.elementFromPoint(rect.left + 16, y)),
                };
              });
              assert.ok(compact.body.height >= 60 && compact.firstLine, JSON.stringify(compact));
              results.push({
                engine: engine.name(),
                theme,
                viewport: { width, height: 360 },
                font,
                compact,
              });
              await page.screenshot({
                path: `${output}/${engine.name()}-${theme}-compact-${width}-${font}.png`,
              });
            }
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(await page.evaluate(() => window.suggestionLayoutTest.sendRequests), []);
          console.log(
            `Suggestion composer ${engine.name()} ${theme}: long names, text scaling, media, scrolling, focus and native Back passed.`,
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
  await writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  await stopChildProcess(server);
}
