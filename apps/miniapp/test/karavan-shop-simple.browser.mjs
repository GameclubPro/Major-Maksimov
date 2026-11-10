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
const fixture = await mkdtemp(`${fixtures}/simple-`);
const output = await mkdtemp('/tmp/maxim-shop-simple-');
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
let server;
console.log(`Simple shop artifacts: ${output}`);
try {
  server = await ensureMiniappDevServer(base);
  for (const [name, engine, width] of [
    ['chromium', chromium, 360],
    ['webkit', webkit, 390],
  ].filter(
    ([name]) => !process.env.SHOP_SIMPLE_ENGINE || process.env.SHOP_SIMPLE_ENGINE === name,
  )) {
    const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
    try {
      for (const theme of process.env.SHOP_SIMPLE_THEME
        ? [process.env.SHOP_SIMPLE_THEME]
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
            platform: name === 'webkit' ? 'ios' : 'android',
          });
          await context.route('**/*', (route) =>
            new URL(route.request().url()).pathname.endsWith('/shop-reset')
              ? route.fulfill({ contentType: 'text/html', body: '<html></html>' })
              : new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
          );
          await context.addInitScript(() => {
            const run = new URLSearchParams(location.search).get('run');
            if (run && sessionStorage.getItem('simple-run') !== run) {
              localStorage.clear();
              sessionStorage.clear();
              sessionStorage.setItem('simple-run', run);
            }
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.setDefaultTimeout(12000);
          const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
          let run = 0;
          const begin = async (scenario) => {
            await page.goto(`${base}shop-reset`);
            await page.evaluate(async () => {
              for (const database of await indexedDB.databases())
                if (database.name)
                  await new Promise((resolve, reject) => {
                    const request = indexedDB.deleteDatabase(database.name);
                    request.onsuccess = resolve;
                    request.onerror = reject;
                    request.onblocked = reject;
                  });
            });
            await page.goto(
              `${url}?${new URLSearchParams({ scenario, theme, run: String(++run) })}`,
            );
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.waitFor();
          };
          const requests = (op) =>
            page.evaluate(
              (operation) =>
                window.__shopRequests.filter((row) =>
                  operation === 'setup'
                    ? row.path.endsWith('/setup')
                    : row.body?.command?.operation === operation,
                ),
              op,
            );
          const shot = async (label, panel = home) => {
            await settleVisualFrame(page);
            assert.ok(
              await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
              label + ': no horizontal overflow',
            );
            assert.ok(
              await panel.evaluate((element) =>
                [
                  ...element.querySelectorAll(
                    'button,summary,input:not([type=radio]):not([type=checkbox])',
                  ),
                ]
                  .filter((node) => node.getBoundingClientRect().width > 0)
                  .every((node) => node.getBoundingClientRect().height >= 43),
              ),
              label + ': touch targets',
            );
            await page.screenshot({ path: `${output}/${name}-${width}-${theme}-${label}.png` });
          };
          const back = () => page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
          if (!process.env.SHOP_SIMPLE_ONLY || process.env.SHOP_SIMPLE_ONLY === 'network') {
            await begin('simple_community_network');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
            assert.equal(await settings.getByRole('button', { name: /Оформление/ }).count(), 0);
            assert.equal(await settings.locator('input[type="file"]').count(), 0);
            await settings
              .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
              .click();
            assert.deepEqual(
              await settings
                .getByRole('list', { name: 'Затронутые чаты', exact: true })
                .getByRole('listitem')
                .allTextContents(),
              ['Соседи', 'Соседи второго дома'],
            );
            assert.equal(
              (await requests('status')).length,
              0,
              'showing the affected chats sends no status command',
            );
            await settings
              .getByRole('list', { name: 'Затронутые чаты', exact: true })
              .scrollIntoViewIfNeeded();
            await shot('network-pause', settings);
            await settings
              .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
              .click();
            await settings
              .getByRole('button', { name: 'Включить магазин сети', exact: true })
              .waitFor();
            assert.equal((await requests('status'))[0].body.command.input.status, 'paused');
            await settings
              .getByRole('button', { name: 'Включить магазин сети', exact: true })
              .click();
            assert.equal(
              (await requests('status')).length,
              1,
              'opening the network also waits for scope confirmation',
            );
            await settings.getByRole('button', { name: 'Отмена', exact: true }).click();
            await settings.getByRole('button', { name: 'Изменить формат', exact: true }).click();
            await settings.getByRole('button', { name: /^Администрация/ }).click();
            await settings.getByText(/Затронутые чаты: 2\./u).waitFor();
            await settings.getByRole('button', { name: 'Отмена', exact: true }).click();
            await settings.getByText('Другие чаты и подключения', { exact: true }).click();
            await settings.getByRole('button', { name: 'Отключить этот чат', exact: true }).click();
            const chats = page.getByRole('dialog', { name: 'Подключённые чаты', exact: true });
            await chats.getByRole('button', { name: 'Отключить этот чат', exact: true }).click();
            await chats
              .getByText(
                'Этот чат перестанет открывать магазин. Если он последний, просмотр приостановится. Витрины и заказы сохранятся.',
                { exact: true },
              )
              .waitFor();
            assert.equal(
              (await requests('status')).length,
              1,
              'disconnecting one chat is separate from a network status change',
            );
            await shot('network-disconnect', chats);

            await begin('simple_community_network_100');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            await settings
              .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
              .click();
            assert.equal(
              await settings
                .getByRole('list', { name: 'Затронутые чаты', exact: true })
                .getByRole('listitem')
                .count(),
              100,
              'complete connectedChats projection is independent from legacy bindings48',
            );
            assert.equal(
              await settings
                .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
                .isEnabled(),
              true,
            );
            assert.equal((await requests('status')).length, 0);

            await begin('simple_community_network_incomplete');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            await settings
              .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
              .click();
            await settings
              .getByRole('alert')
              .getByText('Не удалось получить все чаты. Обновите подключение магазина.', {
                exact: true,
              })
              .waitFor();
            assert.equal(
              await settings
                .getByRole('button', { name: 'Приостановить магазин сети', exact: true })
                .isDisabled(),
              true,
            );
            assert.equal((await requests('status')).length, 0);

            await begin('simple_community_retired_recovery');
            const original = await page.evaluate(async () => {
              const journal =
                await import('/app/src/pages/settings/karavan-shop/command-journal.ts');
              const client = await import('/app/src/lib/api/karavan-shop-client.ts');
              const scope = {
                actorMaxUserId: '777',
                chatId: '-123',
                marketplaceId: window.__shopMarket.id,
                expectedBindingGeneration: 1,
              };
              const appearance = {
                name: 'Старое сохранённое оформление',
                description: null,
                logoImageUrl: null,
                coverImageUrl: null,
                accent: 'blue',
                blocks: [
                  { id: 'categories', visible: true },
                  { id: 'pinned', visible: true },
                  { id: 'sellers', visible: true },
                ],
              };
              const request = client.prepareShopRequest(scope, {
                operation: 'appearance_apply',
                input: { commandId: crypto.randomUUID(), expectedRevision: 1, appearance },
              });
              const pending = await journal.reserveShopCommand(scope, request, {
                owner: 'retired-appearance',
                page: 'appearance',
              });
              const dispatched = await journal.releaseShopCommand(
                await journal.claimShopCommand(pending),
              );
              return { request, hash: dispatched.pending.hash };
            });
            await page.reload();
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.getByRole('button', { name: 'Открыть действие', exact: true }).click();
            await settings.waitFor();
            await settings
              .getByRole('button', { name: 'Категории и правила', exact: true })
              .waitFor();
            assert.equal(await settings.getByRole('button', { name: /Оформление/ }).count(), 0);
            assert.equal(
              (await requests('appearance_apply')).length,
              0,
              'opening the retired route does not replay the command',
            );
            const restored = await page.evaluate(async () => {
              const journal =
                await import('/app/src/pages/settings/karavan-shop/command-journal.ts');
              const stored = await journal.loadShopCommandJournal({
                actorMaxUserId: '777',
                chatId: '-123',
                marketplaceId: window.__shopMarket.id,
                expectedBindingGeneration: 1,
              });
              return {
                request: await journal.restoreShopCommand(stored),
                hash: stored.pending.hash,
                page: stored.pending.ui.page,
              };
            });
            assert.deepEqual(restored.request, original.request);
            assert.equal(restored.hash, original.hash);
            assert.equal(
              restored.page,
              'appearance',
              'only navigation is normalized; the saved command remains original',
            );
            await shot('retired-appearance-recovery', settings);
            assert.deepEqual(errors, []);
            console.log(
              `${name}/${width}/${theme}: absent Marketplace design, explicit network scope and legacy recovery route passed`,
            );
            if (process.env.SHOP_SIMPLE_ONLY === 'network') continue;
          }
          if (process.env.SHOP_SIMPLE_ONLY === 'categories') {
            await begin('simple_setup_community');
            await home.getByRole('button', { name: 'Включить магазин', exact: true }).click();
            await home.getByRole('button', { name: /^Участники/ }).click();
            const continueButton = home.getByRole('button', { name: 'Продолжить', exact: true });
            const restrictToNone = async () => {
              await home.getByRole('button', { name: /^Категории: все/ }).click();
              await home.getByRole('radio', { name: 'Только выбранные', exact: true }).check();
              for (const category of ['Услуги', 'Продукты']) {
                const group = home
                  .locator('details')
                  .filter({ has: page.locator('summary', { hasText: category }) })
                  .first();
                await group.locator('summary').click();
                await group.getByRole('checkbox', { name: 'Вся категория', exact: true }).uncheck();
              }
              assert.equal(
                await home.getByRole('button', { name: 'Готово', exact: true }).isDisabled(),
                true,
              );
              assert.equal(
                await continueButton.isDisabled(),
                true,
                'uncommitted restricted selection cannot submit the previous all-categories draft',
              );
              await continueButton.evaluate((node) => node.click());
              assert.equal((await requests('setup')).length, 0);
            };
            await restrictToNone();
            await back();
            await home.getByRole('button', { name: /^Участники/ }).click();
            assert.equal(
              await continueButton.isEnabled(),
              true,
              'leaving the optional editor resets its gate',
            );
            await restrictToNone();
            await home
              .locator('details')
              .filter({ has: page.locator('summary', { hasText: 'Услуги' }) })
              .first()
              .getByRole('checkbox', { name: 'Ремонт', exact: true })
              .check();
            assert.equal(
              await continueButton.isDisabled(),
              true,
              'a nonempty edit still requires Done',
            );
            await home.getByRole('button', { name: 'Готово', exact: true }).click();
            await continueButton.click();
            await home.getByRole('button', { name: 'Пригласить продавцов', exact: true }).waitFor();
            const setup = (await requests('setup'))[0].body.create;
            assert.deepEqual(setup.rules.allowedCategoryIds, ['services']);
            assert.deepEqual(setup.rules.allowedSubcategoryIds, ['services.repair']);
            assert.deepEqual(errors, []);
            console.log(
              `${name}/${width}/${theme}: optional category draft cannot widen setup; Done and Back gates passed`,
            );
            continue;
          }
          if (process.env.SHOP_SIMPLE_ONLY === 'boundaries') {
            const seller = page.getByRole('dialog', { name: 'Добавить продавца', exact: true });
            const chooseAnna = async () => {
              await seller.getByRole('searchbox', { name: 'Продавец', exact: true }).fill('Анна');
              await seller.getByRole('button', { name: /^Анна Цветкова/ }).click();
              await seller
                .getByRole('button', { name: 'Разрешить размещение', exact: true })
                .waitFor();
            };
            await begin('simple_community_selected_empty');
            await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
            await chooseAnna();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            await seller.getByRole('button', { name: 'Другой продавец', exact: true }).click();
            await chooseAnna();
            assert.equal(
              await seller.getByText('Доступ разрешён', { exact: true }).count(),
              0,
              'a historical receipt cannot complete a new selection',
            );
            await seller
              .getByRole('radio', { name: 'Витрина администрации соседей', exact: true })
              .check();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            const twoGrants = await requests('seller_grant_create');
            assert.equal(twoGrants.length, 2);
            assert.notEqual(
              twoGrants[0].body.command.input.commandId,
              twoGrants[1].body.command.input.commandId,
            );
            assert.equal(twoGrants[0].body.command.input.storeId, null);
            assert.equal(
              twoGrants[1].body.command.input.storeId,
              'cc669048-0279-4a35-987c-60f94593163e',
            );
            await seller.locator('.karavan-shop__advanced > summary').click();
            assert.equal(
              await seller.getByRole('button', { name: 'Отозвать доступ', exact: true }).count(),
              0,
              'claimed placement uses listing management',
            );

            await begin('simple_community_selected_empty_new_seller');
            await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
            await chooseAnna();
            await page.evaluate(() => {
              window.__shopNextFailure = {
                operation: 'seller_grant_create',
                status: 409,
                code: 'MARKETPLACE_RULES_CHANGED',
              };
            });
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByRole('button', { name: 'Обновить данные', exact: true }).waitFor();
            assert.equal(
              await seller
                .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
                .count(),
              0,
              'a first definite rejection releases the command',
            );
            await seller.getByRole('button', { name: 'Обновить данные', exact: true }).click();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            await seller.locator('.karavan-shop__advanced > summary').click();
            await seller.getByRole('button', { name: 'Отозвать доступ', exact: true }).click();
            await seller.getByText('Доступ отозван', { exact: true }).waitFor();
            assert.equal(
              await seller.getByText('Доступ разрешён', { exact: true }).count(),
              0,
              'revoke invalidates the displayed confirmation',
            );
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            assert.equal(
              (await requests('seller_grant_create')).length,
              3,
              'new grant is possible after rejection and revocation',
            );

            await begin('simple_community_selected_empty_new_seller_unknown');
            await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
            await chooseAnna();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller
              .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
              .waitFor();
            const pending = (await requests('seller_grant_create'))[0].body;
            await page.reload();
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.getByRole('button', { name: 'Открыть действие', exact: true }).click();
            await seller
              .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
              .click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            assert.deepEqual(
              (await requests('seller_grant_create'))[0].body,
              pending,
              'pending recovery preserves the original intention',
            );

            await begin('simple_admin_1');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
            await settings.getByRole('button', { name: 'Выключить магазин', exact: true }).click();
            await settings
              .getByText(
                'Магазин этого чата закроется для покупателей. Витрины, товары и настройки сохранятся.',
                { exact: true },
              )
              .waitFor();
            await page.evaluate(() => window.__setShopStatus('paused'));
            await settleVisualFrame(page);
            await settings.getByRole('button', { name: 'Выключить магазин', exact: true }).click();
            await settings.getByRole('button', { name: 'Включить магазин', exact: true }).waitFor();
            const status = await requests('status');
            assert.equal(status.length, 1);
            assert.equal(
              status[0].body.command.input.status,
              'paused',
              'a pending close confirmation cannot reopen a concurrently paused shop',
            );
            assert.equal(status[0].body.command.input.expectedRevision, 2);
            assert.deepEqual(errors, []);
            console.log(
              `${name}/${width}/${theme}: known rejection, fresh grant intent/revoke, exact unknown recovery and concurrent pause passed`,
            );
            continue;
          }
          if (process.env.SHOP_SIMPLE_ONLY === 'queue') {
            await begin('simple_community_pending_self_not_ready');
            await home.getByRole('button', { name: /^Заявки/ }).click();
            const queue = page.getByRole('dialog', { name: 'Заявки', exact: true });
            await queue
              .getByText('Заявку проверяет другой администратор.', { exact: true })
              .waitFor();
            assert.equal(
              await queue.getByRole('button', { name: 'Добавить в магазин', exact: true }).count(),
              0,
            );
            await queue.getByRole('button', { name: 'Следующая заявка', exact: true }).click();
            await queue.getByText('Анна Цветкова', { exact: true }).waitFor();
            await queue.getByText('от 1 500 ₽', { exact: true }).waitFor();
            await shot('queue-next', queue);
            await queue.getByRole('button', { name: 'Добавить в магазин', exact: true }).click();
            await queue
              .getByText('Витрина одобрена. Нет опубликованных объявлений.', { exact: true })
              .waitFor();
            await queue
              .getByText('Заявку проверяет другой администратор.', { exact: true })
              .waitFor();
            assert.equal((await requests('decide')).length, 1);
            assert.equal(
              (await requests('decide'))[0].body.command.applicationId,
              'cc669048-0279-4a35-987c-60f94593163e',
            );
            await queue.getByRole('button', { name: 'История', exact: true }).click();
            await queue.getByText('Одобрено', { exact: true }).waitFor();
            assert.equal(await queue.getByText('Иван Петров', { exact: true }).count(), 0);
            await shot('queue-history', queue);
            assert.deepEqual(errors, []);
            console.log(
              `${name}/${width}/${theme}: queue navigation, exact decision and separate history passed`,
            );
            continue;
          }
          if (process.env.SHOP_SIMPLE_ONLY !== 'grant') {
            await begin('simple_setup_admin');
            await home.getByRole('button', { name: 'Включить магазин', exact: true }).click();
            await home
              .getByRole('heading', { name: 'Кто будет продавать?', exact: true })
              .waitFor();
            assert.equal(await home.getByRole('textbox').count(), 0);
            await shot('who');
            await home.getByRole('button', { name: /^Администрация/ }).click();
            await home.getByRole('button', { name: /^Добавить витрину/ }).waitFor();
            const setup = await requests('setup');
            assert.equal(setup.length, 1);
            assert.equal(setup[0].body.create.setupVersion, 2);
            assert.equal(setup[0].body.create.name, 'Соседи');
            assert.equal(Object.hasOwn(setup[0].body.create, 'administrationStoreId'), false);
            assert.equal((await requests('status')).length, 0, 'no separate manual opening');
            await home.getByRole('button', { name: /^Посмотреть магазин/ }).click();
            assert.ok(
              (await page.evaluate(() => window.__shopOpened))
                .at(-1)
                .includes('startapp=m_synthetic-shop'),
            );
            await home.getByRole('button', { name: /^Добавить витрину/ }).click();
            assert.equal(
              (
                await page.evaluate(() =>
                  window.__shopRequests.filter((row) => row.path.endsWith('/handoffs')),
                )
              ).at(-1).body.destination,
              'storefront',
            );
            await home.getByRole('button', { name: 'Поделиться ссылкой', exact: true }).click();
            assert.equal(
              await home.locator('input[readonly]').count(),
              0,
              'no persistent URL field',
            );
            await shot('admin-empty');
            await page.evaluate(() => window.__setAdministrationStores(1));
            await home.getByRole('button', { name: /^Управлять витриной/ }).waitFor();
            await home.getByRole('button', { name: /^Посмотреть витрину/ }).waitFor();
            await page.evaluate(() => window.__setAdministrationStores(2));
            await home.getByRole('button', { name: /^Управлять витринами/ }).waitFor();
            await home.getByRole('button', { name: /^Посмотреть магазин/ }).click();
            assert.ok(
              (await page.evaluate(() => window.__shopOpened))
                .at(-1)
                .includes('startapp=m_synthetic-shop'),
            );
            await shot('admin-many');

            await begin('simple_setup_community');
            await home.getByRole('button', { name: 'Включить магазин', exact: true }).click();
            await home.getByRole('button', { name: /^Участники/ }).click();
            await home.getByRole('radio', { name: /^По заявкам/ }).waitFor();
            await home.getByRole('radio', { name: /^Свободно/ }).check();
            await page.waitForFunction(
              () =>
                JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create') ?? 'null')
                  ?.admissionPolicy === 'open',
            );
            await page.reload();
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            assert.equal(await home.getByRole('radio', { name: /^Свободно/ }).isChecked(), true);
            await home.getByRole('button', { name: /^Категории: все/ }).click();
            await home.getByRole('radio', { name: 'Только выбранные', exact: true }).check();
            for (const category of ['Услуги', 'Продукты']) {
              const detail = home
                .locator('details')
                .filter({ has: page.locator('summary', { hasText: category }) })
                .first();
              await detail.locator('summary').click();
              await detail.getByRole('checkbox', { name: 'Вся категория', exact: true }).uncheck();
            }
            assert.equal(
              await home.getByRole('button', { name: 'Готово', exact: true }).isDisabled(),
              true,
            );
            await home
              .locator('details')
              .filter({ has: page.locator('summary', { hasText: 'Услуги' }) })
              .first()
              .getByRole('checkbox', { name: 'Ремонт', exact: true })
              .check();
            await home.getByRole('button', { name: 'Готово', exact: true }).click();
            await shot('community-options');
            await home.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await home.getByRole('button', { name: 'Пригласить продавцов', exact: true }).waitFor();
            const community = await requests('setup');
            assert.equal(community[0].body.create.admissionPolicy, 'open');
            assert.deepEqual(community[0].body.create.rules.allowedCategoryIds, ['services']);
            assert.deepEqual(community[0].body.create.rules.allowedSubcategoryIds, [
              'services.repair',
            ]);
            assert.equal(
              await home.getByRole('button', { name: /^Заявки/ }).count(),
              0,
              'empty queue hidden',
            );
          }
          await begin('simple_community_selected_empty_new_seller');
          await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
          const seller = page.getByRole('dialog', { name: 'Добавить продавца', exact: true });
          await page.setViewportSize({ width, height: 420 });
          await seller.getByRole('searchbox', { name: 'Продавец', exact: true }).fill('Анна');
          assert.ok(
            await seller
              .getByRole('searchbox', { name: 'Продавец', exact: true })
              .evaluate((node) => {
                const field = node.getBoundingClientRect();
                return field.top >= 0 && field.bottom <= innerHeight;
              }),
            'seller input stays visible in a reduced keyboard viewport',
          );
          await shot('seller-keyboard', seller);
          await page.setViewportSize({ width, height: 780 });
          await seller.getByRole('button', { name: /^Анна Цветкова/ }).click();
          await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
          await seller
            .getByText('Доступ разрешён', { exact: true })
            .waitFor()
            .catch(async (error) => {
              console.log(await seller.innerText());
              console.log(JSON.stringify(await page.evaluate(() => window.__shopRequests)));
              await page.screenshot({ path: `${output}/grant-failure.png` });
              throw error;
            });
          const grant = await requests('seller_grant_create');
          assert.equal(grant.length, 1);
          assert.equal(grant[0].body.command.input.targetMaxUserId, '888');
          assert.equal(grant[0].body.command.input.storeId, null);
          await shot('personal-access', seller);

          if (process.env.SHOP_SIMPLE_ONLY !== 'grant') {
            await begin('simple_community_selected_empty');
            await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
            await seller.getByRole('searchbox', { name: 'Продавец', exact: true }).fill('Анна');
            await seller.getByRole('button', { name: /^Анна Цветкова/ }).click();
            await seller
              .getByRole('radio', { name: 'Витрина администрации соседей', exact: true })
              .check();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            assert.equal(
              (await requests('seller_grant_create'))[0].body.command.input.storeId,
              'cc669048-0279-4a35-987c-60f94593163e',
            );
            assert.equal(
              (await requests('decide')).length,
              0,
              'personal access does not ask for a second approval',
            );

            await begin('simple_community_selected_empty_new_seller_unknown');
            await home.getByRole('button', { name: 'Добавить продавца', exact: true }).click();
            await seller.getByRole('searchbox', { name: 'Продавец', exact: true }).fill('Анна');
            await seller.getByRole('button', { name: /^Анна Цветкова/ }).click();
            await seller.getByRole('button', { name: 'Разрешить размещение', exact: true }).click();
            await seller
              .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
              .waitFor();
            const uncertainGrant = (await requests('seller_grant_create'))[0].body;
            await page.reload();
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            await home.getByRole('button', { name: 'Открыть действие', exact: true }).click();
            await seller
              .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
              .click();
            await seller.getByText('Доступ разрешён', { exact: true }).waitFor();
            assert.deepEqual(
              (await requests('seller_grant_create'))[0].body,
              uncertainGrant,
              'uncertain grant resumes the exact command after reload',
            );

            await begin('simple_community_pending_not_ready');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            const policy = page.getByRole('dialog', { name: 'Настройки', exact: true });
            await policy.getByRole('radio', { name: /^Свободно/ }).check();
            await policy.getByRole('button', { name: 'Отмена', exact: true }).click();
            assert.equal((await requests('settings')).length, 0);
            assert.equal(
              await policy.getByRole('radio', { name: /^По заявкам/ }).isChecked(),
              true,
            );
            await policy.getByRole('radio', { name: /^Выбранные продавцы/ }).check();
            await policy.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await policy
              .getByRole('button', { name: 'Сохранить', exact: true })
              .waitFor({ state: 'detached' });
            await back();
            await home.getByRole('button', { name: /^Заявки/ }).click();
            const applications = page.getByRole('dialog', { name: 'Заявки', exact: true });
            await applications.getByText('Иван Петров', { exact: true }).waitFor();
            await applications.getByText('от 1 500 ₽', { exact: true }).waitFor();
            await shot('application', applications);
            await applications
              .getByRole('button', { name: 'Добавить в магазин', exact: true })
              .click();
            await applications
              .getByText('Витрина одобрена. Нет опубликованных объявлений.', { exact: true })
              .waitFor();
            await applications.getByText('Анна Цветкова', { exact: true }).waitFor();
            assert.equal((await requests('decide')).length, 1);
            assert.equal(
              await applications
                .locator('.karavan-shop__application-queue')
                .evaluate((node) => document.activeElement === node),
              true,
            );
            await applications.getByRole('button', { name: 'На доработку', exact: true }).click();
            await applications
              .getByRole('textbox', { name: 'Что нужно исправить', exact: true })
              .fill('Добавьте фото букетов');
            await applications.getByRole('button', { name: 'Отправить', exact: true }).click();
            await applications.getByText('Новых заявок нет', { exact: true }).waitFor();
            await applications.getByRole('button', { name: 'История', exact: true }).click();
            await applications.getByText('Добавьте фото букетов', { exact: true }).waitFor();
            assert.equal(
              await applications
                .getByRole('button', { name: 'Добавить в магазин', exact: true })
                .count(),
              0,
            );
            await shot('application-history', applications);

            await begin('simple_admin_1');
            await home.locator('.karavan-shop-home__bonus > summary').click();
            await home.getByText('$ Ремонт стиральных машин', { exact: true }).waitFor();
            await shot('publications-preview', home);
            const answer = home.getByRole('checkbox', { name: 'Ответ бота на $', exact: true });
            await answer.uncheck();
            await home.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
            await home.locator('.karavan-shop-home__bonus > summary').click();
            await home
              .getByRole('button', { name: 'Сохранить', exact: true })
              .waitFor({ state: 'hidden' });
            await back();
            await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
            await home.locator('.karavan-shop-home__bonus > summary').click();
            await home.getByRole('button', { name: 'Сохранить', exact: true }).click();
            assert.equal((await page.evaluate(() => window.__shopSaves)).length, 1);
            await home
              .getByRole('button', { name: 'Сохранить', exact: true })
              .waitFor({ state: 'detached' });
            await shot('publications', home);
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            await policy.getByRole('button', { name: 'Изменить формат', exact: true }).click();
            await policy.getByRole('button', { name: /^Участники/ }).click();
            await policy.getByRole('button', { name: 'Применить формат', exact: true }).click();
            await policy.getByRole('button', { name: 'Изменить формат', exact: true }).waitFor();
            const changedFormat = (await requests('format_update'))[0].body.command.input;
            assert.equal(changedFormat.setupVersion, 2);
            assert.equal(Object.hasOwn(changedFormat, 'administrationStoreId'), false);
            assert.equal(
              (await requests('status')).length,
              0,
              'format change keeps current shop availability',
            );

            await begin('simple_admin_paused');
            assert.equal((await requests('status')).length, 0, 'existing paused shop stays paused');
            await home.getByRole('button', { name: 'Включить магазин', exact: true }).click();
            await home.getByRole('button', { name: /^Посмотреть витрину/ }).waitFor();
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
            await settings.getByRole('button', { name: 'Выключить магазин', exact: true }).click();
            await settings
              .getByText(
                'Магазин этого чата закроется для покупателей. Витрины, товары и настройки сохранятся.',
                { exact: true },
              )
              .waitFor();
            await settings.getByRole('button', { name: 'Выключить магазин', exact: true }).click();
            await back();
            await home.getByText('Магазин выключен', { exact: true }).waitFor();
            assert.equal((await requests('status')).length, 2);
            await shot('paused');
          }
          assert.deepEqual(errors, []);
          console.log(
            `${name}/${width}/${theme}: ${process.env.SHOP_SIMPLE_ONLY === 'grant' ? 'personal access' : 'startup, 0/1/N links, policies, categories, grants and recovery, applications/history, publications, format, pause'} passed`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
