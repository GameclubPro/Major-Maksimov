import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { clickSettingsOverviewEntry } from './settings-overview-browser-helpers.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('Local preview required');
const browser = await chromium.launch(captureBrowserLaunchOptions('chromium', base.href));
try {
  const page = await browser.newPage({
    viewport: { width: 393, height: 747 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await page.goto(
    new URL('networks?type=chat&preview=1&networks=1&networksScenario=uncertain', base).href,
  );
  const card = page.locator('.network-summary-card[data-network-category="partner"]');
  await card.getByRole('button', { name: 'Настройки', exact: true }).click();
  await clickSettingsOverviewEntry(page, 'Ссылки');
  const panel = page.locator('.network-settings-editor');
  await panel.getByRole('button', { name: 'Ранее настроенные сайты', exact: true }).click();
  await panel.getByRole('radio', { name: /Сайты/, checked: true }).waitFor();
  await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).first().click();
  await clickSettingsOverviewEntry(page, 'Приветствие');
  const toggle = panel.getByLabel('Включить приветствие новых участников', { exact: true });
  await toggle.waitFor();
  await page.evaluate(async () => {
    const loaded = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name)).name;
    const { PREVIEW_REQUEST_HANDLERS } = await import(loaded('preview-transport.ts'));
    const { PREVIEW_NOT_HANDLED } = await import(loaded('preview-transport-runtime.ts'));
    window.networkConflict = { previews: [], status: [], applies: [], removed: null };
    PREVIEW_REQUEST_HANDLERS.unshift(async ({ url, init, state }) => {
      const audit = window.networkConflict;
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.pathname.endsWith('/networks/settings/preview')) {
        audit.previews.push(body);
        if (audit.previews.length === 1) {
          const recipient = state.chats.find((row) => row.id === body.recipients[0].entityId);
          audit.removed = recipient.id;
          recipient.favoriteTypes = [];
        }
      } else if (url.pathname.includes('/networks/settings/operations/')) {
        audit.status.push(url.pathname.split('/').at(-1));
      } else if (url.pathname.endsWith('/networks/settings/apply'))
        audit.applies.push(body.operationId);
      return PREVIEW_NOT_HANDLED;
    });
  });
  await toggle.click();
  const draft = await toggle.isChecked();
  const review = panel.getByRole('button', { name: 'Проверить изменения', exact: true });
  await review.click();
  await panel
    .getByText('Состав или настройки изменились. Проверьте черновик.', { exact: true })
    .waitFor();
  assert.equal(await toggle.isChecked(), draft);
  assert.equal(await review.isEnabled(), true);
  assert.equal(
    await page.evaluate(() => {
      const rejected = window.networkConflict.previews[0].operationId;
      return Object.keys(localStorage)
        .filter((k) => k.startsWith('maxim.network.settings.receipts.v1:'))
        .some((k) => JSON.parse(localStorage.getItem(k)).some((r) => r.operationId === rejected));
    }),
    false,
  );
  await review.click();
  const apply = panel.getByRole('button', { name: /^Применить ·/u });
  await apply.click();
  await panel.getByRole('heading', { name: 'Настройки применены', exact: true }).waitFor();
  const result = await page.evaluate(() => window.networkConflict);
  const [first, second] = result.previews;
  assert.equal(result.previews.length, 2);
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(result.status.includes(first.operationId), false);
  assert.deepEqual(second.changes, first.changes);
  assert.equal(second.recipients.length, first.recipients.length - 1);
  assert.equal(
    second.recipients.some((row) => row.entityId === result.removed),
    false,
  );
  assert.deepEqual(result.applies, [second.operationId], 'a lost apply response is never replayed');
  await page.goto(
    new URL('networks?type=chat&preview=1&networks=1&networksScenario=partial', base).href,
  );
  await card.getByRole('button', { name: 'Настройки', exact: true }).click();
  await clickSettingsOverviewEntry(page, 'Приветствие');
  await toggle.click();
  await review.click();
  await apply.click();
  await panel.getByRole('heading', { name: 'Применена часть изменений', exact: true }).waitFor();
  await panel.getByRole('button', { name: /Проверить повтор для неприменённых/ }).click();
  await panel.getByText('Выбранные', { exact: true }).waitFor();
  await toggle.waitFor();
  assert.equal(
    await review.isEnabled(),
    true,
    'retry carries the original changes for the unmodified recipient',
  );
  const retryHub = new URL(page.url());
  retryHub.pathname = retryHub.pathname.replace(/\/greeting$/u, '');
  retryHub.searchParams.set('networks', '1');
  retryHub.searchParams.set('preview', '1');
  for (const [tab, label] of [
    ['communities', 'Состав'],
    ['overview', 'Статистика'],
  ]) {
    await page.goto(retryHub.href);
    await page
      .getByRole('navigation', { name: 'Раздел сетки' })
      .getByRole('button', { name: label, exact: true })
      .click();
    const destination = new URL(page.url());
    assert.equal(destination.searchParams.get('category'), 'partner');
    assert.equal(destination.searchParams.get('tab'), tab);
  }
  console.log(
    'Passed category conflict, preserved edits, fresh recipients, original unknown apply and legacy sites navigation.',
  );
} finally {
  await browser.close();
}
