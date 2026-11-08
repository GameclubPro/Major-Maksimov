import assert from 'node:assert/strict';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { setPhoneKeyboard } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-video-picker-'));
const oversizedPath = path.join(screenshots, 'oversized.mp4');
const oversizedFile = await open(oversizedPath, 'wx');
await oversizedFile.truncate(100_000_001);
await oversizedFile.close();
let browser;

async function assertMediaPickerClicks(page, platform) {
  assert.equal(await page.evaluate(() => document.documentElement.dataset.maxPlatform), platform);
  const photoInput = page.locator('.broadcast-content-composer__file-input');
  assert.equal(
    await photoInput.evaluate((input) =>
      input.classList.contains('broadcast-content-composer__file-input--native'),
    ),
    platform === 'android',
    'Exercise the actual photo picker branch for this platform',
  );
  for (const [tool, input, multiple] of [
    [page.locator('.broadcast-content-composer__tool[title="Добавить фото"]'), photoInput, true],
    [page.locator('.publication-video-tool'), page.locator('.publication-video-tool input'), false],
  ]) {
    await tool.scrollIntoViewIfNeeded();
    const bounds = await tool.boundingBox();
    assert.ok(bounds);
    for (const position of [
      { x: bounds.width / 2, y: bounds.height / 2 },
      { x: 6, y: 6 },
      { x: bounds.width / 2, y: bounds.height - 8 },
    ]) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        tool.click({ position, timeout: 5000 }),
      ]);
      assert.equal(
        await input.evaluate((element, chosen) => element === chosen, chooser.element()),
        true,
      );
      assert.equal(chooser.isMultiple(), multiple);
      await chooser.setFiles([]);
    }
  }
  assert.equal(await page.locator('.publication-video-error').count(), 0);
  assert.equal(await page.locator('.publication-retained-media').count(), 0);
}

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme] of [
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light'],
    ['desktop-dark', { viewport: { width: 1280, height: 900 } }, 'dark'],
    ['desktop-compact', { viewport: { width: 390, height: 768 } }, 'light'],
    ['iphone-light', devices['iPhone 15'], 'light'],
    ['iphone-dark', devices['iPhone 15'], 'dark'],
    ['android-light', devices['Pixel 7'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
    ['iphone-se-light', devices['iPhone SE'], 'light'],
  ]) {
    const platform = name.startsWith('desktop')
      ? 'desktop'
      : name.startsWith('iphone')
        ? 'ios'
        : 'android';
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      let binaryMode = 'success';
      let binaryRequests = 0;
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'preview.okcdn.ru') {
          if (route.request().method() === 'POST') binaryRequests += 1;
          if (binaryMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2000));
          return route
            .fulfill({
              status: binaryMode === 'failure' ? 503 : 200,
              body: '',
              headers: {
                'access-control-allow-origin': new URL(baseUrl).origin,
                'access-control-allow-methods': 'POST, OPTIONS',
                'access-control-allow-headers': '*',
              },
            })
            .catch(() => undefined);
        }
        return url.origin === new URL(baseUrl).origin ? route.continue() : route.abort();
      });
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const previewDevice = name.startsWith('iphone-se')
        ? 'iphone-se'
        : platform === 'ios'
          ? 'iphone'
          : 'android';
      await page.goto(
        `${baseUrl}publications?preview=1&profile=publisher&compose=1&device=${previewDevice}`,
      );
      const input = page.locator('.publication-video-tool input');
      await input.waitFor();
      await applyNativeVisualMode(page, {
        safeTop: name.startsWith('iphone') ? 59 : name.startsWith('android') ? 24 : 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      // FLAG: Preview presets are mobile-only. Synchronize from the explicit Bridge platform
      // so desktop scenarios exercise the programmatic photo picker, too.
      await page.evaluate(async () => {
        const { syncMaxNativeEnvironment } = await import('/app/src/lib/max-bridge.ts');
        syncMaxNativeEnvironment();
      });
      const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
      await editor.fill('Video attachment regression');
      await editor.fill('');
      await assertMediaPickerClicks(page, platform);
      await editor.fill('Video attachment regression');
      await assertMediaPickerClicks(page, platform);
      assert.equal(binaryRequests, 0, 'Opening a picker and empty selection must not upload media');
      if (name.startsWith('iphone') || name.startsWith('android')) {
        await editor.focus();
        const mode = name.startsWith('iphone') ? 'visual' : 'resize';
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
        await page.screenshot({ path: path.join(screenshots, name + '-keyboard.png') });
        await setPhoneKeyboard(page, { mode, open: false });
      }
      const error = page.locator('.publication-video-error');
      const tooLarge = oversizedPath;
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });
      assert.match(await error.textContent(), /Максимум 100 МБ/u);
      assert.equal(binaryRequests, 0);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.ok(
        (await input.getAttribute('aria-describedby')).includes(await error.getAttribute('id')),
      );
      await page.waitForTimeout(3500);
      assert.equal(await error.isVisible(), true, 'Error must outlive the old toast timeout');
      await editor.fill('Video attachment regression edited');
      assert.equal(await error.isVisible(), true, 'Editing text must not erase the media error');
      await input.setInputFiles([]);
      assert.equal(await error.isVisible(), true, 'Cancelling the picker must preserve the error');
      await error.scrollIntoViewIfNeeded();
      const layout = await error.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          fits:
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            element.scrollWidth <= element.clientWidth,
          unobscured: element.contains(
            document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
          ),
        };
      });
      assert.deepEqual(layout, { fits: true, unobscured: true });
      await page.screenshot({ path: path.join(screenshots, `${name}-error.png`) });
      assert.equal(await input.inputValue(), '');
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });

      const smallVideo = {
        name: 'small.mp4',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('video'),
      };
      await input.setInputFiles(smallVideo);
      await error.waitFor({ state: 'detached' });
      const selected = page.locator('.publication-retained-media');
      await selected.waitFor({ state: 'visible' });
      assert.match(await selected.textContent(), /small.mp4/u);
      assert.equal(await input.getAttribute('aria-invalid'), null);
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });
      assert.match(
        await selected.textContent(),
        /small.mp4/u,
        'Failed replacement must keep the previous video',
      );
      assert.match(await editor.textContent(), /regression edited/u);

      await input.setInputFiles({
        name: 'empty.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(0),
      });
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('Видео пустое'),
      );
      await input.setInputFiles(smallVideo);
      await error.waitFor({ state: 'detached' });
      await selected.waitFor({ state: 'visible' });
      await page.locator('.publication-video-upload').waitFor({ state: 'detached' });
      binaryMode = 'failure';
      await input.setInputFiles(smallVideo);
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('MAX не принял'),
      );
      assert.match(await selected.textContent(), /small.mp4/u);
      binaryMode = 'slow';
      await input.setInputFiles(smallVideo);
      await page.getByRole('button', { name: 'Отменить загрузку видео', exact: true }).waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      assert.equal(
        await page.locator('.publications-page.is-editor').count(),
        1,
        'Native Back must respect the pending upload',
      );
      await page.getByRole('button', { name: 'Отменить загрузку видео', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('отменена'),
      );
      assert.match(await selected.textContent(), /small.mp4/u);
      binaryMode = 'success';
      await input.setInputFiles({
        name: '36mb.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(36_000_000),
      });
      await page.waitForFunction(() =>
        document.querySelector('.publication-retained-media')?.textContent.includes('36mb.mp4'),
      );
      assert.equal(await error.count(), 0);
      assert.equal(
        await page.getByRole('button', { name: 'Убрать видео', exact: true }).count(),
        1,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-attached.png`) });
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.publications-page.is-editor').waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).searchParams.has('compose'), false);
      await page.goto(baseUrl + 'publications?preview=1&profile=publisher&compose=1');
      await editor.waitFor();
      await page.waitForFunction(() =>
        document.querySelector('.publication-retained-media')?.textContent.includes('36mb.mp4'),
      );
      assert.match(await editor.textContent(), /regression edited/u);
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name} (${platform}): photo/video pointer clicks and reopen, 36 MB direct upload, 100 MB limit, persistent error, cancel, retry, generic MIME, empty, keyboard, native Back and restored draft`,
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
