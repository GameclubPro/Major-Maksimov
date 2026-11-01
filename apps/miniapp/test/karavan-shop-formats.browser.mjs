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
          const handoffs = () =>
            page.evaluate(() =>
              window.__shopRequests.filter((row) => row.path.endsWith('/handoffs')),
            );
          const back = () => page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
          const settings = async () => {
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            const panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
            await panel.getByRole('heading', { name: 'Формат магазина', exact: true }).waitFor();
            return panel;
          };
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
          await home.getByText('Закрыт для покупателей', { exact: true }).waitFor();
          const created = await requests('setup');
          assert.equal(created.length, 1);
          assert.equal(created[0].body.create.format, 'storefront');
          assert.equal(created[0].body.create.administrationStoreId, null);
          assert.equal((await requests('status')).length, 0, 'creation never opens buyer access');
          assert.equal(
            await home.getByRole('button', { name: 'Посмотреть витрину', exact: true }).count(),
            0,
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

          for (const scenario of ['daily_paged', 'empty']) {
            await begin(scenario);
            const primary = home.locator('.karavan-shop__hero .karavan-module__primary');
            assert.deepEqual(await primary.allTextContents(), ['Посмотреть магазин чата']);
            assert.equal(
              await home
                .locator('.karavan-shop__hero')
                .getByRole('button', { name: /Добавить свой/ })
                .count(),
              0,
            );
            await shot(`community-${scenario}`);
          }

          await begin('format_storefront');
          assert.deepEqual(
            await home.locator('.karavan-shop__hero .karavan-module__primary').allTextContents(),
            ['Посмотреть витрину'],
          );
          assert.equal(
            await home
              .getByRole('button', { name: /^Проверить заявки|^Заявки|^Пригласить/ })
              .count(),
            0,
          );
          await home.getByRole('button', { name: 'Посмотреть витрину', exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.__shopOpened), [
            'https://max.ru/synthetic_buyer_bot?startapp=store_administration-store',
          ]);
          assert.equal((await handoffs()).length, 0, 'public view uses authoritative buyer URL');
          await home.getByRole('button', { name: 'Товары и услуги', exact: true }).click();
          await page.waitForFunction(() => window.__shopOpened.length === 2);
          await home.getByRole('button', { name: 'Оформление', exact: true }).click();
          await page.waitForFunction(() => window.__shopOpened.length === 3);
          assert.deepEqual(
            (await handoffs()).map((row) => row.body.destination),
            ['storefront', 'storefront'],
          );
          assert.ok((await handoffs()).every((row) => !Object.hasOwn(row.body, 'storeId')));
          await shot('administration-home');
          let panel = await settings();
          assert.equal(
            await panel
              .getByRole('button', { name: /Категории и правила|Пригласить|Оформление/ })
              .count(),
            0,
          );
          await panel.getByRole('button', { name: 'Объявления в чате', exact: true }).click();
          const response = page.getByRole('dialog', { name: 'Объявления в чате', exact: true });
          await response.locator('.settings-storefront-editor__preview-button').waitFor();
          assert.equal(
            await response
              .getByText('Выберите витрину для ответа бота на $ в этом чате.', { exact: true })
              .count(),
            0,
          );
          assert.equal(
            await response
              .getByRole('button', { name: 'Личная витрина из прошлого формата', exact: true })
              .count(),
            0,
          );
          assert.equal(
            await response.getByRole('group', { name: 'Сценарий примера', exact: true }).count(),
            0,
          );
          assert.equal(
            await response.locator('.settings-storefront-editor__preview-button').count(),
            1,
          );
          await response.getByText('Изменить текст', { exact: true }).click();
          const text = response.getByRole('textbox', { name: /^Текст ответа бота/ });
          await text.fill('Добро пожаловать в нашу витрину');
          assert.equal(
            await response.getByRole('textbox', { name: /^Кнопка витрины чата/ }).count(),
            1,
          );
          assert.equal(
            await response
              .getByRole('textbox', { name: /Кнопка каталога|Кнопка создания/ })
              .count(),
            0,
          );
          await page.setViewportSize({ width, height: 460 });
          await text.focus();
          await text.scrollIntoViewIfNeeded();
          await shot('administration-response-keyboard', response);
          await page.setViewportSize({ width, height: 780 });
          await back();
          await panel.waitFor();
          await panel.getByRole('button', { name: 'Объявления в чате', exact: true }).click();
          assert.equal(await text.inputValue(), 'Добро пожаловать в нашу витрину');
          await shot('administration-response-draft', response);

          await begin('format_storefront_closed');
          assert.equal(
            await home.getByRole('button', { name: 'Посмотреть витрину', exact: true }).count(),
            0,
          );
          panel = await settings();
          assert.equal(
            await panel
              .getByRole('button', { name: 'Открыть для покупателей', exact: true })
              .count(),
            0,
            'unpublished store cannot open empty',
          );
          await panel.getByRole('button', { name: 'Объявления в чате', exact: true }).click();
          await response.getByText('Изменить текст', { exact: true }).click();
          assert.equal(
            await response.locator('.settings-storefront-editor__preview-button').count(),
            0,
          );
          assert.equal(
            await response.getByRole('textbox').count(),
            2,
            'closed store retains only relevant text fields',
          );
          await shot('administration-closed-response', response);

          await begin('format_storefront_ready');
          await home.getByRole('button', { name: 'Открыть для покупателей', exact: true }).click();
          await home.getByRole('button', { name: 'Посмотреть витрину', exact: true }).waitFor();
          const opening = await requests('status');
          assert.equal(opening.length, 1);
          assert.equal(opening[0].body.command.input.status, 'active');
          assert.equal(
            opening[0].body.command.input.allowEmpty,
            false,
            'ready fixed store opens without empty bypass or pre-existing listing',
          );
          await shot('administration-first-open');

          await begin('format_storefront_handoff_error');
          await home.getByRole('button', { name: 'Товары и услуги', exact: true }).click();
          await home.getByRole('alert').waitFor();
          assert.equal(await page.evaluate(() => window.__shopOpened.length), 0);
          assert.equal((await handoffs()).length, 1);
          await shot('administration-handoff-error');
          await home.getByRole('button', { name: 'Повторить переход', exact: true }).click();
          await page.waitForFunction(() => window.__shopOpened.length === 1);
          assert.equal((await handoffs()).length, 2);

          for (const scenario of ['format_switch', 'format_switch_unknown']) {
            await begin(scenario);
            panel = await settings();
            const format = panel.getByRole('region', { name: 'Формат магазина', exact: true });
            await format.getByRole('button', { name: 'Изменить формат', exact: true }).click();
            await format.getByRole('button', { name: /^Витрина администрации/ }).click();
            await format
              .getByText('Витрины, товары и заказы сохранятся.', { exact: true })
              .waitFor();
            await format
              .getByText(
                'Просмотр покупателями приостановится. После проверки откройте магазин снова.',
                { exact: true },
              )
              .waitFor();
            assert.equal((await requests('format_update')).length, 0);
            await shot(`${scenario}-preview`, panel);
            await format
              .getByRole('button', { name: 'Подтвердить смену формата', exact: true })
              .click();
            if (scenario.endsWith('unknown')) {
              await page
                .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
                .waitFor();
              assert.equal(
                await format.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(),
                true,
              );
              const original = await requests('format_update');
              assert.equal(original.length, 1);
              await shot('format-unknown', panel);
              await page
                .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
                .click();
              await page.waitForFunction(
                () =>
                  window.__shopRequests.filter(
                    (row) => row.body?.command?.operation === 'format_update',
                  ).length === 2,
              );
              assert.deepEqual(
                (await requests('format_update'))[1].body,
                original[0].body,
                'unknown outcome preserves original entire command',
              );
            }
            await format.getByRole('button', { name: 'Изменить формат', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.__shopMarket.status), 'paused');
            assert.equal(
              (await requests('status')).length,
              0,
              'format update cannot reopen automatically',
            );
            await shot(`${scenario}-saved`, panel);
          }
          assert.deepEqual(errors, []);
          profiles++;
          console.log(
            `${engineName}/${width}/${theme}: setup, terms, compatibility, viewing, direct management, drafts and format recovery passed`,
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
