import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShopManualShareChecks } from './shop-share-link.browser.mjs';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

export async function runShopNativeShareChecks({ base, url }) {
  const output = await mkdtemp('/tmp/maxim-shop-share-');
  console.log(`Shop share artifacts: ${output}`);
  await runShopManualShareChecks({ base, output });
  for (const [name, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
    try {
      for (const losePermission of [false, true]) {
        const context = await browser.newContext({
          viewport: { width: 360, height: 780 },
          isMobile: true,
          hasTouch: true,
          reducedMotion: 'reduce',
        });
        try {
          await installMaxBridgeShimInitScript(context, {
            platform: name === 'webkit' ? 'ios' : 'android',
          });
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${url}?scenario=invitation_paged`);
          await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
          const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
          await home.getByRole('button', { name: 'Настройки', exact: true }).click();
          const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
          await settings
            .getByRole('button', { name: 'Пригласить продавца', exact: true })
            .waitFor();
          await page.evaluate(() => {
            const bridge = window.MAX?.WebApp ?? window.WebApp;
            window.__shopNativeShareCalls = 0;
            window.__shopNativeShareSettled = false;
            bridge.shareMaxContent = async () => {
              window.__shopNativeShareCalls++;
              try {
                await new Promise((_, reject) => {
                  window.__rejectShopNativeShare = () => reject(new Error('Native share failed'));
                });
              } finally {
                window.__shopNativeShareSettled = true;
              }
            };
          });
          await settings.getByRole('button', { name: 'Пригласить продавца', exact: true }).click();
          await page.waitForFunction(() => typeof window.__rejectShopNativeShare === 'function');
          assert.equal(await page.evaluate(() => window.__shopNativeShareCalls), 1);
          if (losePermission) {
            await page.evaluate(() => window.__loseShopManage());
            await settings
              .getByRole('button', { name: 'Скопировать ссылку', exact: true })
              .waitFor({ state: 'detached' });
          }
          await page.evaluate(() => window.__rejectShopNativeShare());
          await page.waitForFunction(() => window.__shopNativeShareSettled);
          await settleVisualFrame(page);
          assert.deepEqual(
            await page.evaluate(() => window.__shopClipboard),
            losePermission ? [] : ['https://max.ru/synthetic_seller_bot?startapp=invite_synthetic'],
            losePermission
              ? 'late native rejection cannot copy an invitation after manage permission loss'
              : 'native rejection still falls back to clipboard in the active context',
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.__shopRequests.filter(
                  (row) => row.body?.command?.operation === 'invitation_create',
                ).length,
            ),
            1,
            'native share fallback never creates another invitation',
          );
          assert.deepEqual(errors, []);
          console.log(`Shop native share ${name}/permission-loss=${losePermission}: passed.`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
  await mkdir(fixtures, { recursive: true });
  const fixture = await mkdtemp(`${fixtures}/shop-native-share-`);
  await writeFile(
    `${fixture}/index.html`,
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
  );
  const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
  const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
  let server;
  try {
    server = await ensureMiniappDevServer(base);
    await runShopNativeShareChecks({ base, url });
  } finally {
    if (server) await stopChildProcess(server);
    await rm(fixture, { recursive: true, force: true });
  }
}
