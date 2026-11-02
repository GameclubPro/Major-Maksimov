import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Local server required');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 393, height: 851 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/statistics-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/app/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import('/app/test/fixtures/statistics-workspace-harness.tsx');
</script></body></html>`,
  }),
);
const navigate = (path) => page.evaluate((path) => window.statisticsTest.navigate(path), path);
try {
  await page.goto(new URL('statistics-test', base).href);
  await page.locator('.event-feed-item').first().waitFor();
  const filter = page.getByLabel('Тип события', { exact: true });
  await filter.selectOption('BAN');
  await page.getByRole('radio', { name: '7д', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.events-dashboard__range [aria-checked="true"]')?.textContent ===
      '7д',
  );
  assert.equal(await filter.inputValue(), 'BAN');
  await page.getByRole('button', { name: 'События', exact: true }).click();
  await page.locator('.membership-feed__item').first().waitFor();
  await page.evaluate(() => {
    window.statisticsTest.failDashboard = true;
  });
  await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
  await page.locator('.events-refresh-error').waitFor();
  assert.ok((await page.locator('.membership-feed__item').count()) > 0);
  await page.evaluate(() => {
    window.statisticsTest.failDashboard = false;
  });
  await page.locator('.events-refresh-error').getByRole('button', { name: 'Повторить' }).click();
  await page.locator('.events-refresh-error').waitFor({ state: 'hidden' });
  console.log('PASS journal filter persists and activity refetch errors preserve rows');

  await page.getByRole('button', { name: 'Участники', exact: true }).click();
  await page.locator('.participants-roster__item').first().waitFor();
  await page.waitForFunction(
    () => document.querySelector('.compact-page-header__title')?.textContent === 'Свежий заголовок',
  );
  await page.getByLabel('Роль участника', { exact: true }).selectOption('members');
  await page.locator('.participants-roster__item').first().click();
  await page.getByRole('button', { name: 'Бан', exact: true }).click();
  await page.evaluate(() => {
    window.statisticsTest.holdMutations = true;
  });
  const confirm = page.getByRole('dialog', { name: 'Бан участника' });
  await confirm.getByRole('button', { name: 'В этом чате', exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => window.statisticsTest.pending.length === 1);
  assert.equal(
    await page.evaluate(
      () =>
        window.statisticsTest.calls.filter((call) => call.path.endsWith('/moderation-action'))
          .length,
    ),
    1,
  );
  await navigate('/chat/another-chat/events?section=participants');
  await confirm.waitFor({ state: 'hidden' });
  await page.locator('.participants-roster__item').first().waitFor();
  assert.equal(await page.getByLabel('Роль участника', { exact: true }).inputValue(), 'all');
  await page.evaluate(() => window.statisticsTest.pending[0]());
  await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0);
  assert.ok((await page.locator('.participants-roster__item').count()) > 0);
  console.log(
    'PASS fresh participant identity, single mutation, entity-scoped sheets and late completion',
  );

  await page.evaluate(() => {
    window.statisticsTest.holdMutations = false;
    window.statisticsTest.channelHistory = true;
  });
  await navigate('/channel/preview-channel/stats?section=events');
  await page.waitForFunction(
    () => document.querySelectorAll('.membership-feed__item').length === 50,
  );
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.membership-feed__item').length === 75,
  );
  await page.locator('.channel-member-ban').last().click();
  const ban = page.getByRole('alertdialog');
  await ban.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await ban.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.membership-feed__item').count(), 75);
  console.log('PASS channel moderation preserves paginated event history');

  await navigate('/chat/local-ban/events?section=moderation&moderationView=sanctions');
  await page.locator('.sanctions-workspace__details-trigger').first().click();
  await page.getByRole('button', { name: 'Снять бан', exact: true }).click();
  const localRelease = page.getByRole('dialog', { name: 'Снять бан?', exact: true });
  assert.equal(await localRelease.getByText(/Снимите блокировку вручную/u).count(), 0);
  await localRelease.getByRole('button', { name: 'Снять бан', exact: true }).click();
  await localRelease.waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page.evaluate(() =>
      window.statisticsTest.calls.filter(
        (call) => call.path === '/chats/local-ban/members/local-user/moderation-action',
      ),
    ),
    [
      {
        path: '/chats/local-ban/members/local-user/moderation-action',
        method: 'POST',
        body: { action: 'UNBAN', expectedSanctionEventId: 'local-ban-event' },
      },
    ],
  );
  console.log('PASS local ban release stays available after MAX member restore retirement');

  await navigate('/expiry');
  await page.locator('.sanctions-workspace__row').first().click();
  await page.getByRole('button', { name: 'Снять мут', exact: true }).click();
  const release = page.getByRole('dialog', { name: 'Снять мут?' });
  await page.waitForFunction(
    () =>
      document.querySelector('#sanction-release-title') &&
      [...document.querySelectorAll('.action-confirm-sheet__button')].some(
        (node) => node.textContent === 'Снять мут' && node.disabled,
      ),
  );
  assert.equal(
    await release.getByRole('button', { name: 'Снять мут', exact: true }).isDisabled(),
    true,
  );
  await page.waitForTimeout(1200);
  assert.ok(
    (await page.evaluate(
      () =>
        window.statisticsTest.calls.filter((call) => call.path.includes('/expiry/sanctions'))
          .length,
    )) <= 2,
  );
  assert.equal(
    await page.evaluate(
      () => window.statisticsTest.calls.filter((call) => call.path === 'release').length,
    ),
    0,
  );
  console.log('PASS expiry refresh is bounded and an expired sanction cannot be confirmed');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
