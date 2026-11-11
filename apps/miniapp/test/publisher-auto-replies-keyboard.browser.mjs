import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
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
  resolveCaptureDevice,
  setPhoneKeyboard,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import deviceProfiles from '../src/lib/preview-device-presets.json' with { type: 'json' };

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const output = await mkdtemp(join(tmpdir(), 'maxim-auto-reply-keyboard-'));
const longReply = Array.from({ length: 100 }, (_, index) => `Ответ клиенту ${index + 1}`).join(
  '\n',
);
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const browser = await chromium.launch();
let activePage;

async function openEditor(page) {
  await page.getByRole('button', { name: 'Добавить автоответ', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Новый автоответ' })
    .getByRole('button', { name: 'Создать здесь', exact: true })
    .click();
  const editor = page.locator('.publisher-auto-reply-editor');
  await editor.waitFor();
  const phrase = editor.getByRole('textbox', { name: 'Фразы', exact: true });
  await phrase.fill('Каталог');
  await phrase.press('Enter');
  return {
    phrase,
    text: editor.getByRole('textbox', { name: 'Текст автоответа', exact: true }),
    footer: editor.locator('.publisher-auto-reply-editor__save-bar'),
  };
}

async function assertFullyVisible(locator, label) {
  const metrics = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = visualViewport?.offsetTop ?? 0;
    return {
      focused: document.activeElement === element,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportTop: top,
      viewportBottom: top + (visualViewport?.height ?? innerHeight),
      viewportWidth: innerWidth,
    };
  });
  assert.ok(
    metrics.focused &&
      metrics.top >= metrics.viewportTop - 1 &&
      metrics.bottom <= metrics.viewportBottom + 1 &&
      metrics.left >= -1 &&
      metrics.right <= metrics.viewportWidth + 1,
    `${label}: ${JSON.stringify(metrics)}`,
  );
}

