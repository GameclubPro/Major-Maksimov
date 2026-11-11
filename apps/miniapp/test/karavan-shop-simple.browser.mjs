import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { allocateMiniappBaseUrl, ensureMiniappDevServer, stopChildProcess } from '../../../scripts/miniapp-local-server.mjs';
import { captureBrowserLaunchOptions, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/connection-`), output = await mkdtemp('/tmp/maxim-shop-connection-');
await writeFile(`${fixture}/index.html`, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>');
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
const group = process.env.SHOP_SIMPLE_ONLY ?? 'connection';
let server;
console.log(`Shop connection artifacts: ${output}`);
try {
  server = await ensureMiniappDevServer(base);
  for (const [name, engine, width] of [['chromium', chromium, 360], ['webkit', webkit, 390]].filter(([name]) => !process.env.SHOP_SIMPLE_ENGINE || process.env.SHOP_SIMPLE_ENGINE === name)) {
    const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
    try {
      for (const theme of process.env.SHOP_SIMPLE_THEME ? [process.env.SHOP_SIMPLE_THEME] : ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true, colorScheme: theme, reducedMotion: 'reduce' });
        try {
          await installMaxBridgeShimInitScript(context, { platform: name === 'webkit' ? 'ios' : 'android' });
          await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
          await context.addInitScript(() => {
            const run = new URLSearchParams(location.search).get('run');
            if (run && sessionStorage.getItem('connection-run') !== run) { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('connection-run', run); }
          });
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
          const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
          let run = 0;
          const begin = async scenario => {
            await page.goto(`${url}?${new URLSearchParams({ scenario, theme, run: String(++run) })}`);
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click(); await home.waitFor();
          };
          const back = () => page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
          const shot = async (label, panel = home) => {
            await settleVisualFrame(page);
            assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${label}: no overflow`);
            assert.ok(await panel.evaluate(element => [...element.querySelectorAll('button,summary,input:not([type=radio]):not([type=checkbox])')].filter(node => node.getBoundingClientRect().width > 0).every(node => node.getBoundingClientRect().height >= 43)), `${label}: touch controls`);
            await page.screenshot({ path: `${output}/${name}-${theme}-${label}.png` });
          };
          if (group === 'queue') {
            await begin('simple_community_open');
            const original = await page.evaluate(async () => {
              const { reserveShopCommand, claimShopCommand, releaseShopCommand } = await import('/app/src/pages/settings/karavan-shop/command-journal.ts');
              const { prepareShopRequest } = await import('/app/src/lib/api/karavan-shop-client.ts');
              const scope = { actorMaxUserId: '777', chatId: '-123', marketplaceId: window.__shopMarket.id, expectedBindingGeneration: 1 };
              const request = prepareShopRequest(scope, { operation: 'status', input: { commandId: crypto.randomUUID(), expectedRevision: window.__shopMarket.editRevision, status: 'paused', allowEmpty: false } });
              await releaseShopCommand(await claimShopCommand(await reserveShopCommand(scope, request, { owner: 'status', page: 'settings' })));
              return request;
            });
            await page.reload(); await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.getByRole('button', { name: 'Продолжить сохранённое действие', exact: true }).waitFor();
            assert.equal(await home.getByRole('button', { name: 'Открыть действие', exact: true }).count(), 0);
            assert.equal(await home.getByRole('button', { name: 'Управлять магазином', exact: true }).isDisabled(), true);
            assert.equal((await page.evaluate(() => window.__shopRequests.filter(row => row.body?.command?.operation === 'status'))).length, 0);
            await shot('legacy-recovery');
            await home.getByRole('button', { name: 'Продолжить сохранённое действие', exact: true }).click();
            await home.getByText('Магазин выключен', { exact: true }).waitFor();
            const calls = await page.evaluate(() => window.__shopRequests.filter(row => row.body?.command?.operation === 'status'));
            assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, original);
          } else if (group === 'boundaries') {
            await begin('simple_missing_buyer_link');
            assert.equal(await home.getByRole('button', { name: 'Управлять магазином', exact: true }).isDisabled(), true);
            assert.equal(await home.getByRole('button', { name: 'Открыть магазин', exact: true }).count(), 0);
            assert.deepEqual(await page.evaluate(() => window.__shopOpened), []);
            await shot('missing-target');
          } else if (group === 'categories') {
            for (const scenario of ['simple_community_selected_empty', 'simple_admin_0', 'simple_admin_paused']) {
              await begin(scenario);
              assert.equal(await home.getByRole('button', { name: /^(?:Категории и правила|Настройки|Заявки|Добавить продавца|Оформление)$/u }).count(), 0);
              await home.getByRole('button', { name: 'Управлять магазином', exact: true }).click();
              assert.deepEqual(await page.evaluate(() => window.__shopOpened), ['https://max.ru/synthetic_buyer_bot?startapp=ma_synthetic-shop']);
              assert.equal((await page.evaluate(() => window.__shopRequests.filter(row => row.body?.command))).length, 0, 'opening Karavan performs no commerce command');
              await shot(scenario);
            }
          } else {
            await begin('simple_community_network');
            await home.getByRole('button', { name: 'Открыть магазин', exact: true }).click();
            await home.getByRole('button', { name: 'Управлять магазином', exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.__shopOpened), ['https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop', 'https://max.ru/synthetic_buyer_bot?startapp=ma_synthetic-shop']);
            await shot('connected');
            await home.getByRole('button', { name: 'Подключение', exact: true }).click();
            const chats = page.getByRole('dialog', { name: 'Подключённые чаты', exact: true });
            await chats.getByRole('button', { name: 'Отключить этот чат', exact: true }).click();
            await chats.getByText('Этот чат перестанет открывать магазин. Если он последний, просмотр приостановится. Витрины и заказы сохранятся.', { exact: true }).waitFor();
            assert.equal((await page.evaluate(() => window.__shopRequests.filter(row => row.body?.command?.operation === 'status'))).length, 0);
            await shot('disconnect-confirmation', chats);
            await chats.getByRole('button', { name: 'Отмена', exact: true }).click(); await back();
            await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            const publications = page.getByRole('dialog', { name: 'Объявления в чате', exact: true });
            await publications.getByRole('checkbox', { name: 'Ответ бота на $', exact: true }).uncheck();
            await publications.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await page.waitForFunction(() => window.__shopSaves.length === 1);
            await shot('publication-controls', publications);
          }
          assert.deepEqual(errors, []); console.log(`${name}/${theme}: ${group} passed`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { if (server) await stopChildProcess(server); await rm(fixture, { recursive: true, force: true }); }
