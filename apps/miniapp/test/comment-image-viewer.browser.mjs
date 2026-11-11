import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-image-viewer-'));
const profiles = [
  {
    name: 'small',
    viewport: { width: 320, height: 568 },
    platform: 'ios',
    safeTop: 20,
    safeBottom: 0,
  },
  {
    name: 'iphone',
    viewport: { width: 393, height: 852 },
    platform: 'ios',
    safeTop: 59,
    safeBottom: 34,
  },
  {
    name: 'android',
    viewport: { width: 412, height: 915 },
    platform: 'android',
    safeTop: 24,
    safeBottom: 24,
  },
  {
    name: 'landscape',
    viewport: { width: 667, height: 320 },
    platform: 'android',
    safeTop: 0,
    safeBottom: 0,
  },
];

let touchSession;
let activePoints;
async function pointer(page, type, id, x, y) {
  if (touchSession) {
    if (type === 'pointercancel') activePoints.clear();
    else if (type === 'pointerup') activePoints.delete(id);
    else activePoints.set(id, { id, x, y });
    await touchSession.send('Input.dispatchTouchEvent', {
      type:
        type === 'pointerdown'
          ? 'touchStart'
          : type === 'pointerup'
            ? 'touchEnd'
            : type === 'pointercancel'
              ? 'touchCancel'
              : 'touchMove',
      touchPoints: [...activePoints.values()],
    });
    return;
  }
  // WebKit exposes no touch dispatch API in Playwright. Exercise its PointerEvent
  // handling without capture; Chromium above also verifies trusted touch/capture.
  await page.locator('.channel-dialog-image-viewer__frame').evaluate((element) => {
    element.setPointerCapture = () => {};
    element.hasPointerCapture = () => false;
  });
  await page.locator('.channel-dialog-image-viewer__frame').dispatchEvent(type, {
    pointerId: id,
    pointerType: 'touch',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
  if (
    process.env.MINIAPP_TEST_ENGINES &&
    !process.env.MINIAPP_TEST_ENGINES.split(',').includes(engine)
  )
    continue;
  const browser = await browserType.launch(captureBrowserLaunchOptions(engine, base));
  try {
    for (const profile of profiles)
      for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: profile.viewport,
          hasTouch: true,
          colorScheme,
          locale: 'ru-RU',
          reducedMotion: 'reduce',
        });
        await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
          route.fulfill({ body: '' }),
        );
        await context.route('**/src/main.tsx', (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
          }),
        );
        await installMaxBridgeShimInitScript(context, profile, { colorScheme });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        touchSession = engine === 'chromium' ? await context.newCDPSession(page) : null;
        activePoints = new Map();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.goto(base);
          await page.locator('.channel-dialog-message').first().waitFor();
          await applyNativeVisualMode(page, profile);
          const id = await page.locator('[data-message-id]').last().getAttribute('data-message-id');
          await page.evaluate(async (messageId) => {
            const attachments = [0, 1].map((index) => {
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="${index ? '#e99d48' : '#3974ad'}"/><circle cx="600" cy="450" r="220" fill="white"/><text x="580" y="470" font-size="72">${index + 1}</text></svg>`;
              const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
              return {
                kind: 'image',
                url,
                previewUrl: url,
                fileName: `Фото ${index + 1}`,
                width: 1200,
                height: 900,
              };
            });
            await window.commentTest.updateMessage(messageId, { attachments });
          }, id);
          const opener = page.getByRole('button', { name: 'Фото 1', exact: true });
          await opener.click();
          const dialog = page.getByRole('dialog', { name: 'Просмотр фото', exact: true });
          await dialog.waitFor();
          const frame = dialog.locator('.channel-dialog-image-viewer__frame');
          const image = frame.locator('img');
          await image.evaluate((element) => element.decode());
          await image.click();
          assert.ok(await dialog.isVisible(), 'tapping the photo must keep it open');
          await dialog.getByRole('button', { name: 'Увеличить фото', exact: true }).click();
          assert.equal(await frame.getAttribute('data-zoomed'), 'true');
          const bounds = await frame.boundingBox();
          const x = bounds.x + bounds.width / 2,
            y = bounds.y + bounds.height / 2;
          await pointer(page, 'pointerdown', 11, x, y);
          await pointer(page, 'pointermove', 11, x + 80, y + 60);
          await pointer(page, 'pointerup', 11, x + 80, y + 60);
          const pan = await image.evaluate((element) => {
            const matrix = new DOMMatrix(getComputedStyle(element).transform);
            return { x: matrix.e, y: matrix.f };
          });
          assert.ok(pan.x > 0 || pan.y > 0, 'zoomed image can be moved');
          assert.equal(
            await dialog.locator('.channel-dialog-image-viewer__counter').textContent(),
            '1 / 2',
            'pan must not change photo',
          );
          await dialog
            .getByRole('button', { name: 'Вернуть исходный масштаб', exact: true })
            .click();
          assert.equal(await frame.getAttribute('data-zoomed'), 'false');
          await pointer(page, 'pointerdown', 12, x + 55, y);
          await pointer(page, 'pointermove', 12, x - 55, y + 5);
          await pointer(page, 'pointerup', 12, x - 55, y + 5);
          assert.equal(
            await dialog.locator('.channel-dialog-image-viewer__counter').textContent(),
            '2 / 2',
          );
          await frame.locator('img').evaluate((element) => element.decode());
          await pointer(page, 'pointerdown', 21, x - 30, y);
          await pointer(page, 'pointerdown', 22, x + 30, y);
          await pointer(page, 'pointermove', 21, x - 70, y);
          await pointer(page, 'pointermove', 22, x + 70, y);
          await pointer(page, 'pointerup', 21, x - 70, y);
          await pointer(page, 'pointerup', 22, x + 70, y);
          assert.equal(await frame.getAttribute('data-zoomed'), 'true', 'pinch increases scale');
          assert.equal(
            await dialog.locator('.channel-dialog-image-viewer__counter').textContent(),
            '2 / 2',
            'pinch must not turn into swipe',
          );
          await dialog.getByRole('button', { name: 'Предыдущее фото', exact: true }).click();
          assert.equal(
            await frame.getAttribute('data-zoomed'),
            'false',
            'changing photo resets scale and pan',
          );
          await pointer(page, 'pointerdown', 31, x + 55, y);
          await pointer(page, 'pointermove', 31, x - 55, y);
          await pointer(page, 'pointercancel', 31, x - 55, y);
          assert.equal(
            await dialog.locator('.channel-dialog-image-viewer__counter').textContent(),
            '1 / 2',
            'cancelled gesture must not navigate',
          );
          for (let tap = 0; tap < 2; tap++) {
            await pointer(page, 'pointerdown', 41, x, y);
            await pointer(page, 'pointerup', 41, x, y);
          }
          assert.equal(
            await frame.getAttribute('data-zoomed'),
            'true',
            'double tap increases scale',
          );
          const geometry = await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
              right: rect.right,
              bottom: rect.bottom,
              width: innerWidth,
              height: innerHeight,
              overflow: element.scrollWidth - element.clientWidth,
            };
          });
          assert.ok(
            geometry.right <= geometry.width + 1 &&
              geometry.bottom <= geometry.height + 1 &&
              geometry.overflow <= 1,
            JSON.stringify(geometry),
          );
          await page.screenshot({
            path: path.join(output, `${engine}-${profile.name}-${colorScheme}.png`),
          });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
          assert.ok(
            await opener.evaluate((element) => element === document.activeElement),
            'closing restores opener focus',
          );
          await opener.click();
          await dialog.waitFor();
          await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
          await dialog.waitFor({ state: 'hidden' });
          assert.deepEqual(errors, []);
          console.log(
            `PASS ${engine} ${profile.name} ${colorScheme}: tap, zoom, pan, swipe, pinch, reset, bounds, close and focus`,
          );
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
}
console.log(`Screenshots: ${output}`);
