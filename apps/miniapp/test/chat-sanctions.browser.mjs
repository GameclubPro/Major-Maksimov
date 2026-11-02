import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('This browser test only accepts a local preview server');
const browser = await chromium.launch();
try {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 1280, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform: 'ios' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = new URL('chat/preview-chat/events?preview=1&device=iphone-se', base);
    await page.goto(url.href);
    await page.locator('.sanctions-workspace__row').first().waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
    const rows = page.locator('.sanctions-workspace__row');
    assert.equal(await rows.count(), 4);
    const oldBan = rows.filter({ hasText: 'Александр Кузнецов' });
    await oldBan.locator('.sanctions-workspace__details-trigger').click();
    await page.getByRole('button', { name: /^(Снять бан|Проверить снятие в MAX)$/u }).click();
    const confirmation = page.getByRole('dialog', {
      name: /^(Снять бан|Проверить снятие в MAX)\?$/u,
    });
    await confirmation.getByRole('button', { name: /^(Снять бан|Проверить)$/u }).click();
    await confirmation.waitFor({ state: 'hidden' });
    await oldBan.waitFor({ state: 'hidden' });
    await page.getByLabel('Состояние ограничения').selectOption('archive');
    await page
      .locator('.sanctions-workspace__row')
      .filter({ hasText: 'Александр Кузнецов' })
      .waitFor();
    assert.match(
      await page
        .locator('.sanctions-workspace__row')
        .filter({ hasText: 'Александр Кузнецов' })
        .innerText(),
      /Снято/,
    );
    await page.getByLabel('Состояние ограничения').selectOption('active');
    await page
      .locator('.sanctions-workspace__row')
      .filter({ hasText: 'Екатерина Михайлова' })
      .locator('.sanctions-workspace__details-trigger')
      .click();
    await page.getByRole('button', { name: 'Снять мут', exact: true }).click();
    const unmute = page.getByRole('dialog', { name: 'Снять мут?' });
    await unmute.getByRole('button', { name: 'Снять мут', exact: true }).click();
    await unmute.waitFor({ state: 'hidden' });
    await page
      .locator('.sanctions-workspace__row')
      .filter({ hasText: 'Екатерина Михайлова' })
      .waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
    const sections = page.getByRole('group', { name: 'Раздел статистики' });
    await sections.getByRole('button', { name: 'Участники', exact: true }).click();
    await page.getByLabel('Активность в MAX', { exact: true }).selectOption('30d');
    await page.locator('.participants-roster__activity--long').first().waitFor();
    assert.equal(await page.locator('.participants-roster__activity--unknown').count(), 0);
    await page.getByLabel('Активность в MAX', { exact: true }).selectOption('unknown');
    await page.locator('.participants-roster__activity--unknown').first().waitFor();
    assert.equal(await page.locator('.participants-roster__activity--long').count(), 0);
    await page.locator('.participants-roster__item').first().click();
    const card = page.locator('.participant-card');
    await card.getByRole('button', { name: /Ограничения/u }).click();
    const participantSanctions = page.locator('.participant-card-sanctions');
    await participantSanctions.waitFor();
    assert.equal(await page.locator('.sanctions-workspace__user-filter').count(), 0);
    await participantSanctions.getByRole('button', { name: 'К участнику', exact: true }).click();
    await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    await sections.getByRole('button', { name: 'Модерация', exact: true }).click();
    await page.getByRole('radio', { name: 'Ограничения', exact: true }).click();
    await page.locator('.sanctions-workspace__row').first().waitFor();
    await page.getByRole('radio', { name: 'Журнал', exact: true }).click();
    await page.locator('.event-feed-item').first().waitFor();
    await page.getByRole('radio', { name: 'Ограничения', exact: true }).click();
    await page.locator('.sanctions-workspace__row').first().waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      false,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: `/tmp/maxim-sanctions-verified-${viewport.width}.png`,
      fullPage: true,
    });
    await context.close();
    console.log(
      `PASS ${viewport.width}px: old ban/unmute, archive, private activity, participant history and journal navigation`,
    );
  }
} finally {
  await browser.close();
}
