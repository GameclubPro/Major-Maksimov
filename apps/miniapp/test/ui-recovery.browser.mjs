import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  setPhoneKeyboard,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { assertStopWordsSaveFailure } from '../../../scripts/miniapp-stop-words-flow.mjs';
import { MINIAPP_VISUAL_SCENARIOS } from '../../../scripts/miniapp-visual-scenarios.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output = await mkdtemp('/tmp/maxim-ui-recovery-');
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const results = [];
console.log(`UI recovery artifacts: ${output}`);
try {
  for (const [engine, width, height, theme] of [
    [webkit, 320, 504, 'light'],
    [chromium, 393, 749, 'dark'],
  ]) {
    if (process.env.UI_RECOVERY_ENGINE && process.env.UI_RECOVERY_ENGINE !== engine.name())
      continue;
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      for (const scenario of [
        'empty-editor',
        'picker',
        'publications',
        'comments',
        'suggest',
        'toast',
      ]) {
        if (
          process.env.UI_RECOVERY_CASE &&
          !process.env.UI_RECOVERY_CASE.split(',').includes(scenario)
        )
          continue;
        const context = await browser.newContext({
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          reducedMotion: 'reduce',
          locale: 'ru-RU',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(
            context,
            { platform: engine === webkit ? 'ios' : 'android' },
            { colorScheme: theme },
          );
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const shot = async (name) => {
            await settleVisualFrame(page);
            await page.screenshot({ path: `${output}/${engine.name()}-${scenario}-${name}.png` });
          };
          if (scenario === 'empty-editor') {
            await page.goto(`${base}publications?preview=1&profile=publisher&compose=1`);
            const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
            await editor.waitFor();
            await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
            for (const mode of ['visual', 'resize']) {
              await editor.fill('');
              await editor.focus();
              await setPhoneKeyboard(page, { height: 320, mode });
              await page.waitForFunction(() => {
                const editor = document.activeElement;
                if (!editor?.matches('[contenteditable="true"]')) return false;
                const box = editor.getBoundingClientRect();
                const style = getComputedStyle(editor);
                const firstLine =
                  box.top +
                  parseFloat(style.paddingTop) +
                  parseFloat(style.borderTopWidth) -
                  editor.scrollTop;
                const scroll = editor.closest('.publications-editor');
                const bounds = scroll?.getBoundingClientRect();
                const hit = document.elementFromPoint(box.left + 16, firstLine + 8);
                return (
                  editor.contains(hit) &&
                  firstLine >= Math.max(visualViewport.offsetTop, bounds?.top ?? 0) - 1 &&
                  firstLine + parseFloat(style.lineHeight) <=
                    Math.min(
                      visualViewport.offsetTop + visualViewport.height,
                      bounds?.bottom ?? Infinity,
                    ) +
                      1
                );
              });
              await shot(`empty-${mode}`);
              await page.keyboard.type('A');
              await page.waitForFunction(() => {
                const range = getSelection().getRangeAt(0);
                const r = range.getBoundingClientRect();
                const editor = document.activeElement;
                const bounds = editor.closest('.publications-editor').getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + 1, r.top + r.height / 2);
                return (
                  editor.contains(hit) &&
                  r.top >= bounds.top &&
                  r.bottom <= bounds.bottom &&
                  r.height > 0 &&
                  r.top >= visualViewport.offsetTop &&
                  r.bottom <= visualViewport.offsetTop + visualViewport.height
                );
              });
              await shot(`typed-${mode}`);
              await setPhoneKeyboard(page, { open: false, mode });
            }
          } else if (scenario === 'toast') {
            const fixture = MINIAPP_VISUAL_SCENARIOS.find(
              (item) => item.name === 'chat-settings-stop-words-retry',
            );
            const url = new URL(fixture.path.replace(/^\//, ''), base);
            for (const [key, value] of Object.entries({ preview: '1', ...fixture.searchParams }))
              url.searchParams.set(key, value);
            await page.goto(url.href);
            await page.locator('.settings-drilldown__panel--stop-words').waitFor();
            await assertStopWordsSaveFailure(page, 'network');
            assert.equal(
              await page.locator('.toast--danger').count(),
              0,
              'successful retry removes the obsolete error',
            );
            await shot('saved');
          } else {
            await context.route('**/src/main.tsx*', (route) =>
              route.fulfill({
                contentType: 'application/javascript',
                body: `import ${JSON.stringify(new URL('test/ui-recovery.fixture.tsx', base).href)};`,
              }),
            );
            await page.goto(
              `${base}?surface=${scenario}${scenario === 'picker' ? '&failure=Network%20error' : ''}`,
            );
            await page.waitForFunction(() => Boolean(window.recoveryTest));
            await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
            if (scenario === 'picker') {
              await page.locator('.publication-target-picker__summary').click();
              const dialog = page.getByRole('dialog', { name: 'Получатели', exact: true });
              await dialog
                .getByRole('heading', { name: 'Не удалось загрузить получателей' })
                .waitFor();
              assert.equal(await dialog.getByText('Ничего не найдено', { exact: true }).count(), 0);
              await shot('initial-failure');
              await page.evaluate(() => window.recoveryTest.setFailure(''));
              await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();
              await dialog.locator('.publication-target-row').first().waitFor();
              await page.evaluate(() => window.recoveryTest.setFailure('Network error'));
              await dialog.getByRole('searchbox', { name: 'Найти получателя' }).fill('Южного');
              await dialog
                .getByRole('heading', { name: 'Не удалось загрузить получателей' })
                .waitFor();
              await page.evaluate(() => window.recoveryTest.setFailure(''));
              await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();
              await dialog.locator('.publication-target-row').first().waitFor();
              await shot('retried-search');
            } else {
              const content = page
                .locator(
                  scenario === 'publications'
                    ? '.publication-feed-card'
                    : scenario === 'comments'
                      ? '.channel-dialog-message'
                      : '.channel-suggest-composer',
                )
                .first();
              await content.waitFor();
              const original = await content.innerText();
              const editor =
                scenario === 'suggest'
                  ? page.getByRole('textbox', { name: 'Текст объявления', exact: true })
                  : null;
              if (editor) {
                await editor.fill('Сохранённый черновик');
                await editor.blur();
              }
              await page.evaluate(async () => {
                window.recoveryTest.setFailure('Network error');
                await window.recoveryTest.refresh();
              });
              const notice = page.locator('.refresh-notice');
              await notice.waitFor();
              assert.equal(
                await content.isVisible(),
                true,
                'cached content survives failed refresh',
              );
              if (editor) assert.equal(await editor.innerText(), 'Сохранённый черновик');
              else assert.equal(await content.innerText(), original);
              await shot('refresh-failed');
              await page.evaluate(() => window.recoveryTest.setFailure(''));
              await notice.getByRole('button', { name: 'Повторить', exact: true }).click();
              await notice.waitFor({ state: 'detached' });
              if (editor) assert.equal(await editor.innerText(), 'Сохранённый черновик');
              if (scenario !== 'publications') {
                await page.evaluate(async () => {
                  window.recoveryTest.setFailure('Доступ запрещён');
                  await window.recoveryTest.refresh();
                });
                await content.waitFor({ state: 'detached' });
                assert.equal(
                  await page.locator('[contenteditable="true"]').count(),
                  0,
                  'terminal denial still blocks editing',
                );
                await shot('access-denied');
              }
            }
            assert.deepEqual(await page.evaluate(() => window.recoveryTest.writes), []);
          }
          assert.deepEqual(errors, []);
          results.push({ engine: engine.name(), scenario, status: 'passed' });
          console.log(`${engine.name()}/${scenario}: passed`);
        } catch (error) {
          results.push({ engine: engine.name(), scenario, status: 'failed', error: error.stack });
          console.error(`${engine.name()}/${scenario}: ${error.message}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  await stopChildProcess(server);
}
assert.equal(
  results.filter((result) => result.status === 'failed').length,
  0,
  JSON.stringify(results),
);
