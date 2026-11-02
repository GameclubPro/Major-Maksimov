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

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Design tests require a local preview server');
const output = mkdtempSync(join(tmpdir(), 'maxim-moderation-design-'));
const browser = await chromium.launch();
try {
  for (const [width, height, theme] of [
    [320, 568, 'light'],
    [320, 568, 'dark'],
    [393, 851, 'light'],
    [393, 851, 'dark'],
    [1280, 900, 'light'],
    [1280, 900, 'dark'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(
      context,
      { platform: width === 393 ? 'android' : 'ios' },
      { colorScheme: theme },
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('chat/preview-chat/events?preview=1&device=iphone-se', base).href);
    await page.locator('.sanctions-workspace__row').first().waitFor();
    await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const sanctionsTop = (await page.locator('.sanctions-workspace__row').first().boundingBox()).y;
    if (width === 320) assert.ok(sanctionsTop <= 320, `sanctions start too low: ${sanctionsTop}`);
    const search = page.getByRole('searchbox', { name: 'Поиск ограничений' });
    await search.fill('несуществующий участник');
    const clearButton = await page
      .getByRole('button', { name: 'Очистить поиск', exact: true })
      .boundingBox();
    assert.ok(clearButton.width >= 44 && clearButton.height >= 44);
    if (width < 600) {
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', {
          configurable: true,
          value: Math.max(260, innerHeight - 310),
        });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      const searchBox = await search.boundingBox();
      assert.ok(
        searchBox.y + searchBox.height <= (await page.evaluate(() => visualViewport.height)) + 1,
      );
    }
    await search.press('Enter');
    assert.equal(await search.evaluate((node) => node === document.activeElement), false);
    if (width < 600)
      await page.evaluate(() => {
        delete visualViewport.height;
        visualViewport.dispatchEvent(new Event('resize'));
      });
    await page.getByText('Ограничений не найдено', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
    await page.locator('.sanctions-workspace__details-trigger').first().click();
    const panel = page.locator('.sanction-details');
    const primary = panel.getByRole('button', { name: 'Снять мут', exact: true });
    await primary.click({ trial: true });
    const footerBefore = await panel.locator('.settings-drilldown__footer').boundingBox();
    assert.ok(footerBefore.y + footerBefore.height <= height + 1);
    await panel.locator('.settings-drilldown__body').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const footerAfter = await panel.locator('.settings-drilldown__footer').boundingBox();
    assert.ok(Math.abs(footerBefore.y - footerAfter.y) <= 1, 'footer moved with body scroll');
    await page.screenshot({ path: join(output, `${width}-${theme}-detail.png`), fullPage: true });
    await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    const tabs = page.getByRole('group', { name: 'Раздел статистики' });
    await tabs.getByRole('button', { name: 'Участники', exact: true }).click();
    const firstParticipant = page.locator('.participants-roster__item').first();
    await firstParticipant.waitFor();
    const participantsTop = (await firstParticipant.boundingBox()).y;
    if (width === 320) {
      // Filter rows may grow with their labels; keep the first participant's touch target reachable.
      const target = await firstParticipant.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const filters = document
          .querySelector('.participants-roster__filters')
          .getBoundingClientRect();
        const left = Math.max(0, bounds.left);
        const top = Math.max(0, bounds.top);
        const right = Math.min(innerWidth, bounds.right);
        const bottom = Math.min(visualViewport?.height ?? innerHeight, bounds.bottom);
        return {
          width: right - left,
          height: bottom - top,
          belowFilters: bounds.top >= filters.bottom,
          enabled: button.matches('button:not(:disabled)'),
          clear: button.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)),
        };
      });
      assert.ok(
        target.width >= 44 && target.height >= 44,
        'first participant lacks a visible 44px touch target',
      );
      assert.equal(target.belowFilters, true, 'participant overlaps filters');
      assert.equal(
        target.enabled && target.clear,
        true,
        'first participant touch target is blocked',
      );
    }
    await page.getByLabel('Роль участника', { exact: true }).selectOption('bots');
    await page.locator('.participants-roster__pill--bot').first().waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.participants-roster__item').length ===
        document.querySelectorAll('.participants-roster__pill--bot').length,
    );
    assert.equal(await page.locator('.participants-roster__activity').count(), 0);
    await page.getByLabel('Роль участника', { exact: true }).selectOption('all');
    await page.getByLabel('Активность в MAX', { exact: true }).selectOption('30d');
    await page.locator('.participants-roster__activity--long').first().waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.participants-roster__activity')].every((node) =>
        node.classList.contains('participants-roster__activity--long'),
      ),
    );
    const longNameFits = await page
      .locator('.participants-roster__identity strong')
      .first()
      .evaluate((node) => {
        const text = node.textContent;
        node.textContent = 'Александра Константинопольская-Долгорукова';
        const fits = node.scrollWidth <= node.clientWidth + 1;
        node.textContent = text;
        return fits;
      });
    assert.equal(longNameFits, true, 'long participant name overflows');
    await page.screenshot({
      path: join(output, `${width}-${theme}-participants.png`),
      fullPage: true,
    });
    await tabs.getByRole('button', { name: 'События', exact: true }).click();
    await page.locator('.membership-feed__item').first().waitFor();
    const overlapping = await page.locator('.membership-feed__card').evaluateAll((cards) =>
      cards.some((card) => {
        const avatar = card.querySelector('.membership-feed__avatar')?.getBoundingClientRect();
        const name = card.querySelector('.membership-feed__name-link')?.getBoundingClientRect();
        return avatar && name && name.left < avatar.right + 3;
      }),
    );
    assert.equal(overlapping, false, 'event avatars overlap names');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px ${theme}: first rows ${Math.round(sanctionsTop)}/${Math.round(participantsTop)}, fixed footer, filters and aligned avatars`,
    );
    await context.close();
  }
  console.log(`Design screenshots: ${output}`);
} finally {
  await browser.close();
}
