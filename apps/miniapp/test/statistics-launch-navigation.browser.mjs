import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const encodeLaunch = (route) =>
  `mr-${Buffer.from(JSON.stringify({ v: 1, k: 'route', r: route })).toString('base64url')}`;

export async function checkStatisticsLaunchNavigation(browser, base) {
  for (const [entityType, entityId, statsScreen, device, colorScheme] of [
    ['chat', 'preview-chat', 'events', devices['Pixel 7'], 'light'],
    ['channel', 'preview-channel', 'stats', devices['iPhone 15'], 'dark'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await installMaxBridgeShimInitScript(context, {}, { colorScheme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // FLAG: Exercise the authenticated App/router with fixture API responses only.
      // Preview mode skips LaunchRouteSync and cannot reproduce launcher replay.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/v1/')) {
          const endpoint = `${url.pathname.slice('/api/v1'.length)}${url.search}`;
          const body =
            url.pathname === '/api/v1/auth/miniapp-session'
              ? { authenticated: true, csrfToken: 'c'.repeat(43), expiresInSec: 3600 }
              : await page.evaluate(
                  async ({ endpoint, method, body, base }) => {
                    if (!window.statisticsLaunchApi) {
                      const { createPreviewApiTransport } = await import(
                        new URL('src/lib/api/preview-transport.ts', base).href
                      );
                      window.statisticsLaunchApi = createPreviewApiTransport();
                    }
                    return window.statisticsLaunchApi.request(endpoint, { method, body });
                  },
                  {
                    endpoint,
                    method: route.request().method(),
                    body: route.request().postData() ?? undefined,
                    base,
                  },
                );
          await route.fulfill({ json: body });
        } else if (url.origin === new URL(base).origin) {
          await route.continue();
        } else {
          await route.abort();
        }
      });

      const settings = `/${entityType}/${entityId}/settings`;
      const statistics = `/${entityType}/${entityId}/${statsScreen}`;
      await page.goto(`${base}?startapp=${encodeLaunch(settings)}`);
      await page.getByRole('button', { name: 'Открыть статистику', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Открыть статистику', exact: true }).click();
      await page.waitForTimeout(1200);
      assert.equal(
        new URL(page.url()).pathname,
        `/app${statistics}`,
        'settings launcher must not replay after opening statistics',
      );
      await page.getByRole('button', { name: 'Открыть настройки', exact: true }).waitFor();
      await page.goBack();
      // Counterpart tabs replace the detail entry; native/browser Back returns to Home.
      await page.locator(`.chats-home--${entityType}`).waitFor();
      await page.waitForTimeout(300);
      assert.equal(new URL(page.url()).pathname, '/app/', 'Back must not reapply the launch route');
      await page.locator('.chat-card [data-action="statistics"]').first().click();
      await page.getByRole('button', { name: 'Открыть настройки', exact: true }).waitFor();
      await page.waitForTimeout(1200);
      assert.equal(
        new URL(page.url()).pathname,
        `/app${statistics}`,
        'home statistics entry must keep the selected screen',
      );
      await page.goBack();
      await page.locator(`.chats-home--${entityType}`).waitFor();

      // A genuinely different launcher still takes effect in the same authenticated session.
      await page.evaluate((startParam) => {
        const bridge = window.MAX?.WebApp ?? window.WebApp;
        const params = new URLSearchParams(bridge.initData);
        params.set('start_param', startParam);
        bridge.initData = params.toString();
        bridge.initDataUnsafe.start_param = startParam;
        document.dispatchEvent(new Event('visibilitychange'));
      }, encodeLaunch(statistics));
      await page.getByRole('button', { name: 'Открыть настройки', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Открыть настройки', exact: true }).click();
      await page.getByRole('button', { name: 'Открыть статистику', exact: true }).waitFor();
      await page.waitForTimeout(1200);
      assert.equal(
        new URL(page.url()).pathname,
        `/app${settings}`,
        'statistics launcher must not replay after opening settings',
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS authenticated ${entityType} launcher: statistics, settings, Back, and new launch`,
      );
    } finally {
      await context.close();
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  const base = await allocateMiniappBaseUrl('http://127.0.0.1:3015/app/');
  const server = await ensureMiniappDevServer(base);
  const browser = await chromium.launch();
  try {
    await checkStatisticsLaunchNavigation(browser, base);
  } finally {
    await browser.close();
    await stopChildProcess(server);
  }
}
