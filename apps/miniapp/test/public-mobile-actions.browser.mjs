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
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

async function contextFor(browser, base, { width, height, theme, platform }, bridge = true) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  if (bridge) await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
  await installNativeVisualModeInitScript(context);
  return context;
}
async function target44(locator) {
  await locator.evaluate((node) =>
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
  );
  await settleVisualFrame(locator.page());
  const metric = await locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const points = [
      [r.x + 2, r.y + r.height / 2],
      [r.right - 2, r.y + r.height / 2],
      [r.x + r.width / 2, r.y + 2],
      [r.x + r.width / 2, r.bottom - 2],
    ];
    return {
      width: r.width,
      height: r.height,
      rect: r.toJSON(),
      hits: points.map(([x, y]) => ({
        x,
        y,
        element: document.elementFromPoint(x, y)?.outerHTML.slice(0, 180),
      })),
      hit: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
    };
  });
  assert.ok(metric.width >= 43.9 && metric.height >= 43.9 && metric.hit, JSON.stringify(metric));
}
async function checkCommentSheetLoading({ browser, base, profile, output, tag }) {
  for (const action of ['cancel', 'back', 'failure']) {
    const context = await contextFor(browser, base, profile);
    let release;
    let requested = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await context.route('**/src/main.tsx*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
        }),
      );
      let firstRequest = true;
      await context.route('**/src/components/ui/action-confirm-sheet.tsx*', async (route) => {
        requested = true;
        if (action === 'failure' && firstRequest) {
          firstRequest = false;
          return route.abort();
        }
        await gate;
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      await page.goto(base);
      const bubble = page.locator('.channel-dialog-message__bubble').last();
      await bubble.waitFor();
      assert.equal(requested, false, 'cold comments do not import delete confirmation');
      await bubble.press('Enter');
      await page
        .getByRole('dialog', { name: 'Действия с комментарием', exact: true })
        .getByRole('button', { name: 'Удалить', exact: true })
        .click();
      const sheet = page.getByRole('dialog', { name: 'Удалить комментарий?', exact: true });
      await sheet.waitFor();
      if (action === 'failure') {
        await sheet
          .getByRole('alert')
          .filter({ hasText: 'Не удалось открыть подтверждение.' })
          .waitFor();
        assert.equal(await sheet.getByRole('button', { name: 'Удалить', exact: true }).count(), 0);
        await page.screenshot({ path: `${output}/${tag}-delete-load-failure.png` });
        assert.deepEqual(await page.evaluate(() => window.commentTest.deleteRequests), []);
        release();
        await Promise.all([
          page.waitForEvent('domcontentloaded'),
          sheet.getByRole('button', { name: 'Обновить', exact: true }).click(),
        ]);
        await bubble.waitFor();
        assert.deepEqual(await page.evaluate(() => window.commentTest.deleteRequests), []);
        await bubble.press('Enter');
        await page
          .getByRole('dialog', { name: 'Действия с комментарием', exact: true })
          .getByRole('button', { name: 'Удалить', exact: true })
          .click();
        await sheet.getByRole('button', { name: 'Удалить', exact: true }).waitFor();
        await sheet.getByRole('button', { name: 'Отмена', exact: true }).click();
      } else {
        await sheet.getByRole('status').filter({ hasText: 'Открываем…' }).waitFor();
        if (action === 'cancel')
          await sheet.getByRole('button', { name: 'Отмена', exact: true }).click();
        else await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await sheet.waitFor({ state: 'detached' });
        release();
        await settleVisualFrame(page);
      }
      await sheet.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.commentTest.deleteRequests), []);
      await page.waitForFunction(() =>
        document.activeElement?.classList.contains('channel-dialog-message__bubble'),
      );
      assert.equal(
        await page.evaluate(() => Boolean(window.__MAXIM_VISUAL_BRIDGE_CLOSED__)),
        false,
      );
    } finally {
      release();
      await context.close();
    }
  }
}
export async function runPublicMobileChecks({
  browser,
  base,
  output,
  profile = { width: 320, height: 504, theme: 'dark', platform: 'ios' },
}) {
  const tag = `${browser.browserType().name()}-${profile.width}-${profile.theme}`;
  await checkCommentSheetLoading({ browser, base, profile, output, tag });
  for (const bridge of [false, true]) {
    const context = await contextFor(browser, base, profile, bridge);
    try {
      await context.addInitScript(() =>
        localStorage.setItem('maxim:last-channel-entity-id', 'remembered-managed'),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      for (const kind of ['suggest', 'comments']) {
        await page.goto(`${base}channel/preview-channel/dialog/${kind}?preview=1`);
        const fallback = page.locator('.public-dialog-unavailable');
        await fallback.waitFor();
        await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
        const before = page.url();
        if (bridge) {
          const close = fallback.getByRole('button', { name: 'Закрыть приложение', exact: true });
          await target44(close);
          await close.click();
          assert.equal(
            await page.evaluate(
              () =>
                window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) => event.type === 'close')
                  .length,
            ),
            1,
          );
        } else assert.equal(await fallback.getByRole('button').count(), 0);
        assert.equal(page.url(), before);
        assert.equal(
          await page.evaluate(() => localStorage.getItem('maxim:last-channel-entity-id')),
          'remembered-managed',
        );
        for (const size of ['16px', '32px']) {
          await page.evaluate((font) => (document.documentElement.style.fontSize = font), size);
          const text = await fallback.locator('.status-state__content').evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()]
              .filter((r) => r.width > 0)
              .map((r) => ({ left: r.left, right: r.right }));
          });
          assert.ok(
            text.length && text.every((r) => r.left >= 15 && r.right <= profile.width - 15),
            JSON.stringify(text),
          );
        }
        await page.screenshot({ path: `${output}/${tag}-${kind}-unavailable-bridge${bridge}.png` });
      }
    } finally {
      await context.close();
    }
  }
  const comments = await contextFor(browser, base, profile);
  try {
    await comments.route('**/src/main.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
      }),
    );
    const page = await comments.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', () => assert.fail('Deletion must not open a native confirm'));
    await page.goto(base);
    await page.locator('.channel-dialog-message').last().waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    assert.equal(await page.locator('.comment-theme-sheet__options').count(), 0);
    await page.getByRole('button', { name: 'Параметры обсуждения', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Параметры обсуждения', exact: true })
      .getByRole('button', { name: 'Оформление комментариев', exact: true })
      .click();
    const themeSheet = page.getByRole('dialog', { name: 'Оформление', exact: true });
    await themeSheet.waitFor();
    const columns = await themeSheet
      .locator('.comment-theme-sheet__options')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.equal(columns, profile.width <= 350 ? 2 : 3);
    await themeSheet.getByRole('radio', { name: 'Хром', exact: true }).click();
    assert.equal(
      await page.locator('[data-comment-theme]').getAttribute('data-comment-theme'),
      'chrome',
    );
    await page.screenshot({ path: `${output}/${tag}-theme-first-open.png` });
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await themeSheet.waitFor({ state: 'detached' });
    const lastId = () => page.locator('[data-message-id]').last().getAttribute('data-message-id');
    const initialId = await lastId();
    await page.evaluate(
      (id) =>
        window.commentTest.updateMessage(id, {
          reactionGroups: [{ emoji: '👍', count: 2, reactedByMe: false }],
        }),
      initialId,
    );
    const reaction = page.locator(`[data-message-id="${initialId}"] .channel-dialog-reaction-pill`);
    await target44(reaction);
    await reaction.click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-message-id="${id}"] .channel-dialog-reaction-pill`)
          ?.getAttribute('aria-pressed') === 'true',
      initialId,
    );
    const avatar = page.locator('.channel-dialog-message__avatar-target').last();
    await target44(avatar);
    await avatar.click();
    await page.waitForFunction(() => window.commentTest.profileRequests.length === 1);
    const openDelete = async (id) => {
      while (await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).count())
        await page
          .getByRole('button', { name: 'Закрыть уведомление', exact: true })
          .first()
          .click();
      const bubble = page.locator(`[data-message-id="${id}"] .channel-dialog-message__bubble`);
      await bubble.scrollIntoViewIfNeeded();
      await bubble.press('Enter');
      const menu = page.getByRole('dialog', { name: 'Действия с комментарием', exact: true });
      await menu.getByRole('button', { name: 'Удалить', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: /^Удалить .*комментарий/u });
      await sheet.waitFor();
      await sheet.getByRole('button', { name: 'Удалить', exact: true }).waitFor();
      await settleVisualFrame(page);
      const bounds = await sheet.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          focus: node.contains(document.activeElement),
        };
      });
      assert.ok(
        bounds.left >= 0 &&
          bounds.right <= profile.width + 1 &&
          bounds.top >= 0 &&
          bounds.bottom <= profile.height + 1 &&
          bounds.focus,
        JSON.stringify(bounds),
      );
      return { sheet, bubble };
    };
    let { sheet, bubble } = await openDelete(initialId);
    await page.screenshot({ path: `${output}/${tag}-delete-own.png` });
    assert.equal(await page.evaluate(() => window.commentTest.deleteRequests.length), 0);
    await sheet.getByRole('button', { name: 'Отмена', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await bubble.evaluate((node) => node === document.activeElement), true);
    ({ sheet } = await openDelete(initialId));
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await sheet.waitFor({ state: 'detached' });
    ({ sheet } = await openDelete(initialId));
    await page.evaluate(() =>
      window.commentTest.append('Новое сообщение не должно сменить выбранную цель'),
    );
    await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.commentTest.deleteRequests), [
      { id: initialId, token: 'preview-comments-token-0001' },
    ]);
    assert.equal(await page.locator(`[data-message-id="${initialId}"]`).count(), 0);
    const adminId = await lastId();
    await page.evaluate(
      (id) =>
        window.commentTest.updateMessage(id, {
          authorUserId: 'other-user',
          canDelete: false,
          canDeleteAsAdmin: true,
        }),
      adminId,
    );
    ({ sheet } = await openDelete(adminId));
    assert.match(await sheet.innerText(), /как администратор/u);
    await page.screenshot({ path: `${output}/${tag}-delete-admin.png` });
    await page.evaluate(() => window.commentTest.holdDelete());
    await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
    await sheet.getByRole('button', { name: 'Удаляем…', exact: true }).waitFor();
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    assert.equal(await sheet.count(), 1);
    await page.evaluate(() => window.commentTest.finishDelete(true));
    await sheet.getByRole('button', { name: 'Удалить', exact: true }).waitFor();
    assert.equal(await page.locator(`[data-message-id="${adminId}"]`).count(), 1);
    await sheet.getByRole('button', { name: 'Удалить', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(
        (id) => window.commentTest.deleteRequests.filter((r) => r.id === id).length,
        adminId,
      ),
      2,
      'failed deletion retries only after explicit confirmation',
    );
    const deniedId = await lastId();
    ({ sheet } = await openDelete(deniedId));
    const before = await page.evaluate(() => window.commentTest.deleteRequests.length);
    await page.evaluate(
      (id) => window.commentTest.updateMessage(id, { canDelete: false, canDeleteAsAdmin: false }),
      deniedId,
    );
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.commentTest.deleteRequests.length), before);
    const ownerId = await page.locator('[data-message-id]').first().getAttribute('data-message-id');
    ({ sheet } = await openDelete(ownerId));
    await page.evaluate(() => window.commentTest.setUserId('another-user'));
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.commentTest.deleteRequests.length), before);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.screenshot({ path: `${output}/${tag}-comments.png` });
    assert.deepEqual(errors, []);
  } finally {
    await comments.close();
  }
  const suggestions = await contextFor(browser, base, profile);
  try {
    const page = await suggestions.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(
      `${base}channel/preview-channel/dialog/suggest?preview=1&token=preview-suggest-token-0001`,
    );
    const video = page.getByLabel('Добавить видео до 24 МБ', { exact: true });
    await video.waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    assert.match(await video.locator('..').innerText(), /до 24 МБ/u);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), video.tap()]);
    await chooser.setFiles([]);
    const images = page.getByLabel('Добавить до 10 фото', { exact: true });
    await images.setInputFiles([
      resolve(import.meta.dirname, '../src/assets/bots/rex.webp'),
      resolve(import.meta.dirname, '../src/assets/bots/publik.webp'),
    ]);
    const tiles = page.locator(
      '.channel-suggest-composer__image-grid:not(.is-preview) [role="listitem"]',
    );
    await page.waitForFunction(
      () => document.querySelectorAll('.channel-suggest-composer__image-remove').length === 2,
    );
    const names = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    for (const width of [...new Set([280, 320, profile.width])]) {
      await page.setViewportSize({ width, height: profile.height });
      await settleVisualFrame(page);
      for (const button of await page
        .locator('.channel-suggest-composer__image-grid button:enabled')
        .all())
        await target44(button);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
    }
    await page.getByRole('button', { name: 'Переместить фото 1 позже', exact: true }).click();
    assert.deepEqual(
      await tiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      [names[1], names[0]],
    );
    await page.getByRole('button', { name: `Убрать ${names[0]}`, exact: true }).click();
    assert.deepEqual(
      await tiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
      [names[1]],
    );
    await video.setInputFiles({
      name: 'mixed.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('video'),
    });
    await page.getByText('Сначала уберите выбранные вложения', { exact: true }).waitFor();
    assert.equal(await tiles.count(), 1);
    await page.getByRole('button', { name: `Убрать ${names[1]}`, exact: true }).click();
    await video.setInputFiles({
      name: 'large.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.alloc(24 * 1024 * 1024 + 1),
    });
    await page.getByText('Выберите видео размером до 24 МБ.', { exact: true }).waitFor();
    assert.equal(await video.inputValue(), '');
    while (await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).count())
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).first().click();
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    for (const width of [...new Set([280, 320, profile.width])]) {
      await page.setViewportSize({ width, height: profile.height });
      await settleVisualFrame(page);
      const toolbar = await page.locator('.channel-suggest-composer__bar').evaluate((node) => {
        const elements = [...node.querySelectorAll('label,button')];
        return elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            name: element.textContent?.trim() || element.getAttribute('title'),
            left: box.left,
            right: box.right,
            width: box.width,
          };
        });
      });
      assert.ok(
        toolbar.every((box) => box.left >= -1 && box.right <= width + 1),
        JSON.stringify({ width, toolbar }),
      );
      await page.screenshot({ path: `${output}/${tag}-suggestions-${width}-200.png` });
      await target44(video.locator('..'));
    }
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate(() => (document.documentElement.style.fontSize = '16px'));
    await settleVisualFrame(page);
    await page.screenshot({ path: `${output}/${tag}-suggestions.png` });
    await page.locator('.max-rich-text-editor__surface[contenteditable="true"]').first().focus();
    await page.setViewportSize({
      width: profile.width,
      height: Math.max(320, profile.height - 250),
    });
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    await settleVisualFrame(page);
    const keyboardFooter = await page.locator('.channel-suggest-composer__bar').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        viewport: visualViewport.height + visualViewport.offsetTop,
      };
    });
    assert.ok(
      keyboardFooter.top >= 0 && keyboardFooter.bottom <= keyboardFooter.viewport + 1,
      JSON.stringify(keyboardFooter),
    );
    await target44(video.locator('..'));
    await page.screenshot({ path: `${output}/${tag}-suggestions-keyboard.png` });
  } finally {
    await suggestions.close();
  }
  console.log(
    `Public mobile ${tag}: unavailable bridge/gutter, comment targets/deletion/authority, suggestion targets/picker/limit passed.`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
  const output = await mkdtemp('/tmp/maxim-public-mobile-');
  const server = await ensureMiniappDevServer(base);
  console.log(`Public mobile artifacts: ${output}`);
  try {
    for (const [name, engine, width, height, platform] of [
      ['chromium', chromium, 360, 700, 'android'],
      ['webkit', webkit, 320, 504, 'ios'],
    ]) {
      if (process.env.PUBLIC_MOBILE_ENGINE && process.env.PUBLIC_MOBILE_ENGINE !== name) continue;
      const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
      try {
        for (const theme of process.env.PUBLIC_MOBILE_THEME
          ? [process.env.PUBLIC_MOBILE_THEME]
          : ['light', 'dark'])
          await runPublicMobileChecks({
            browser,
            base,
            output,
            profile: { width, height, platform, theme },
          });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await stopChildProcess(server);
  }
}
