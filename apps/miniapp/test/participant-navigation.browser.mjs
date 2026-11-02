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

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4319/app/');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const output = mkdtempSync(join(tmpdir(), 'maxim-participant-navigation-'));
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [320, 568],
    [393, 851],
    [1280, 900],
  ]) {
    for (const theme of ['light', 'dark']) {
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
      await page.goto(
        new URL(
          'chat/preview-chat/events?preview=1&section=moderation&moderationView=history',
          base,
        ).href,
      );
      await page.locator('.event-feed-item__person').first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
      const row = page.locator('.event-feed-item').first();
      await row.locator('.event-feed-item__expand').click();
      const name = await row.locator('.event-feed-item__person strong').innerText();
      await row.locator('.event-feed-item__person').click();
      const card = page.locator('.participant-card');
      await card.waitFor();
      await card.locator('.participant-card__loading').waitFor({ state: 'hidden' });
      assert.equal(await card.locator('.participant-sheet__identity strong').innerText(), name);
      assert.equal(await card.locator('.participant-card__origin').count(), 1);
      assert.equal(await page.locator('.participants-roster').count(), 0);
      assert.equal(
        await card.getByRole('button', { name: 'Профиль в MAX', exact: true }).count(),
        1,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-card.png`),
        animations: 'disabled',
      });
      const overflow = await card.evaluate((panel) =>
        [...panel.querySelectorAll('button, strong, small, p')]
          .filter((node) => node.scrollWidth > node.clientWidth + 2)
          .map((node) => node.textContent),
      );
      assert.deepEqual(overflow, []);
      const protection = card.getByRole('button', { name: 'Защита', exact: true });
      if (await protection.isEnabled()) {
        await protection.click();
        await card.getByRole('radio', { name: 'Всегда', exact: true }).click();
        await card.getByRole('button', { name: 'К участнику', exact: true }).click();
        await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
        await card.getByRole('button', { name: 'Сохранить защиту', exact: true }).click();
        await protection.waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('.participant-sheet__action--immunity small')?.textContent ===
            'Всегда',
        );
        assert.equal(await card.isVisible(), true);
        assert.equal(await page.locator('.participants-roster').count(), 0);
      }
      await card.getByRole('button', { name: /Ограничения/ }).click();
      await page.locator('.participant-card-sanctions').waitFor();
      assert.equal(await page.locator('.sanctions-workspace__user-filter').count(), 0);
      await page
        .locator('.participant-card-sanctions')
        .getByRole('button', { name: 'К участнику', exact: true })
        .click();
      await card.waitFor();
      await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await card.waitFor({ state: 'detached' });
      assert.equal(
        await row.locator('.event-feed-item__expand').getAttribute('aria-expanded'),
        'true',
      );
      assert.match(page.url(), /moderationView=history/u);

      await page
        .getByRole('group', { name: 'Раздел статистики' })
        .getByRole('button', { name: 'События', exact: true })
        .click();
      const activity = page.locator('.membership-feed__name-link').first();
      await activity.waitFor();
      const activityName = await activity.innerText();
      await activity.click();
      await card.waitFor();
      await card.locator('.participant-card__loading').waitFor({ state: 'hidden' });
      assert.equal(
        await card.locator('.participant-sheet__identity strong').innerText(),
        activityName,
      );
      await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();

      await page
        .getByRole('group', { name: 'Раздел статистики' })
        .getByRole('button', { name: 'Модерация', exact: true })
        .click();
      await page.getByRole('radio', { name: 'Ограничения', exact: true }).click();
      await page.locator('.sanctions-workspace__person').first().click();
      await card.waitFor();
      assert.equal(await page.locator('.sanction-details').count(), 0);
      await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page.locator('.sanctions-workspace__details-trigger').first().click();
      await page.locator('.sanction-details').waitFor();
      await page
        .locator('.sanction-details')
        .getByRole('button', { name: 'Участник', exact: true })
        .click();
      await card.waitFor();
      await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      assert.equal(await page.locator('.sanction-details').isVisible(), true);
      await page
        .locator('.sanction-details')
        .getByRole('button', { name: 'Закрыть панель', exact: true })
        .click();
      await page.getByRole('radio', { name: 'Журнал', exact: true }).click();
      await page.locator('.event-feed-item__person').first().click();
      await card.getByRole('button', { name: 'Бан', exact: true }).click();
      await page.getByRole('dialog', { name: 'Бан участника', exact: true }).waitFor();
      await page.evaluate(() => {
        history.pushState(
          null,
          '',
          '/app/chat/preview-other/events?preview=1&section=moderation&moderationView=history',
        );
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await card.waitFor({ state: 'detached' });
      await page
        .getByRole('dialog', { name: 'Бан участника', exact: true })
        .waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS participant navigation ${width}px ${theme}: journal, membership, sanctions, preserved context`,
      );
      await context.close();
    }
  }
  console.log(`Participant navigation screenshots: ${output}`);
} finally {
  await browser.close();
}
