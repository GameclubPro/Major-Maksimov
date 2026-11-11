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
  ].filter(
    ([name]) =>
      !process.env.MINIAPP_VIDEO_TEST_PROFILE ||
      process.env.MINIAPP_VIDEO_TEST_PROFILE.split(',').includes(name),
  )) {
    const platform = name.startsWith('desktop')
      ? 'desktop'
      : name.startsWith('iphone')
        ? 'ios'
        : 'android';
    const context = await browser.newContext({ ...device, colorScheme, reducedMotion: 'reduce' });
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
      await context.addInitScript(() => {
        const revoke = URL.revokeObjectURL.bind(URL);
        window.__videoRevokedUrls = [];
        URL.revokeObjectURL = (url) => {
          window.__videoRevokedUrls.push(url);
          revoke(url);
        };
      });
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
        name: 'small.webm',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(
          await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 90;
            const graphics = canvas.getContext('2d');
            graphics.fillStyle = '#b9550b';
            graphics.fillRect(0, 0, 160, 90);
            const stream = canvas.captureStream(5);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
            const chunks = [];
            const completed = new Promise((resolve) => {
              recorder.ondataavailable = (event) => chunks.push(event.data);
              recorder.onstop = async () =>
                resolve(
                  Array.from(
                    new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()),
                  ),
                );
            });
            recorder.start();
            const frames = setInterval(() => graphics.fillRect(0, 0, 160, 90), 100);
            await new Promise((resolve) => setTimeout(resolve, 600));
            clearInterval(frames);
            recorder.stop();
            const result = await completed;
            stream.getTracks().forEach((track) => track.stop());
            return result;
          }),
        ),
      };
      await input.setInputFiles(smallVideo);
      await error.waitFor({ state: 'detached' });
      const selected = page.locator('.publication-retained-media');
      await selected.waitFor({ state: 'visible' });
      assert.match(await selected.textContent(), /small.webm/u);
      assert.equal(await input.getAttribute('aria-invalid'), null);
      const previewOpener = selected.getByRole('button', {
        name: 'Посмотреть видео: small.webm',
        exact: true,
      });
      await previewOpener.waitFor();
      const localUrl = await selected.locator('video').getAttribute('src');
      assert.match(localUrl, /^blob:/u);
      const uploadsBeforePreview = binaryRequests;
      await previewOpener.click();
      const previewDialog = page.getByRole('dialog', { name: 'Видео: small.webm', exact: true });
      const player = previewDialog.locator('video');
      await player.waitFor();
      await page.waitForFunction(
        () => {
          const video = document.querySelector('.publication-video-preview video');
          return (
            video?.readyState >= 1 ||
            video?.error ||
            document.querySelector('.publication-video-preview [role="status"]')
          );
        },
        undefined,
        { timeout: 10_000 },
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-metadata.png`) });
      assert.equal(
        await previewDialog.getByRole('status').count(),
        0,
        `Real fixture must decode: ${await previewDialog.innerText()}`,
      );
      assert.deepEqual(
        await player.evaluate((video) => ({
          controls: video.controls,
          paused: video.paused,
          width: video.videoWidth,
          height: video.videoHeight,
        })),
        { controls: true, paused: true, width: 160, height: 90 },
      );
      const playerHandle = await player.elementHandle();
      await player.evaluate((video) => {
        void video.play();
      });
      await page.waitForFunction(
        () => document.querySelector('.publication-video-preview video')?.currentTime >= 0.1,
        undefined,
        { timeout: 10_000 },
      );
      const previewBox = await previewDialog.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(
        previewBox.x >= 0 &&
          previewBox.y >= 0 &&
          previewBox.x + previewBox.width <= viewport.width + 1 &&
          previewBox.y + previewBox.height <= viewport.height + 1,
      );
      await player.focus();
      await player.press('Tab');
      assert.equal(
        await previewDialog
          .getByRole('button', { name: 'Закрыть видео', exact: true })
          .evaluate((button) => button === document.activeElement),
        true,
      );
      await player.focus();
      await page.screenshot({ path: path.join(screenshots, `${name}-preview.png`) });
      await page.keyboard.press('Escape');
      await previewDialog.waitFor({ state: 'detached' });
      assert.equal(
        await playerHandle.evaluate((video) => video.paused),
        true,
        'Closing the preview must stop playback',
      );
      assert.equal(
        await previewOpener.evaluate((button) => button === document.activeElement),
        true,
      );
      assert.equal(await page.locator('.publications-page.is-editor').count(), 1);
      await previewOpener.click();
      await previewDialog.waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await previewDialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.publications-page.is-editor').count(), 1);
      assert.equal(
        binaryRequests,
        uploadsBeforePreview,
        'Preview controls must not upload or send',
      );
      await page.locator('.publication-target-picker__summary').click();
      const targetPicker = page.getByRole('dialog', { name: 'Получатели', exact: true });
      await targetPicker
        .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
        .click();
      await targetPicker
        .getByRole('button', { name: 'Завершить выбор получателей', exact: true })
        .click();
      await page.getByRole('button', { name: 'Проверить пост', exact: true }).click();
      const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
      const reviewPlayer = review.locator('video');
      await reviewPlayer.waitFor();
      assert.equal(
        await reviewPlayer.getAttribute('src'),
        localUrl,
        'Final review must use the same freshly selected video',
      );
      await page.waitForFunction(
        () => document.querySelector('.publication-review-sheet video')?.readyState >= 1,
        undefined,
        { timeout: 10_000 },
      );
      assert.equal(await reviewPlayer.evaluate((video) => video.videoWidth), 160);
      await page.screenshot({ path: path.join(screenshots, `${name}-review.png`) });
      await page.keyboard.press('Escape');
      await review.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.publications-page.is-editor').count(), 1);

      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });
      assert.match(
        await selected.textContent(),
        /small.webm/u,
        'Failed replacement must keep the previous video',
      );
      assert.match(await editor.textContent(), /regression edited/u);
      assert.equal(
        await selected.locator('video').getAttribute('src'),
        localUrl,
        'Invalid replacement must preserve the local preview',
      );

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
      await page.waitForFunction((url) => window.__videoRevokedUrls.includes(url), localUrl);
      const replacementUrl = await selected.locator('video').getAttribute('src');
      await page.locator('.publication-video-upload').waitFor({ state: 'detached' });
      binaryMode = 'failure';
      await input.setInputFiles(smallVideo);
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('MAX не принял'),
      );
      assert.match(await selected.textContent(), /small.webm/u);
      assert.equal(
        await selected.locator('video').getAttribute('src'),
        replacementUrl,
        'Upload failure must preserve preview',
      );
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
      assert.match(await selected.textContent(), /small.webm/u);
      assert.equal(
        await selected.locator('video').getAttribute('src'),
        replacementUrl,
        'Cancelled upload must preserve preview',
      );
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
      await page.waitForFunction((url) => window.__videoRevokedUrls.includes(url), replacementUrl);
      const largeUrl = await selected.locator('video').getAttribute('src');
      await selected
        .getByRole('button', { name: 'Посмотреть видео: 36mb.mp4', exact: true })
        .click();
      const unavailable = page.getByRole('dialog', { name: 'Видео: 36mb.mp4', exact: true });
      await unavailable.getByRole('status').waitFor();
      assert.match(await unavailable.innerText(), /Файл остаётся в публикации/u);
      await unavailable.getByRole('button', { name: 'Закрыть видео', exact: true }).click();
      await unavailable.waitFor({ state: 'detached' });
      assert.match(await selected.innerText(), /36mb.mp4/u);

      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.publications-page.is-editor').waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).searchParams.has('compose'), false);
      await page.waitForFunction((url) => window.__videoRevokedUrls.includes(url), largeUrl);
      await page.goto(baseUrl + 'publications?preview=1&profile=publisher&compose=1');
      await editor.waitFor();
      await applyNativeVisualMode(page, {
        safeTop: name.startsWith('iphone') ? 59 : name.startsWith('android') ? 24 : 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      await page.waitForFunction(() =>
        document.querySelector('.publication-retained-media')?.textContent.includes('36mb.mp4'),
      );
      assert.match(await editor.textContent(), /regression edited/u);
      const longName = 'Очень длинное название видео '.repeat(5).slice(0, 122) + '.webm';
      await input.setInputFiles({ ...smallVideo, name: longName });
      const longOpener = selected.getByRole('button', {
        name: `Посмотреть видео: ${longName}`,
        exact: true,
      });
      await longOpener.waitFor();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      await longOpener.click();
      const longDialog = page.getByRole('dialog', { name: `Видео: ${longName}`, exact: true });
      const longClose = longDialog.getByRole('button', { name: 'Закрыть видео', exact: true });
      const longCloseBox = await longClose.boundingBox();
      assert.ok(
        longCloseBox.y >= 0 &&
          longCloseBox.y + longCloseBox.height <= page.viewportSize().height &&
          longCloseBox.height >= 44,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-long-name-200pct.png`) });
      await longClose.click();
      await longDialog.waitFor({ state: 'detached' });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
      const removedUrl = await selected.locator('video').getAttribute('src');
      await selected.getByRole('button', { name: 'Убрать видео', exact: true }).click();
      await selected.waitFor({ state: 'detached' });
      await page.waitForFunction((url) => window.__videoRevokedUrls.includes(url), removedUrl);
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
