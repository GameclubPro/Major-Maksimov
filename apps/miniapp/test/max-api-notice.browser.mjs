import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-max-api-notice-'));
const startsAt = Date.parse('2026-11-11T13:15:00Z');
const expiresAt = startsAt + 6 * 60 * 60 * 1000;
const entry = `${base}channel/-123/dialog/comments?token=notice-test`;

try {
  for (const [name, engine, device, platform] of [
    ['iphone', webkit, devices['iPhone SE'], 'ios'],
    ['android', chromium, devices['Pixel 7'], 'android'],
  ]) {
    const browser = await engine.launch({
      env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
    });
    try {
      for (const theme of ['light', 'dark']) {
        for (const profile of ['moderation', 'publisher']) {
          const context = await browser.newContext({
            ...device,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          try {
            await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
            let userId = '900719925';
            let denied = false;
            await context.route('**/*', async (route) => {
              const url = new URL(route.request().url());
              if (url.pathname.startsWith('/api/v1/')) {
                const endpoint = url.pathname.slice('/api/v1'.length);
                let body = {};
                if (endpoint === '/auth/miniapp-session') {
                  body = { authenticated: true, csrfToken: 'c'.repeat(43), expiresInSec: 3600 };
                } else if (endpoint === '/me') {
                  body = { userId, profile, homeRoute: '/' };
                } else if (endpoint === '/channels/-123/dialog/comments') {
                  body = { chatId: '-123', type: 'comments', messages: [] };
                } else if (endpoint.endsWith('/moderation')) {
                  body = {
                    canManage: false,
                    restriction: { userId, kind: null, expiresAt: null, reason: '', revision: 0 },
                  };
                }
                await route.fulfill({
                  json: body,
                  status: denied && endpoint === '/me' ? 403 : 200,
                });
              } else if (url.origin === new URL(base).origin) {
                await route.continue();
              } else {
                await route.fulfill({ contentType: 'application/javascript', body: '' });
              }
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.clock.install({ time: startsAt + 60_000 });
            await page.goto(entry);
            const dialog = page.getByRole('alertdialog', { name: 'Нестабильная работа API MAX' });
            await dialog.waitFor();
            assert.ok(
              (await dialog.innerText()).includes('Проблема предположительно на стороне платформы'),
            );
            const button = dialog.getByRole('button', { name: 'Ознакомлен', exact: true });
            assert.equal(await dialog.getByRole('button').count(), 1);
            const contrast = await button.evaluate((node) => {
              const luminance = (color) =>
                color
                  .match(/[\d.]+/gu)
                  .slice(0, 3)
                  .map(Number)
                  .map((value) => value / 255)
                  .map((value) =>
                    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
                  )
                  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
              const style = getComputedStyle(node);
              const foreground = luminance(style.color);
              const background = luminance(style.backgroundColor);
              return (
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05)
              );
            });
            assert.ok(contrast >= 4.5, `Acknowledgement contrast ${contrast.toFixed(2)}:1`);
            await button.focus();
            await page.keyboard.press('Tab');
            assert.equal(await button.evaluate((node) => node === document.activeElement), true);
            const rect = await dialog.boundingBox();
            assert.ok(
              rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= device.viewport.width + 1,
            );
            assert.ok(rect.y + rect.height <= device.viewport.height + 1);
            assert.equal(
              await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
              true,
            );
            await page.screenshot({ path: path.join(output, `${name}-${theme}-${profile}.png`) });
            await button.click();
            await dialog.waitFor({ state: 'hidden' });
            await page.reload();
            await page.getByRole('heading', { name: 'Комментарии', exact: true }).waitFor();
            assert.equal(await dialog.count(), 0, 'acknowledgement survives re-entry');

            userId = '900719926';
            await page.reload();
            await dialog.waitFor();
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '32px';
              Object.defineProperties(window.visualViewport, {
                offsetTop: { configurable: true, get: () => 64 },
                height: { configurable: true, get: () => 280 },
              });
              window.visualViewport.dispatchEvent(new Event('resize'));
            });
            await page.waitForFunction(
              () =>
                document.querySelector('.max-api-notice')?.getBoundingClientRect().height === 280,
            );
            await dialog.evaluate((node) => {
              node.scrollTop = node.scrollHeight;
            });
            const action = await button.boundingBox();
            assert.ok(
              action.y >= 64 && action.y + action.height <= 345,
              'action remains reachable with 200% text and short viewport',
            );
            await page.clock.setSystemTime(expiresAt);
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await dialog.waitFor({ state: 'hidden' });
            await page.reload();
            await page.getByRole('heading', { name: 'Комментарии', exact: true }).waitFor();
            assert.equal(await dialog.count(), 0, 'expired campaign never appears on entry');

            await page.clock.setSystemTime(startsAt + 60_000);
            denied = true;
            await page.reload();
            await page.getByText('Не удалось открыть приложение', { exact: true }).waitFor();
            assert.equal(await dialog.count(), 0, 'profile authorization is required');
            assert.deepEqual(errors, []);
            console.log(
              `PASS MAX notice ${name} ${theme} ${profile}: entry, focus, acknowledgement, user isolation, short viewport, expiry, auth`,
            );
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Notice screenshots: ${output}`);
} finally {
  await stopChildProcess(server);
}
