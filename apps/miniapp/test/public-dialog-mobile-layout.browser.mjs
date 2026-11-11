import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

async function contextFor(browser, base, theme, bridge = true) {
  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
    locale: 'ru-RU',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  await installNativeVisualModeInitScript(context);
  if (bridge)
    await installMaxBridgeShimInitScript(
      context,
      { platform: browser.browserType().name() === 'webkit' ? 'ios' : 'android' },
      { colorScheme: theme },
    );
  return context;
}

async function assertTabsUncovered(page) {
  const tabs = await page.getByRole('tab').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        text: node.textContent,
        rect: box.toJSON(),
        hit: node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        ),
      };
    }),
  );
  assert.ok(
    tabs.every((tab) => tab.hit),
    JSON.stringify(tabs),
  );
  return tabs;
}

export async function runPublicDialogLayoutChecks({ browser, base, output, theme }) {
  const tag = `${browser.browserType().name()}-${theme}`;
  const results = [];
  const suggestions = await contextFor(browser, base, theme);
  try {
    await suggestions.route('**/src/main.tsx*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `import ${JSON.stringify(new URL('test/channel-suggestion-mobile.fixture.tsx', base).href)};`,
      }),
    );
    const page = await suggestions.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(base);
    const editor = page.getByRole('textbox', { name: 'Текст объявления', exact: true });
    await editor.waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    const draft = 'Черновик должен сохраниться после просмотра истории';
    await editor.fill(draft);
    await editor.blur();
    await page.getByRole('tab', { name: 'Мои · 80+', exact: true }).click();
    await page.getByText('Показаны последние 80', { exact: true }).waitFor();
    const bar = page.locator('.channel-suggest-composer__bar');
    assert.equal(await bar.isVisible(), false, 'history hides the complete send/attachment bar');
    assert.equal(
      await page.getByRole('button', { name: 'Отправить', exact: true }).isVisible(),
      false,
    );
    let popups = 0;
    page.on('popup', () => popups++);
    const post = page.getByRole('link', { name: 'Открыть пост', exact: true }).first();
    await post.click();
    const links = await page.evaluate(() =>
      window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) => event.type === 'openMaxLink'),
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].payload.url, 'https://max.ru/synthetic_channel/post-1');
    assert.equal(popups, 0, 'MAX post uses the bridge without a new window');
    await page.evaluate(() => window.suggestionLayoutTest.setTruncated(false));
    await page.getByRole('tab', { name: 'Мои · 80', exact: true }).waitFor();
    assert.equal(await page.getByText('Показаны последние 80', { exact: true }).count(), 0);
    await page.screenshot({ path: `${output}/${tag}-history.png` });
    await page.getByRole('tab', { name: 'Написать', exact: true }).click();
    assert.equal(await editor.innerText(), draft);
    assert.equal(await bar.isVisible(), true);
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 393, height: 852 },
      { width: 568, height: 320 },
    ]) {
      for (const font of ['16px', '32px']) {
        await editor.blur();
        await page.setViewportSize(viewport);
        await applyNativeVisualMode(page, {
          safeTop: 0,
          safeBottom: viewport.width === 393 ? 34 : 0,
        });
        await page.evaluate((size) => (document.documentElement.style.fontSize = size), font);
        await settleVisualFrame(page);
        await editor.focus();
        await page.waitForTimeout(400);
        const tabs = await assertTabsUncovered(page);
        const metric = await bar.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const body = document.querySelector('.channel-suggest-body').getBoundingClientRect();
          return { bar: box.toJSON(), body: body.toJSON(), bottom: innerHeight };
        });
        assert.ok(metric.bar.top >= tabs[0].rect.bottom, JSON.stringify(metric));
        assert.ok(metric.bar.bottom <= metric.bottom + 1, JSON.stringify(metric));
        if (viewport.height === 320) assert.ok(metric.body.height >= 60, JSON.stringify(metric));
        results.push({ kind: 'suggestion-focus', viewport, font, tabs, ...metric });
        await page.screenshot({ path: `${output}/${tag}-focus-${viewport.width}-${font}.png` });
        await editor.blur();
        await page.getByRole('tab', { name: 'Мои · 80', exact: true }).click();
        assert.equal(await bar.isVisible(), false);
        await page.getByRole('tab', { name: 'Написать', exact: true }).click();
        assert.equal(await editor.innerText(), draft);
      }
    }
    assert.deepEqual(await page.evaluate(() => window.suggestionLayoutTest.sendRequests), []);
  } finally {
    await suggestions.close();
  }

  const comments = await contextFor(browser, base, theme);
  try {
    const page = await comments.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(
      `${base}channel/preview-channel/dialog/comments?preview=1&token=preview-comments-token-0001`,
    );
    await page.getByRole('button', { name: 'Параметры обсуждения', exact: true }).waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    await page.evaluate(() => (document.documentElement.style.fontSize = '32px'));
    await page.getByRole('button', { name: 'Параметры обсуждения', exact: true }).click();
    await page.getByRole('button', { name: 'Настройки уведомлений', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Уведомления', exact: true });
    await panel.waitFor();
    const metric = await panel.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        rect: box.toJSON(),
        children: Array.from(node.querySelectorAll('button,strong,span')).map((child) => {
          const bounds = child.getBoundingClientRect();
          return {
            text: child.textContent,
            left: bounds.left,
            right: bounds.right,
            width: child.clientWidth,
            scrollWidth: child.scrollWidth,
          };
        }),
      };
    });
    assert.ok(metric.scrollWidth <= metric.width + 1, JSON.stringify(metric));
    assert.ok(
      metric.children.every(
        (child) =>
          child.left >= metric.rect.left &&
          child.right <= metric.rect.right &&
          child.scrollWidth <= child.width + 1,
      ),
      JSON.stringify(metric),
    );
    const apply = panel.getByRole('button', { name: 'Готово', exact: true });
    await apply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${tag}-notification-200.png` });
    await apply.click();
    await panel.waitFor({ state: 'detached' });
    results.push({ kind: 'notification-200', ...metric });
    await page.screenshot({ path: `${output}/${tag}-notification-applied.png` });
  } finally {
    await comments.close();
  }

  const legal = await contextFor(browser, base, theme, false);
  try {
    const page = await legal.newPage();
    await page.goto(`${base}legal/privacy`);
    const navigation = page.getByRole('navigation', { name: 'Документы', exact: true });
    await navigation.waitFor();
    assert.equal(await navigation.locator('[aria-current="page"]').innerText(), 'Данные');
    await navigation.getByRole('link', { name: 'Соглашение', exact: true }).click();
    await navigation.locator('[aria-current="page"]').filter({ hasText: 'Соглашение' }).waitFor();
    assert.equal(await navigation.locator('[aria-current="page"]').innerText(), 'Соглашение');
    assert.equal(await navigation.locator('[aria-current="page"]').count(), 1);
    results.push({ kind: 'legal-current-page', passed: true });
  } finally {
    await legal.close();
  }
  await writeFile(`${output}/${tag}.json`, JSON.stringify(results, null, 2));
  console.log(
    `Public dialog layout ${tag}: history/draft, partial count, MAX links, short viewport, notification text and legal navigation passed.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base =
    process.env.PUBLIC_DIALOG_BASE_URL || (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
  const output =
    process.env.PUBLIC_DIALOG_OUTPUT || (await mkdtemp('/tmp/maxim-public-dialog-layout-'));
  await mkdir(output, { recursive: true });
  const server = await ensureMiniappDevServer(base, {
    reuseServer: process.env.PUBLIC_DIALOG_REUSE_SERVER === '1',
  });
  console.log(`Public dialog layout artifacts: ${output}`);
  try {
    for (const [name, engine] of [
      ['chromium', chromium],
      ['webkit', webkit],
    ]) {
      if (process.env.PUBLIC_DIALOG_ENGINE && process.env.PUBLIC_DIALOG_ENGINE !== name) continue;
      const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
      try {
        for (const theme of process.env.PUBLIC_DIALOG_THEME
          ? [process.env.PUBLIC_DIALOG_THEME]
          : ['light', 'dark'])
          await runPublicDialogLayoutChecks({ browser, base, output, theme });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await stopChildProcess(server);
  }
}
