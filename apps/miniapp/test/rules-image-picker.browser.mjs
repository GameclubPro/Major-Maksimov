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
import { setPhoneKeyboard } from '../../../scripts/miniapp-smartphone.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-rules-image-'));
let browser;

async function holdDecoder(page) {
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    window.createImageBitmap = (...args) =>
      new Promise((resolve, reject) => {
        window.releaseImageDecoder = () => {
          window.createImageBitmap = original;
          original(...args).then(resolve, reject);
        };
      });
  });
}

async function releaseDecoder(page) {
  await page.waitForFunction(() => typeof window.releaseImageDecoder === 'function');
  await page.evaluate(() => {
    window.releaseImageDecoder();
    delete window.releaseImageDecoder;
  });
}

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
    ['android-light', devices['Pixel 7'], 'light', 'android'],
    ['android-dark', devices['Pixel 7'], 'dark', 'android'],
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light', 'web'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${baseUrl}chat/preview-chat/settings?preview=1&focus=rules`);
      await page.locator('.rules-content-composer').waitFor();
      await applyNativeVisualMode(page, {
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
      });

      const pixels = await page.evaluate(async () => {
        const { prepareBroadcastImage } = await import('/app/src/lib/broadcast-image.ts');
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e53546';
        ctx.fillRect(40, 0, 40, 40);
        const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const webp = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp'));
        const inspect = async (prepared) => {
          const img = new Image();
          img.src = `data:${prepared.mimeType};base64,${prepared.base64}`;
          await img.decode();
          ctx.clearRect(0, 0, 80, 40);
          ctx.drawImage(img, 0, 0);
          return Array.from(ctx.getImageData(10, 10, 1, 1).data);
        };
        const transparent = await prepareBroadcastImage(
          new File([png], 'native-photo', { type: 'application/octet-stream' }),
        );
        const alpha = (await inspect(transparent))[3];
        const Offscreen = window.OffscreenCanvas;
        window.OffscreenCanvas = class extends Offscreen {
          convertToBlob() {
            return Promise.reject(new Error('WebView encoder failed'));
          }
        };
        let fallback;
        try {
          fallback = await prepareBroadcastImage(
            new File([webp], 'photo.webp', { type: 'image/webp' }),
          );
        } finally {
          window.OffscreenCanvas = Offscreen;
        }
        const background = await inspect(fallback);
        const originalBitmap = window.createImageBitmap;
        window.createImageBitmap = () => Promise.reject(new Error('unsupported bitmap'));
        let htmlDecoded;
        try {
          htmlDecoded = await prepareBroadcastImage(new File([webp], 'photo.webp'));
        } finally {
          window.createImageBitmap = originalBitmap;
        }
        const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
        return {
          alpha,
          background,
          fallbackMime: fallback.mimeType,
          htmlMime: htmlDecoded.mimeType,
          jpegBase64: btoa(String.fromCharCode(...new Uint8Array(await jpeg.arrayBuffer()))),
        };
      });
      assert.equal(pixels.alpha, 0, 'PNG transparency must survive');
      assert.deepEqual(
        pixels.background,
        [255, 255, 255, 255],
        'JPEG transparency must flatten onto white',
      );
      assert.equal(pixels.fallbackMime, 'image/jpeg');
      assert.equal(pixels.htmlMime, 'image/jpeg');

      const photo = {
        name: `${'long-name-'.repeat(20)}.jpg`,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(pixels.jpegBase64, 'base64'),
      };
      const input = page.locator('.rules-content-composer input[type="file"]');
      const editor = page.getByRole('textbox', { name: 'Текст правил', exact: true });
      const save = page.locator('.rules-publish-bar__save');
      const publish = page.getByRole('button', { name: 'Опубликовать в чат', exact: true });
      await editor.fill('Правила с фотографией. Текст сохраняется при ошибке.');
      if (platform !== 'web') {
        await editor.focus();
        const mode = platform === 'ios' ? 'visual' : 'resize';
        await setPhoneKeyboard(page, { mode, height: 260 });
        await page.waitForTimeout(900);
        assert.equal(await editor.evaluate((node) => node === document.activeElement), true);
        await editor.scrollIntoViewIfNeeded();
        assert.equal(
          await editor.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.top < visualViewport.height + visualViewport.offsetTop &&
              rect.bottom > visualViewport.offsetTop
            );
          }),
          true,
        );
        await page.screenshot({ path: path.join(screenshots, `${name}-keyboard.png`) });
        await setPhoneKeyboard(page, { mode, open: false });
      }
      await input.setInputFiles({
        name: 'empty.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.alloc(0),
      });
      const error = page.locator('.rules-content-composer [role="alert"]');
      await error.waitFor();
      assert.match(await error.textContent(), /Файл фото пустой/u);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await input.getAttribute('aria-describedby'), await error.getAttribute('id'));
      await input.setInputFiles([]);
      assert.equal(await error.isVisible(), true);
      await editor.fill('Правила с фотографией. Текст сохраняется при ошибке. Дополнение.');
      await page.waitForTimeout(1000);
      assert.equal(
        await error.isVisible(),
        true,
        'Autosave and server hydration must not erase a failed selection',
      );
      await error.scrollIntoViewIfNeeded();
      assert.equal(
        await error.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.getBoundingClientRect().right <= innerWidth,
        ),
        true,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-error.png`) });

      await editor.fill('Правила с фотографией. Текст сохраняется при ошибке. Новая версия.');
      await holdDecoder(page);
      await input.setInputFiles(photo);
      await page.getByRole('button', { name: 'Отменить подготовку фото', exact: true }).waitFor();
      assert.equal(await save.isDisabled(), true);
      assert.equal(await publish.isDisabled(), true);
      await page.waitForTimeout(800);
      assert.equal(await save.isDisabled(), true, 'Autosave must not race image preparation');
      assert.equal(await error.count(), 0);
      await page.getByRole('button', { name: 'Отменить подготовку фото', exact: true }).click();
      await releaseDecoder(page);
      await page.waitForFunction(
        () =>
          document.querySelector('.rules-content-composer')?.getAttribute('aria-busy') !== 'true',
      );
      assert.equal(await page.locator('.rules-content-composer img').count(), 0);
      assert.equal(await publish.isEnabled(), true);

      await holdDecoder(page);
      await input.setInputFiles(photo);
      await page.getByRole('button', { name: 'Отменить подготовку фото', exact: true }).waitFor();
      await releaseDecoder(page);
      const image = page.locator('.rules-content-composer .broadcast-message-card__image');
      await image.waitFor();
      await page.waitForFunction(
        () => document.querySelector('.rules-content-composer img')?.naturalWidth > 0,
      );
      assert.match(await editor.textContent(), /Текст сохраняется/u);
      await save.click();
      await page.getByText('Черновик правил сохранён', { exact: true }).waitFor();
      // FLAG: Publication interactions are restricted to preview transport and local origin.
      assert.equal(new URL(page.url()).searchParams.get('preview'), '1');
      await publish.click();
      await page.getByText('Новый пост правил опубликован', { exact: true }).waitFor();
      await page
        .locator('.toast__close')
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      await image.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-attached.png`) });
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.settings-drilldown__panel--rules').waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname.endsWith('/settings'), true);

      await page.goto(`${baseUrl}chat/preview-chat/settings?preview=1&focus=links`);
      const links = page.locator('.settings-drilldown__panel--links');
      const sanctionsSummary = links
        .locator('summary')
        .filter({ hasText: /^Наказания и сообщения$/u });
      const sanctions = sanctionsSummary.locator('..');
      await sanctionsSummary.click();
      assert.equal(await sanctions.evaluate((element) => element.open), true);
      const explanation = sanctions.getByLabel('Включить объяснение для модерации ссылок');
      await explanation.check();
      const openEditor = sanctions.getByRole('button', {
        name: 'Редактировать текст сообщения о ссылках',
        exact: true,
      });
      await openEditor.click();
      const sheet = page.locator('.bot-message-editor-sheet__panel');
      const sheetInput = sheet.locator('input[type="file"]');
      await sheetInput.setInputFiles({
        name: 'empty.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.alloc(0),
      });
      await sheet.getByRole('alert').waitFor();
      await sheet.getByRole('alert').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-sheet-error.png`) });
      await holdDecoder(page);
      await sheetInput.setInputFiles(photo);
      await page.waitForFunction(
        () =>
          document.querySelector('.bot-message-editor-sheet__media')?.getAttribute('aria-busy') ===
          'true',
      );
      assert.equal(
        await sheet.getByRole('button', { name: 'Готово', exact: true }).isDisabled(),
        true,
      );
      await sheet.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
      await releaseDecoder(page);
      await openEditor.click();
      assert.equal(
        await sheet.locator('img').count(),
        0,
        'Closed editor must discard late results',
      );
      await sheetInput.setInputFiles(photo);
      await sheet.locator('img').waitFor();
      await sheetInput.setInputFiles({
        name: 'empty.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.alloc(0),
      });
      await sheet.getByRole('alert').waitFor();
      assert.equal(
        await sheet.locator('img').count(),
        1,
        'Failed replacement must preserve the previous image',
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: pixels, fallback decoders, native MIME, error, retry, cancellation, save/publish gating, editor close, preview publication`,
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