async function focusReplyEnd(text) {
  await text.evaluate((element) => {
    element.focus({ preventScroll: true });
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText = null;
    while (walker.nextNode()) lastText = walker.currentNode;
    if (!lastText) throw new Error('The typed reply must retain its text nodes.');
    const range = document.createRange();
    range.setStart(lastText, lastText.textContent.length);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function assertCaretVisible(text, label) {
  const metrics = await text.evaluate((element) => {
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const top = visualViewport?.offsetTop ?? 0;
    return {
      focused: document.activeElement === element,
      selectionInside: Boolean(range && element.contains(range.commonAncestorContainer)),
      caret: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
      fieldHeight: element.getBoundingClientRect().height,
      viewportTop: top,
      viewportBottom: top + (visualViewport?.height ?? innerHeight),
      viewportHeight: visualViewport?.height ?? innerHeight,
    };
  });
  assert.ok(
    metrics.focused &&
      metrics.selectionInside &&
      metrics.fieldHeight > metrics.viewportHeight &&
      metrics.caret?.height > 0 &&
      metrics.caret.top >= metrics.viewportTop - 1 &&
      metrics.caret.bottom <= metrics.viewportBottom + 1,
    `${label}: ${JSON.stringify(metrics)}`,
  );
}

async function assertFooterRestored(footer) {
  await footer.waitFor({ state: 'visible' });
  const metrics = await footer.locator('button').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const top = visualViewport?.offsetTop ?? 0;
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportTop: top,
      viewportBottom: top + (visualViewport?.height ?? innerHeight),
      reachable: button.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.ok(
    metrics.top >= metrics.viewportTop - 1 &&
      metrics.bottom <= metrics.viewportBottom + 1 &&
      metrics.reachable,
    `The save action must return after closing the keyboard: ${JSON.stringify(metrics)}`,
  );
}

try {
  for (const width of [280, 393]) {
    for (const mode of ['visual', 'resize']) {
      const device = mode === 'visual' ? 'iphone' : 'android';
      const capture = resolveCaptureDevice(deviceProfiles[device], {
        target: 'smartphone',
        engine: 'chromium',
        metrics: {
          [device]: {
            width,
            height: width === 280 ? 568 : 852,
            ...(width === 280 ? { safeBottom: 0 } : {}),
          },
        },
      });
      const context = await browser.newContext({
        ...capture.contextOptions,
        colorScheme: mode === 'visual' ? 'light' : 'dark',
        reducedMotion: 'reduce',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      });
      const apiRequests = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname === '/api/v1/system/miniapp-boot-trace') {
          await route.fulfill({ status: 204 });
        } else if (url.pathname.startsWith('/api/')) {
          apiRequests.push(`${request.method()} ${url.pathname}`);
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ body: '/* The local test supplies the safe MAX Bridge shim. */' }),
      );
      await installMaxBridgeShimInitScript(context, capture.profile);
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `${base}publisher/chat/preview-chat/auto-replies?preview=1&device=${device}&profile=publisher`,
      );
      await page.locator('.design-preview__device').waitFor();
      await applyNativeVisualMode(page, capture.profile);
      const { phrase, text, footer } = await openEditor(page);
      const tester = page.locator('.publisher-auto-reply-editor__tester');
      await tester.waitFor();
      assert.equal(await tester.getAttribute('open'), null);
      await tester.locator('summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${width}-${mode}-tester-collapsed.png`) });
      await tester.locator('summary').click();
      const sample = tester.getByRole('textbox', { name: 'Сообщение участника', exact: true });
      await sample.fill('Каталог');
      await sample.press('Enter');
      const feedback = tester.getByRole('status');
      await feedback.waitFor();
      const result = await feedback.innerText();
      await tester.locator('summary').click();
      assert.equal(await sample.isVisible(), false);
      await tester.locator('summary').click();
      assert.equal(await sample.inputValue(), 'Каталог');
      assert.equal(await feedback.innerText(), result);
      await sample.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${width}-${mode}-tester-expanded.png`) });
      await tester.locator('summary').click();
      await text.click();

      await text.pressSequentially(longReply, { delay: 1, timeout: 60_000 });
      let expectedText = longReply;
      assert.equal((await text.innerText()).trimEnd(), expectedText);

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await phrase.fill(`Запрос ${cycle}`);
        await setPhoneKeyboard(page, { height: 320, mode });
        await footer.waitFor({ state: 'hidden' });
        await settleVisualFrame(page);
        await assertFullyVisible(phrase, `${width}/${mode}/${cycle} short field`);
        assert.equal(await footer.isVisible(), false);

        await focusReplyEnd(text);
        await settleVisualFrame(page);
        await assertCaretVisible(text, `${width}/${mode}/${cycle} long reply focus handoff`);
        const addition = ` ${cycle}`;
        await page.keyboard.type(addition);
        expectedText += addition;
        assert.equal((await text.innerText()).trimEnd(), expectedText);
        await assertCaretVisible(text, `${width}/${mode}/${cycle} typed reply`);

        await phrase.focus();
        await settleVisualFrame(page);
        await assertFullyVisible(phrase, `${width}/${mode}/${cycle} return to short field`);
        assert.equal(await phrase.inputValue(), `Запрос ${cycle}`);
        assert.equal((await text.innerText()).trimEnd(), expectedText);
        await phrase.evaluate((element) => element.blur());
        await setPhoneKeyboard(page, { mode, open: false });
        await footer.waitFor({ state: 'visible' });
        await settleVisualFrame(page);
        await assertFooterRestored(footer);
      }

      assert.deepEqual(errors, [], `${width}/${mode} browser errors`);
      assert.deepEqual(apiRequests, [], 'Preview must never call a production API.');
      await page.screenshot({ path: join(output, `${width}-${mode}.png`) });
      await context.close();
      console.log(
        `PASS ${width}/${mode}: long caret, short fields, three keyboard cycles and footer`,
      );
    }
  }
  console.log(`Auto-reply keyboard screenshots: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed())
    await activePage.screenshot({ path: join(output, 'failure.png') });
  console.error(`Failure screenshot: ${join(output, 'failure.png')}`);
  throw error;
} finally {
  await browser.close();
  await stopChildProcess(server);
}
