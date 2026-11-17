import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Design tests require a local preview server');
const output = mkdtempSync(join(tmpdir(), 'maxim-signal-design-'));
const browser = await chromium.launch();

async function fits(page, label) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${label}: page overflows horizontally`,
  );
}

try {
  for (const width of [320, 375, 393, 412, 430, 1280]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 320 ? 504 : 811 },
        colorScheme: theme,
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, { platform: 'ios' }, { colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const open = async (path, ready = '.chat-card') => {
        const url = new URL(path, base);
        url.searchParams.set('preview', '1');
        url.searchParams.set('device', 'iphone-se');
        await page.goto(url.href);
        await page.locator(ready).first().waitFor({ state: 'attached' });
        await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
        await page.evaluate(() => document.fonts.ready);
      };

      await open('');
      const row = page.locator('.chat-card').first();
      await row.waitFor();
      if (width === 320) {
        const cardBounds = await row.boundingBox();
        const actionBounds = await row.locator('.chat-card__row-actions').boundingBox();
        const navBounds = await page.locator('.bottom-nav').boundingBox();
        assert.ok(
          cardBounds.y >= 0 && cardBounds.y + cardBounds.height <= navBounds.y + 1,
          'the complete first card must fit above the bottom navigation on a small screen',
        );
        assert.ok(
          actionBounds.y >= cardBounds.y &&
            actionBounds.y + actionBounds.height <= cardBounds.y + cardBounds.height + 1,
          'first-card settings and statistics must fit inside the card',
        );
      }
      for (const selector of [
        '.chat-card__action--favorite',
        '.chat-card__action--settings',
        '.chat-card__action--statistics',
      ]) {
        const box = await row.locator(selector).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${selector}: small touch target`);
      }
      const homeUrl = page.url();
      await row.locator('.chat-card__action--favorite').click();
      await page.getByRole('dialog').waitFor();
      assert.equal(page.url(), homeUrl, 'favorite action navigated the row');
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await fits(page, 'home');
      await page.screenshot({
        path: join(output, `${width}-${theme}-signal.png`),
        animations: 'disabled',
      });
      if (width === 320 || width === 1280) {
        await open('?design=editorial');
        await page.locator('.chat-card').first().waitFor();
        await page.screenshot({
          path: join(output, `${width}-${theme}-editorial.png`),
          animations: 'disabled',
        });
        await open('');
      }

      await page.locator('#chat-search').fill('Садоводы');
      await page.locator('.chat-card__primary-link').first().click();
      const links = page.locator('.settings-section__toggle').filter({ hasText: 'Ссылки' }).first();
      await links.waitFor();
      await links.click();
      const linksPanel = page.locator('.settings-drilldown__panel--links');
      if (width === 320) {
        // Exercise a failed save through the same in-memory transport as the preview.
        await page.evaluate(async () => {
          const moduleUrl = (name) =>
            performance
              .getEntriesByType('resource')
              .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`)).name;
          const { PREVIEW_REQUEST_HANDLERS } = await import(moduleUrl('preview-transport.ts'));
          const { PREVIEW_NOT_HANDLED } = await import(moduleUrl('preview-transport-runtime.ts'));
          window.__signalSettingsWrites = 0;
          PREVIEW_REQUEST_HANDLERS.unshift(({ url, method, init }) => {
            if (
              url.pathname === '/chats/preview-chat/settings/section' &&
              method === 'PATCH' &&
              JSON.parse(init.body).section === 'links'
            ) {
              window.__signalSettingsWrites += 1;
              if (window.__signalSettingsWrites === 1)
                throw new Error('Не удалось сохранить. Повторите попытку.');
            }
            return PREVIEW_NOT_HANDLED;
          });
        });
      }
      await linksPanel.getByRole('radio', { name: 'Разрешать все', exact: true }).click();
      await linksPanel.getByRole('button', { name: 'Сохранить в этом чате', exact: true }).click();
      if (width === 320) {
        await page.getByText('Не удалось сохранить блок «Ссылки»', { exact: true }).waitFor();
        assert.equal(
          await linksPanel
            .getByRole('radio', { name: 'Разрешать все', exact: true })
            .getAttribute('aria-checked'),
          'true',
        );
        await page.screenshot({
          path: join(output, `${width}-${theme}-save-error.png`),
          animations: 'disabled',
        });
        await linksPanel
          .getByRole('button', { name: 'Сохранить в этом чате', exact: true })
          .click();
      }
      await linksPanel.waitFor({ state: 'hidden' });
      if (width === 320) assert.equal(await page.evaluate(() => window.__signalSettingsWrites), 2);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await links.click();
        const panel = page.locator('.settings-drilldown__panel--links');
        await panel.waitFor();
        assert.equal(
          await panel
            .getByRole('radio', { name: 'Разрешать все', exact: true })
            .getAttribute('aria-checked'),
          'true',
        );
        await panel
          .getByRole('button', { name: 'Закрыть панель', exact: true })
          .click({ trial: true });
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await links.evaluate((el) => el === document.activeElement), true);
      }
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('#chat-search').waitFor();
      assert.equal(await page.locator('#chat-search').inputValue(), 'Садоводы');

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
        document.querySelector('.chat-card__title-wrap h3').textContent =
          'Сообщество Александры Константинопольской-Долгоруковой';
      });
      await fits(page, 'home at 200% text');
      const title = page.locator('.chat-card__title-wrap h3').first();
      assert.equal(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
      await page.screenshot({
        path: join(output, `${width}-${theme}-large-text.png`),
        animations: 'disabled',
      });

      await open('channel/preview-channel/stats', '.channel-stats-graph__canvas');
      const graph = page.locator('.channel-stats-graph__canvas').first();
      await graph.waitFor();
      if (width === 320)
        assert.ok((await graph.boundingBox()).y < 504, 'graph below first viewport');
      const disclosure = page.locator('.channel-insights__reach-details');
      assert.equal(await disclosure.evaluate((el) => el.open), false);
      await disclosure.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await disclosure.evaluate((el) => el.open), true);
      assert.equal(await disclosure.locator('.channel-summary-card').count(), 2);
      await page.keyboard.press('Enter');
      assert.equal(await disclosure.evaluate((el) => el.open), false);
      await fits(page, 'statistics');

      await open(
        'channel/preview-channel/dialog/comments?token=preview-comments-token-0001',
        '.channel-dialog-comments-header',
      );
      const heading = page.getByRole('heading', { name: 'Комментарии', exact: true });
      await heading.waitFor();
      assert.equal(
        await heading.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        'comments heading clipped',
      );
      await fits(page, 'comments');

      await open('?profile=publisher', '.publisher-entity-row');
      await page.locator('.publisher-entity-row').first().waitFor();
      const accent = await page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--color-accent').trim());
      assert.equal(accent, theme === 'light' ? '#b54708' : '#ffad70');
      await open('publications?profile=publisher', '.publications-page.is-publisher');
      await page.locator('.publications-page.is-publisher').waitFor();
      assert.equal(
        await page
          .locator('.publications-primary')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        theme === 'light' ? 'rgb(181, 71, 8)' : 'rgb(255, 173, 112)',
        'publication action lost the Publisher accent',
      );
      await fits(page, 'publisher');
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${width}px ${theme}: layout, actions, native Back, text zoom, disclosure, Publisher accent`,
      );
      await context.close();
    }
  }
  console.log(`Signal design screenshots: ${output}`);
} finally {
  await browser.close();
}
