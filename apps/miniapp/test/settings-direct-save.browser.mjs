import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { applyNativeVisualMode } from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/';
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-direct-save-'));
for (const [engineName, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await engine.launch({
    headless: true,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== '' || !/^(https?|all|no)_proxy$/i.test(key),
      ),
    ),
  });
  try {
    for (const [name, width, height, theme, platform] of [
      ['iphone-small-light', 320, 568, 'light', 'ios'],
      ['iphone-dark', 393, 852, 'dark', 'ios'],
      ['android-light', 412, 915, 'light', 'android'],
      ['android-dark', 360, 740, 'dark', 'android'],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        isMobile: true,
        hasTouch: true,
      });
      try {
        await installMaxBridgeShimInitScript(context, {}, { colorScheme: theme, platform });
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await context.route('**/direct-save-test', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/app/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/app/test/fixtures/settings-direct-save-harness.tsx");</script></body></html>',
          }),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(new URL('direct-save-test', base).href);
        await page.evaluate((theme) => (document.documentElement.dataset.maxTheme = theme), theme);
        await applyNativeVisualMode(page, {
          safeTop: platform === 'ios' ? 47 : 24,
          safeBottom: platform === 'ios' ? 34 : 0,
        });
        const open = () => page.getByRole('button', { name: 'Ночной режим', exact: true }).click();
        const dismissToasts = async () => {
          const close = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
          while (await close.count()) await close.first().click();
        };
        await open();
        const panel = page.locator('.settings-drilldown__panel--night');
        const current = panel.getByRole('button', { name: 'Сохранить в этом чате', exact: true });
        const folder = panel.getByRole('button', {
          name: 'Сохранить в папке «Важные»',
          exact: true,
        });
        const all = panel.getByRole('button', { name: 'Сохранить во всех чатах', exact: true });
        await folder.waitFor();
        assert.equal(await current.isDisabled(), true);
        assert.equal(await folder.isEnabled(), true);
        assert.equal(await all.isEnabled(), true);
        assert.equal(
          await panel
            .getByRole('button', { name: /Ещё чаты|Другие чаты|Применить к другим чатам/u })
            .count(),
          0,
        );
        const reachable = async (locator) => {
          await locator.scrollIntoViewIfNeeded();
          assert.equal(
            await locator.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width >= 44 &&
                r.height >= 44 &&
                r.left >= -1 &&
                r.right <= innerWidth + 1 &&
                r.top >= -1 &&
                r.bottom <= innerHeight + 1 &&
                el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
              );
            }),
            true,
          );
        };
        await reachable(all);
        await reachable(folder);
        const layout = await panel.locator('.settings-save-actions').evaluate((element) => {
          const main = element.querySelector('.settings-save-actions__current');
          const targets = element.querySelector('.settings-save-actions__targets');
          const mainRect = main.getBoundingClientRect();
          const targetRect = targets.getBoundingClientRect();
          return {
            stacked: mainRect.bottom <= targetRect.top,
            fullWidth: Math.abs(mainRect.width - targetRect.width) < 1,
            mainColor: getComputedStyle(main).color,
            secondaryWidths: [...targets.children].every(
              (button) => button.getBoundingClientRect().width >= 130,
            ),
          };
        });
        assert.deepEqual(layout, {
          stacked: true,
          fullWidth: true,
          mainColor: 'rgb(255, 255, 255)',
          secondaryWidths: true,
        });
        await page.screenshot({ path: join(screenshots, `${engineName}-${name}-actions.png`) });
        const toggle = panel.getByRole('checkbox', {
          name: 'Включить закрытие чата на ночь',
          exact: true,
        });
        const initial = await toggle.isChecked();
        await toggle.setChecked(!initial);
        await reachable(current);
        await page.screenshot({ path: join(screenshots, `${engineName}-${name}-edited.png`) });
        await page.evaluate(() => (window.directSaveTest.failSave = true));
        await current.click();
        await page.locator('.toast--danger').waitFor();
        assert.equal(await panel.isVisible(), true);
        assert.equal(await toggle.isChecked(), !initial);
        await page.evaluate(() => (window.directSaveTest.failSave = false));
        await page
          .getByRole('button', { name: 'Закрыть уведомление', exact: true })
          .first()
          .click();
        await current.click();
        await panel.waitFor({ state: 'hidden' });
        await dismissToasts();
        await open();
        assert.equal(await toggle.isChecked(), !initial);
        assert.equal(await current.isDisabled(), true);
        await folder.click();
        const confirmation = page.locator('.settings-apply-target__panel');
        await confirmation
          .getByRole('button', { name: 'Сохранить в 1 чате', exact: true })
          .waitFor();
        assert.match(await confirmation.innerText(), /Папка «Важные»/u);
        assert.equal(
          await confirmation.getByRole('group', { name: 'Область применения' }).count(),
          0,
        );
        await confirmation.getByRole('button', { name: 'Сохранить в 1 чате', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await panel.waitFor({ state: 'hidden' });
        await dismissToasts();
        const folderWrite = await page.evaluate(() =>
          window.directSaveTest.requests
            .filter((r) => r.path.endsWith('/apply-section-to-all'))
            .at(-1),
        );
        assert.equal(folderWrite.body.section, 'night');
        assert.deepEqual(folderWrite.body.target, {
          mode: 'favoriteTypes',
          favoriteTypes: ['important'],
          chatIds: [],
        });
        await open();
        await all.click();
        const confirm = confirmation.getByRole('button', {
          name: 'Сохранить в 2 чатах',
          exact: true,
        });
        await confirm.waitFor();
        await reachable(confirm);
        await page.screenshot({
          path: join(screenshots, `${engineName}-${name}-confirmation.png`),
        });
        await confirm.click();
        await panel.waitFor({ state: 'hidden' });
        const writes = await page.evaluate(() =>
          window.directSaveTest.requests.filter((r) => r.path.endsWith('/apply-section-to-all')),
        );
        assert.equal(writes.length, 2);
        assert.deepEqual(writes[1].body.target, { mode: 'all', favoriteTypes: [], chatIds: [] });
        assert.equal(writes[1].body.section, 'night');
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${engineName}/${name}: direct source/folder/all, unchanged copying, failed draft, visible touch targets`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
console.log(`Screenshots: ${screenshots}`);
