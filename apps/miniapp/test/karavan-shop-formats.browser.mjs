import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { runShopManualShareChecks } from './shop-share-link.browser.mjs';

const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/formats-`);
const output = await mkdtemp('/tmp/maxim-shop-formats-');
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
let server;
let profiles = 0;
console.log(`Shop format artifacts: ${output}`);
try {
  server = await ensureMiniappDevServer(base);
  if (
    !process.env.SHOP_FORMAT_ENGINE &&
    !process.env.SHOP_FORMAT_THEME &&
    process.env.SHOP_CATEGORY_ONLY !== '1' &&
    process.env.SHOP_FORMAT_ONLY_CHOICE !== '1'
  )
    await runShopManualShareChecks({ base, output });
  for (const [engineName, engine, width] of [
    ['chromium', chromium, 360],
    ['webkit', webkit, 390],
  ].filter(
    ([name]) => !process.env.SHOP_FORMAT_ENGINE || name === process.env.SHOP_FORMAT_ENGINE,
  )) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const theme of process.env.SHOP_FORMAT_THEME
        ? [process.env.SHOP_FORMAT_THEME]
        : ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 780 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        try {
          await installMaxBridgeShimInitScript(context, {
            platform: engineName === 'webkit' ? 'ios' : 'android',
          });
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await context.addInitScript(() => {
            const run = new URLSearchParams(location.search).get('scenarioRun');
            const marker = 'maxim:shop-format-fixture:scenario-run';
            // Reset before a new scenario boots; real reloads must retain drafts and commands.
            if (run && sessionStorage.getItem(marker) !== run) {
              localStorage.clear();
              sessionStorage.clear();
              sessionStorage.setItem(marker, run);
            }
          });
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
          let scenarioRun = 0;
          const begin = async (scenario) => {
            const params = new URLSearchParams({
              theme,
              scenario,
              scenarioRun: String(++scenarioRun),
            });
            await page.goto(`${url}?${params}`);
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.waitFor();
            return home;
          };
          const requests = (operation) =>
            page.evaluate(
              (op) =>
                window.__shopRequests.filter((row) =>
                  op === 'setup'
                    ? row.path.endsWith('/setup')
                    : row.body?.command?.operation === op,
                ),
              operation,
            );
          const shot = async (name, panel = home) => {
            await settleVisualFrame(page);
            assert.ok(
              await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
              `${name}: no overflow`,
            );
            assert.ok(
              await panel.evaluate((node) =>
                [...node.querySelectorAll('button,input,select,summary')]
                  .filter(
                    (control) =>
                      control.getBoundingClientRect().width > 0 &&
                      !['checkbox', 'radio', 'file'].includes(control.type),
                  )
                  .every((control) => control.getBoundingClientRect().height >= 43),
              ),
              `${name}: touch controls`,
            );
            await page.screenshot({
              path: `${output}/${engineName}-${width}-${theme}-${name}.png`,
            });
          };
          const choose = (label) =>
            home.getByRole('button', { name: new RegExp(`^${label}`) }).click();

          await begin('format_setup_unsupported');
          await home
            .getByText('Обновите приложение, чтобы изменить подключение.', { exact: true })
            .waitFor();
          assert.equal(
            await home
              .getByRole('heading', { name: 'Каким будет ваш магазин?', exact: true })
              .count(),
            0,
            'missing Major capability cannot authorize setup',
          );
          assert.equal((await requests('setup')).length, 0);

          await begin('format_setup');
          await home
            .getByRole('heading', { name: 'Каким будет ваш магазин?', exact: true })
            .waitFor();
          assert.equal(await home.getByRole('textbox').count(), 0);
          await shot('format-choice');
          assert.ok(
            await home.locator('.karavan-shop-format__copy small').evaluateAll((nodes) => {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const context = canvas.getContext('2d');
              const luminance = (color) => {
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const channels = [...context.getImageData(0, 0, 1, 1).data]
                  .slice(0, 3)
                  .map((value) => {
                    const channel = value / 255;
                    return channel <= 0.04045
                      ? channel / 12.92
                      : ((channel + 0.055) / 1.055) ** 2.4;
                  });
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
              };
              return nodes.every((node) => {
                const text = luminance(getComputedStyle(node).color);
                const surface = luminance(getComputedStyle(node.closest('button')).backgroundColor);
                return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05) >= 4.5;
              });
            }),
            'format destination text has readable contrast',
          );
          if (process.env.SHOP_FORMAT_ONLY_CHOICE === '1') {
            profiles++;
            console.log(
              `${engineName}/${width}/${theme}: format choice layout, touch targets and contrast passed`,
            );
            continue;
          }
          await page.waitForFunction(
            () =>
              JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create') || 'null')
                ?.format === null,
          );
          await page.reload();
          await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
          await home
            .getByRole('heading', { name: 'Каким будет ваш магазин?', exact: true })
            .waitFor();
          await choose('Витрина администрации');
          const name = home.getByRole('textbox', { name: 'Название витрины', exact: true });
          await name.fill('Витрина нашего двора');
          await page.waitForFunction(
            () =>
              JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create') || 'null')
                ?.name === 'Витрина нашего двора',
          );
          await page.reload();
          await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
          assert.equal(await name.inputValue(), 'Витрина нашего двора');
          assert.equal(await home.getByText('Продавцы: все желающие', { exact: true }).count(), 0);
          await home
            .getByRole('checkbox', {
              name: 'Подтверждаю подключение витрины и правила размещения',
              exact: true,
            })
            .check();
          await shot('create-storefront');
          await home.getByRole('button', { name: 'Создать витрину чата', exact: true }).click();
          await home.getByText('Магазин выключен', { exact: true }).waitFor();
          const created = await requests('setup');
          assert.equal(created.length, 2);
          assert.deepEqual(created[1].body, created[0].body);
          assert.equal(created[0].body.create.format, 'storefront');
          assert.equal(created[0].body.create.administrationStoreId, null);
          assert.equal((await requests('status')).length, 0, 'creation never opens buyer access');
          assert.equal(
            await home.getByRole('button', { name: 'Посмотреть витрину', exact: true }).count(),
            0,
          );
          const connection = await page.evaluate(() => window.__readShopConnection());
          assert.equal(connection.version, 2);
          assert.equal(connection.blocked, false);
          assert.equal(connection.operation.kind, 'setup');
          assert.equal(connection.operation.operation.state, 'complete');
          assert.deepEqual(connection.operation.operation.request, created[0].body);
          assert.deepEqual(
            await page.evaluate((id) => window.__readShopSetup(id), created[0].body.operationId),
            connection.operation.operation,
            'explicit status reads the original committed setup receipt',
          );
          assert.equal((await requests('setup')).length, 2, 'receipt reads never dispatch setup');
          await page.reload();
          await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
          await home.getByText('Магазин выключен', { exact: true }).waitFor();
          const restored = await page.evaluate(() => window.__readShopConnection());
          assert.deepEqual(
            restored,
            connection,
            'reopening observes the same authoritative receipt',
          );
          assert.equal((await requests('setup')).length, 0, 'reopening never repeats setup');
          assert.equal(
            await page.evaluate(
              () =>
                window.__shopRequests.filter((row) =>
                  /\/(?:bindings\/|connection\/(?:binding|import-binding|operations\/.*\/resume))/u.test(
                    row.path,
                  ),
                ).length,
            ),
            0,
            'reopening a completed setup never starts or resumes a binding',
          );

          await begin('format_setup_terms');
          await choose('Витрина администрации');
          await name.fill('Условия и сохранённый ввод');
          await home
            .getByRole('checkbox', {
              name: 'Подтверждаю подключение витрины и правила размещения',
              exact: true,
            })
            .check();
          await home
            .getByText('Примите условия продавца в Караване, чтобы создать витрину.', {
              exact: true,
            })
            .waitFor();
          assert.equal(
            await home
              .getByRole('button', { name: 'Создать витрину чата', exact: true })
              .isDisabled(),
            true,
          );
          await home.getByRole('button', { name: 'Открыть Караван', exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.__shopOpened), [
            'https://max.ru/synthetic_seller_bot',
          ]);
          assert.equal((await requests('setup')).length, 0);
          await page.evaluate(() => window.__acceptShopSellerTerms());
          await home.getByRole('button', { name: 'Проверить снова', exact: true }).click();
          await page.waitForFunction(
            () =>
              ![...document.querySelectorAll('button')].find(
                (el) => el.textContent.trim() === 'Создать витрину чата',
              )?.disabled,
          );
          assert.equal(await name.inputValue(), 'Условия и сохранённый ввод');
          await shot('terms-return');

          await begin('format_setup_legacy');
          await home.getByText('Настройка витрины пока недоступна.', { exact: true }).waitFor();
          assert.equal(
            await home.getByRole('button', { name: /^Витрина администрации/ }).isDisabled(),
            true,
          );
          assert.equal(
            await home
              .getByText('Примите условия продавца в Караване, чтобы создать витрину.', {
                exact: true,
              })
              .count(),
            0,
          );
          await choose('Магазин участников');
          await home.getByRole('textbox', { name: 'Название магазина', exact: true }).waitFor();
          await shot('legacy-provider-community');

          assert.deepEqual(errors, []);
          profiles++;
          console.log(
            `${engineName}/${width}/${theme}: setup, terms, compatibility and preserved setup receipts passed`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Shop formats: ${profiles} profiles passed; artifacts ${output}`);
} finally {
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
if (
  process.env.SHOP_CATEGORY_ONLY !== '1' &&
  process.env.SHOP_FORMAT_ONLY_CHOICE !== '1' &&
  !process.env.SHOP_FORMAT_ENGINE &&
  !process.env.SHOP_FORMAT_THEME
)
  await import('./karavan-shop-command-journal.browser.mjs');
