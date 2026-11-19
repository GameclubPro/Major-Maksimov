import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const token = 'preview-comments-token-0001';
const botUrl = 'https://max.ru/synthetic_profile_bot?start=profile';
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 15'], locale: 'ru-RU' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  await context.route('**/src/main.tsx*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
    }),
  );
  await installMaxBridgeShimInitScript(context, { platform: 'ios' });
  const page = await context.newPage();

  for (const [profile, entity, segment] of [
    ['publisher', 'channel', 'channels'],
    ['publisher', 'chat', 'chats'],
    ['moderation', 'channel', 'channels'],
  ]) {
    await page.goto(`${base}?profile=${profile}&entity=${entity}`);
    const avatar = page
      .getByRole('button', { name: 'Открыть профиль Алексей', exact: true })
      .last();
    const comment = avatar.locator('xpath=ancestor::article');
    const id = await comment.locator('[data-message-id]').getAttribute('data-message-id');
    assert.ok(id);
    await avatar.click();
    await page.waitForFunction(() => window.__MAXIM_VISUAL_BRIDGE_CLOSED__);
    assert.deepEqual(await page.evaluate(() => window.commentTest.profileRequests), [
      profile === 'publisher'
        ? {
            path: `/${segment}/preview-${entity}/dialog/comments/messages/${id}/profile/handoff`,
            body: { token },
          }
        : {
            path: '/channels/preview-channel/members/preview-admin/profile/handoff',
            body: { displayName: 'Алексей' },
          },
    ]);
    assert.deepEqual(
      await page.evaluate(() =>
        window.__MAXIM_VISUAL_BRIDGE_EVENTS__
          .filter((event) => event.type === 'openMaxLink' || event.type === 'close')
          .map(({ type, payload }) => ({ type, url: payload.url })),
      ),
      [
        { type: 'openMaxLink', url: botUrl },
        { type: 'close', url: undefined },
      ],
    );
  }

  await page.goto(`${base}?profile=publisher&entity=channel`);
  await page.getByLabel('Текст комментария', { exact: true }).fill('Новый комментарий');
  await page.evaluate(() => window.commentTest.restrictOnNextSend());
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Вы заблокированы в комментариях' }).waitFor();
  await page.getByText('Бессрочная блокировка', { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await page.getByLabel('Текст комментария', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Новый комментарий', { exact: true }).count(), 0);
  console.log(
    'PASS Publisher chat and channel profile handoff, Major handoff, restriction refresh',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
