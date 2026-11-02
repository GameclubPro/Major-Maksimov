import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4319/app/');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/participant-card-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/app/test/fixtures/participant-card-harness.tsx');
  </script></body></html>`,
    }),
  );
  await page.goto(new URL('participant-card-test', base).href);
  const card = page.locator('.participant-card');
  await card.waitFor();
  await page.waitForFunction(() =>
    window.participantCardTest.requests.some((path) => path.includes('/members/one?')),
  );
  assert.equal(await card.getByRole('button', { name: 'Защита', exact: true }).isDisabled(), true);
  assert.equal(await card.getByText('Выключена', { exact: true }).count(), 0);
  await page.evaluate(() => window.participantCardTest.show('chat-1', 'two'));
  await page.waitForFunction(() =>
    window.participantCardTest.requests.some((path) => path.includes('/members/two?')),
  );
  await page.evaluate(() => {
    window.participantCardTest.resolve('chat-1', 'two');
    window.participantCardTest.resolve('chat-1', 'one', { userDisplayName: 'Late person' });
  });
  await card.getByText('@two', { exact: true }).waitFor();
  assert.equal(await card.getByText('Late person', { exact: true }).count(), 0);
  assert.equal(await card.getByRole('button', { name: 'Защита', exact: true }).isEnabled(), true);
  assert.ok(
    (await page.evaluate(() => window.participantCardTest.aborted)).some((path) =>
      path.includes('/members/one?'),
    ),
  );

  await page.evaluate(() => window.participantCardTest.show('chat-2', 'two'));
  await page.waitForFunction(() =>
    window.participantCardTest.requests.some((path) => path.startsWith('/chats/chat-2/members/')),
  );
  assert.equal(await card.getByRole('button', { name: 'Защита', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.participantCardTest.fail('chat-2', 'two'));
  await card.getByRole('alert').waitFor();
  assert.equal(await card.getByText('Выключена', { exact: true }).count(), 0);
  await card.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.participantCardTest.requests.filter((path) =>
        path.startsWith('/chats/chat-2/members/'),
      ).length === 2,
  );
  await page.evaluate(() =>
    window.participantCardTest.resolve('chat-2', 'two', {
      role: null,
      membershipStatus: 'left',
      canManage: false,
      canMute: true,
      canBan: true,
    }),
  );
  await card.getByText('Вне чата', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Мут', exact: true }).isEnabled(), true);
  assert.equal(await card.getByRole('button', { name: 'Защита', exact: true }).isDisabled(), true);
  await card.getByRole('button', { name: 'Мут', exact: true }).click();
  await card.getByRole('button', { name: 'Назначить мут', exact: true }).click();
  await card.getByRole('button', { name: 'К участнику', exact: true }).click();
  await card.getByRole('button', { name: 'Бан', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.participantCardTest.actions), [
    { chatId: 'chat-2', userId: 'two', action: 'MUTE', durationHours: 24 },
    { chatId: 'chat-2', userId: 'two', action: 'BAN', banOnRejoin: true },
  ]);
  assert.equal(await card.getByRole('button', { name: 'Защита', exact: true }).isDisabled(), true);

  await page.evaluate(() => window.participantCardTest.show('chat-2', 'unknown'));
  await page.waitForFunction(() =>
    window.participantCardTest.requests.some((path) => path.includes('/members/unknown?')),
  );
  await page.evaluate(() =>
    window.participantCardTest.resolve('chat-2', 'unknown', {
      role: null,
      membershipStatus: 'unknown',
      canManage: false,
      canMute: false,
      canBan: false,
    }),
  );
  await card.getByText('Статус в чате неизвестен', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Мут', exact: true }).isDisabled(), true);
  assert.equal(await card.getByRole('button', { name: 'Бан', exact: true }).count(), 0);
  assert.ok(
    (await page.evaluate(() => window.participantCardTest.requests)).every(
      (path) => path.includes('/members/') || path.includes('/sanctions?'),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: identical names, out-of-order responses, chat isolation, cancellation, retry, former participant, no roster search',
  );
} finally {
  await browser.close();
}
