import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
import { runShopNativeShareChecks } from './karavan-shop-native-share.browser.mjs';

async function runDailyChecks({ page, url, theme, shot }) {
  const requests = (operation) =>
    page.evaluate(
      (op) => window.__shopRequests.filter((row) => row.body?.command?.operation === op),
      operation,
    );
  const begin = async (scenario, screen) => {
    await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
    // Independent synthetic scenarios reuse one shop scope; recovery is tested within a scenario.
    await page.evaluate(async () => {
      for (const database of await indexedDB.databases())
        if (database.name)
          await new Promise((resolve, reject) => {
            const deletion = indexedDB.deleteDatabase(database.name);
            deletion.onsuccess = resolve;
            deletion.onerror = reject;
            deletion.onblocked = reject;
          });
    });
    await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Магазин чата', exact: true })
      .getByRole('button', { name: screen, exact: true })
      .click();
    return page.getByRole('dialog', { name: screen, exact: true });
  };
  const setting = async (scenario, screen) => {
    const settings = await begin(scenario, 'Настройки');
    await settings.getByRole('button', { name: screen, exact: true }).click();
    return page.getByRole('dialog', { name: screen, exact: true });
  };
  for (const [status, code] of [
    [422, 'MARKETPLACE_CATEGORIES_INVALID'],
    [409, 'MARKETPLACE_REVISION_CONFLICT'],
    [403, 'MARKETPLACE_FORBIDDEN'],
    [503, 'KARAVAN_COMMAND_UNKNOWN'],
  ]) {
    const panel = await begin('daily_decision', 'Заявки');
    await panel.getByRole('button', { name: 'На доработку', exact: true }).click();
    const reason = panel.getByRole('textbox', { name: 'Что нужно исправить', exact: true });
    await reason.fill('Добавьте фотографию товара');
    assert.equal(
      await panel.getByRole('button', { name: 'Одобрить', exact: true }).count(),
      0,
      'decision editor replaces the action row',
    );
    await panel.getByRole('button', { name: 'Отклонить', exact: true }).click();
    const refusal = panel.getByRole('textbox', { name: 'Причина отказа', exact: true });
    assert.equal(
      await refusal.inputValue(),
      'Добавьте фотографию товара',
      'switching a decision preserves its reason',
    );
    await page.evaluate(
      ({ status, code }) => {
        window.__shopNextFailure = { operation: 'decide', status, code };
      },
      { status, code },
    );
    await panel.getByRole('button', { name: 'Отклонить заявку', exact: true }).click();
    if (status === 503)
      await panel
        .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
        .waitFor();
    else await panel.getByRole('alert').waitFor();
    assert.equal(await refusal.inputValue(), 'Добавьте фотографию товара');
    if (status === 403) {
      assert.equal(await refusal.isDisabled(), true);
      assert.equal(
        await panel.getByRole('button', { name: 'Повторить проверку', exact: true }).count(),
        0,
        'lost authority has no mutation replay',
      );
      assert.equal(
        await panel.getByRole('button', { name: 'Отмена', exact: true }).isEnabled(),
        true,
      );
      await panel.getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal((await requests('decide')).length, 1);
    } else if (status === 503) {
      assert.equal(await refusal.isDisabled(), true);
      assert.equal(
        await panel.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(),
        true,
      );
      await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Не сохранять изменения?', exact: true })
        .getByRole('button', { name: 'Продолжить настройку', exact: true })
        .click();
      assert.equal(
        await refusal.inputValue(),
        'Добавьте фотографию товара',
        'unknown command stays dirty across a cancelled close',
      );
      await shot(`daily-unknown-${status}`, panel);
      await panel
        .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
        .click();
      await panel.getByText('Новых заявок нет', { exact: true }).waitFor();
      const writes = await requests('decide');
      assert.equal(writes.length, 2);
      assert.deepEqual(
        writes[1].body,
        writes[0].body,
        'unknown outcome repeats the entire original command',
      );
    } else {
      assert.equal(await refusal.isEnabled(), true, 'definite rejection leaves reason editable');
      assert.equal(
        await panel.getByRole('button', { name: 'Отмена', exact: true }).isEnabled(),
        true,
      );
      if (status === 409)
        await panel.getByRole('button', { name: 'Обновить данные', exact: true }).click();
      else await panel.getByRole('button', { name: 'Исправить', exact: true }).click();
      assert.equal(await refusal.inputValue(), 'Добавьте фотографию товара');
      await refusal.fill('Добавьте фото и цену');
      await panel.getByRole('button', { name: 'Отклонить заявку', exact: true }).click();
      await panel.getByText('Новых заявок нет', { exact: true }).waitFor();
      const writes = await requests('decide');
      assert.equal(writes.length, 2);
      assert.notEqual(writes[0].body.commandId, writes[1].body.commandId);
      assert.equal(writes[1].body.command.input.reason, 'Добавьте фото и цену');
      assert.equal(writes[1].body.command.input.expectedRevision, status === 409 ? 2 : 1);
      assert.equal(
        await panel
          .getByRole('button', { name: /Пригласить продавца|Ссылка для продавцов/ })
          .count(),
        0,
        'empty applications do not repeat seller invitations',
      );
    }
  }
  let panel = await begin('daily_paged', 'Товары и услуги');
  await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
  await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await panel.getByText('Доставка продуктов', { exact: true }).waitFor();
  assert.equal(
    await panel.getByText('Ремонт стиральной машины с выездом на дом', { exact: true }).isVisible(),
    true,
    'catalog keeps page one after page two',
  );
  assert.equal(
    await panel.getByLabel('Тип', { exact: true }).count(),
    0,
    'a verified absent property catalog does not add a type selector',
  );
  await panel
    .locator('article')
    .filter({ hasText: 'Ремонт стиральной машины с выездом на дом' })
    .getByRole('button', { name: 'Закрепить', exact: true })
    .click();
  await panel.getByText('Закреплённые · 1', { exact: true }).waitFor();
  await panel
    .locator('article')
    .filter({ hasText: 'Доставка продуктов' })
    .getByRole('button', { name: 'Закрепить', exact: true })
    .click();
  await panel.getByText('Закреплённые · 2', { exact: true }).click();
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 0);
  await panel.getByRole('button', { name: 'Изменить порядок', exact: true }).click();
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 2);
  await panel.getByRole('button', { name: 'Ниже: Доставка продуктов', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__shopRequests.filter((row) => row.body?.command?.operation === 'pins_save').length ===
      3,
  );
  assert.deepEqual(
    (await requests('pins_save'))[2].body.command.input.offers.map((row) => row.id),
    (await requests('pins_save'))[1].body.command.input.offers.map((row) => row.id).reverse(),
  );
  assert.equal((await requests('pins_save'))[2].body.command.input.expectedRevision, 3);
  await panel.getByRole('button', { name: 'Готово', exact: true }).click();
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 0);
  await shot('daily-paged-catalog', panel);
  panel = await begin('daily_existing_property', 'Товары и услуги');
  await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
  await panel.getByLabel('Тип', { exact: true }).selectOption('property');
  await panel.getByText('Квартира у школы', { exact: true }).waitFor();
  await panel.getByText('Категория отключена', { exact: true }).waitFor();
  panel = await begin('daily_paged', 'Настройки');
  await panel.locator('details.karavan-shop__invitations summary').click();
  await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await panel.getByText(/использовано 25$/u).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: 'Отозвать приглашение', exact: true }).count(),
    25,
    'invitations keep the earlier page',
  );

  panel = await begin('daily_reorder', 'Товары и услуги');
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 0);
  await panel.getByRole('button', { name: 'Изменить порядок', exact: true }).click();
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 2);
  await panel.getByRole('button', { name: 'Готово', exact: true }).click();
  assert.equal(await panel.locator('.karavan-shop__drag').count(), 0);
  await shot('daily-reorder-off', panel);
  panel = await begin('daily_no_arrange', 'Товары и услуги');
  await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
  await panel.getByText('Ремонт стиральной машины с выездом на дом', { exact: true }).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: 'Закрепить', exact: true }).count(),
    0,
    'unavailable arrange action is hidden',
  );
  panel = await begin('daily_arrange_only', 'Товары и услуги');
  await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
  await panel.getByText('Ремонт стиральной машины с выездом на дом', { exact: true }).waitFor();
  assert.equal(
    await panel.getByRole('button', { name: 'Скрыть', exact: true }).count(),
    0,
    'arrange authority does not expose review actions',
  );
  assert.equal(
    await panel.getByRole('button', { name: 'Закрепить', exact: true }).isVisible(),
    true,
  );
  panel = await begin('daily_self_review', 'Заявки');
  await panel.getByText('Заявку проверяет другой администратор.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Одобрить', exact: true }).count(), 0);

  panel = await setting('daily_safe_categories', 'Категории и правила');
  const order = panel.getByRole('button', { name: 'Изменить порядок категорий', exact: true });
  await order.click();
  await panel.getByRole('button', { name: 'Ниже: Услуги', exact: true }).click();
  await panel.getByRole('button', { name: 'Выше: Услуги', exact: true }).click();
  assert.equal(
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).count(),
    0,
    'restoring category order clears semantic dirty state',
  );
  await panel.getByRole('button', { name: 'Ниже: Услуги', exact: true }).click();
  await panel.getByRole('button', { name: 'Готово', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: /^Выше:|^Ниже:/u }).count(), 0);
  await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await panel.locator('.storefront-workspace__actions button').waitFor({ state: 'detached' });
  assert.equal((await requests('rules_preview')).length, 1);
  assert.equal((await requests('rules_update')).length, 1, 'safe save performs one domain write');
  const preview = (await requests('rules_preview'))[0].body.command.input;
  const update = (await requests('rules_update'))[0].body.command.input;
  assert.deepEqual(
    {
      expectedPolicyRevision: update.expectedPolicyRevision,
      rules: update.rules,
      effectiveAt: update.effectiveAt,
      requiresAcceptance: update.requiresAcceptance,
    },
    preview,
  );
  assert.equal(update.fingerprint, 'a'.repeat(64));
  assert.equal(
    await panel.getByRole('button', { name: 'Применить категории и правила', exact: true }).count(),
    0,
  );
  await shot('daily-safe-categories', panel);

  for (const scenario of ['daily_retired_appearance', 'daily_appearance_closed']) {
    panel = await begin(scenario, 'Настройки');
    assert.equal(await panel.getByRole('button', { name: /Оформление/ }).count(), 0);
    assert.equal(await panel.locator('input[type="file"]').count(), 0);
    assert.equal(await panel.getByLabel('Название', { exact: true }).count(), 0);
    assert.equal(await panel.getByLabel('Описание', { exact: true }).count(), 0);
    for (const operation of [
      'appearance',
      'appearance_apply',
      'appearance_save',
      'appearance_publish',
      'image',
    ])
      assert.equal((await requests(operation)).length, 0, 'retired design has no new calls');
    await shot('daily-without-marketplace-design', panel);
  }
  console.log(
    'Daily UX: decisions, page append, reorder, permissions, categories and retired Marketplace design passed.',
  );
}
const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/shop-`),
  output = await mkdtemp('/tmp/maxim-shop-management-');
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/'),
  url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
let server;
let count = 0;
let dailyProfiles = 0;
let additionalCases = 0;
console.log(`Shop browser artifacts: ${output}`);
try {
  server = await ensureMiniappDevServer(base);
  for (const [engineName, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ].filter(
    ([name]) => !process.env.SHOP_BROWSER_ENGINE || name === process.env.SHOP_BROWSER_ENGINE,
  )) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const width of process.env.SHOP_BROWSER_WIDTH
        ? [Number(process.env.SHOP_BROWSER_WIDTH)]
        : [320, 360, 375, 390, 430, 480])
        for (const theme of process.env.SHOP_BROWSER_THEME
          ? [process.env.SHOP_BROWSER_THEME]
          : ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: Number(process.env.SHOP_BROWSER_HEIGHT ?? 780) },
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
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
            let panel;
            const shot = async (name, panel) => {
              await settleVisualFrame(page);
              assert.ok(
                await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
                `${name}: overflow`,
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
                `${name}: touch size`,
              );
              await page.screenshot({
                path: `${output}/${engineName}-${width}-${theme}-${name}.png`,
              });
            };
            const close = async (name) => {
              await page.getByRole('dialog', { name, exact: true }).waitFor();
              await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              if (
                ['Категории и правила', 'Подключённые чаты', 'Объявления в чате'].includes(name)
              ) {
                await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor();
                await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              }
              await home.waitFor();
            };
            const showInvitations = async (sheet) => {
              const details = sheet.locator('details.karavan-shop__invitations');
              await details.locator('summary').waitFor();
              if (!(await details.evaluate((node) => node.open)))
                await details.locator('summary').click();
            };
            const openSetting = async (name) => {
              await home.getByRole('button', { name: 'Настройки', exact: true }).click();
              await page
                .getByRole('dialog', { name: 'Настройки', exact: true })
                .getByRole('button', { name, exact: true })
                .click();
            };
            if (
              !process.env.SHOP_BROWSER_GROUP ||
              process.env.SHOP_BROWSER_GROUP === 'seller-entry'
            ) {
              for (const [scenario, screen, label] of [
                ['empty', 'Товары и услуги', 'Добавить свой товар или услугу'],
                ['own_profile', 'Заявки', 'Управлять своим размещением'],
              ]) {
                await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
                await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
                await home.getByRole('button', { name: screen, exact: true }).click();
                const destination = page.getByRole('dialog', { name: screen, exact: true });
                await destination.getByRole('button', { name: label, exact: true }).click();
                await page.waitForFunction(() => window.__shopOpened.length > 0);
                const opened = await page.evaluate(() => window.__shopOpened.at(-1));
                assert.equal(new URL(opened).searchParams.get('startapp'), `mh_${'x'.repeat(43)}`);
                const handoffs = await page.evaluate(() =>
                  window.__shopRequests.filter((row) => row.path.endsWith('/handoffs')),
                );
                assert.equal(handoffs.length, 1);
                assert.equal(handoffs[0].body.destination, 'placement');
                assert.equal(
                  handoffs[0].body.marketplaceId,
                  'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',
                );
                assert.equal(
                  Object.hasOwn(handoffs[0].body, 'storeId'),
                  false,
                  'server handoff does not trust a browser-selected Store',
                );
                assert.equal(
                  await destination.getByRole('button', { name: 'Одобрить', exact: true }).count(),
                  0,
                );
                assert.equal(
                  await page.evaluate(
                    () =>
                      window.__shopRequests.filter(
                        (row) => row.body?.command?.operation === 'invitation_create',
                      ).length,
                  ),
                  0,
                  'own entry does not create a seller invitation',
                );
                await shot(`seller-entry-${scenario}`, destination);
              }
            }
            if (!['daily', 'extra', 'seller-entry'].includes(process.env.SHOP_BROWSER_GROUP)) {
              await page.goto(`${url}?theme=${theme}`);
              await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
              await home.getByRole('button', { name: 'Товары и услуги', exact: true }).waitFor();
              assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
              assert.deepEqual(
                (await home.locator('.karavan-shop__menu button').allTextContents()).map((text) =>
                  text.trim(),
                ),
                ['Товары и услуги', 'Заявки', 'Настройки'],
                'the marketplace home has three clean navigation entries',
              );
              assert.equal(
                await home.locator('.karavan-shop__menu p,.karavan-shop__menu small').count(),
                0,
              );
              assert.equal(
                await home
                  .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                  .evaluate((el) => getComputedStyle(el).color),
                'rgb(255, 255, 255)',
                'primary action contrast',
              );
              await home
                .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                .click();
              await page.waitForFunction(() => window.__shopOpened.length === 1);
              assert.ok(
                (await page.evaluate(() => window.__shopOpened[0])).includes('synthetic_buyer_bot'),
              );
              await shot('home', home);
              await openSetting('Объявления в чате');
              const responsePanel = page.getByRole('dialog', {
                name: 'Объявления в чате',
                exact: true,
              });
              const responseField = responsePanel.getByRole('textbox', {
                name: /^Текст ответа бота/,
              });
              assert.equal(await responseField.isVisible(), false);
              await page.evaluate(() => window.__setShopResponseError());
              await responseField.waitFor();
              await responseField.fill('Исправленный текст');
              assert.equal(
                await responsePanel
                  .locator('.settings-storefront-editor__edit')
                  .evaluate((node) => node.open),
                true,
                'correcting an error keeps the text editor open',
              );
              await responseField.fill('');
              await responsePanel.getByText('Изменить текст', { exact: true }).click();
              await close('Объявления в чате');
              await home.getByRole('button', { name: 'Товары и услуги', exact: true }).click();
              panel = page.getByRole('dialog', { name: 'Товары и услуги', exact: true });
              assert.equal(await page.getByRole('dialog').count(), 1, 'one storefront workspace');
              await panel
                .getByRole('tabpanel', { name: 'Продавцы', exact: true })
                .getByText('Продавцов пока нет')
                .waitFor();
              assert.equal(
                await panel
                  .getByRole('tab', { name: 'Продавцы', exact: true })
                  .getAttribute('aria-selected'),
                'true',
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'catalog',
                    ).length,
                ),
                0,
                'opening storefronts does not fetch product offers',
              );
              await panel.getByRole('tab', { name: 'Продавцы', exact: true }).focus();
              await page.keyboard.press('ArrowRight');
              await panel.getByRole('tabpanel', { name: 'Товары и услуги', exact: true }).waitFor();
              await panel.getByRole('button', { name: 'Закрепить', exact: true }).click();
              await panel.getByText('Закреплённые · 1', { exact: true }).waitFor();
              await panel.getByRole('button', { name: 'Скрыть', exact: true }).click();
              await panel
                .getByLabel('Причина скрытия', { exact: true })
                .fill('Не соответствует правилам');
              await panel.getByRole('button', { name: 'Скрыть объявление', exact: true }).click();
              await panel.getByRole('button', { name: 'Снять ограничение', exact: true }).waitFor();
              await shot('catalog', panel);
              await close('Товары и услуги');
              await home.getByRole('button', { name: 'Настройки', exact: true }).click();
              panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
              assert.equal(await panel.getByRole('button', { name: /Оформление/ }).count(), 0);
              assert.equal(await panel.locator('input[type="file"]').count(), 0);
              await close('Настройки');
              await openSetting('Подключённые чаты');
              await page.getByRole('button', { name: 'Подключить чаты', exact: true }).click();
              await page.getByText('Другие чаты', { exact: true }).waitFor();
              await page.waitForFunction(() => {
                const fields = document.querySelector('.karavan-module__wizard-fields');
                return fields && !fields.disabled;
              });
              await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              await page.getByRole('button', { name: 'Подключить чаты', exact: true }).waitFor();
              await close('Подключённые чаты');
              await openSetting('Категории и правила');
              panel = page.getByRole('dialog', { name: 'Категории и правила', exact: true });
              await panel.getByText('Услуги', { exact: true }).first().click();
              assert.equal(
                await panel
                  .getByRole('checkbox', { name: 'Вся категория' })
                  .first()
                  .evaluate((el) => el.indeterminate),
                true,
              );
              await panel.getByRole('checkbox', { name: 'Ремонт', exact: true }).uncheck();
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .waitFor();
              const preview = await page.evaluate(
                () =>
                  window.__shopRequests
                    .filter((row) => row.body?.command?.operation === 'rules_preview')
                    .at(-1).body.command.input,
              );
              assert.ok(
                Date.parse(preview.effectiveAt) > Date.now() + 14 * 86400000,
                'hidden approved sellers retain notice period',
              );
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .click();
              await panel.getByRole('button', { name: 'Обновить данные', exact: true }).click();
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
              assert.equal(
                await panel
                  .getByRole('button', { name: 'Применить категории и правила', exact: true })
                  .count(),
                0,
              );
              assert.equal(
                await panel.getByRole('checkbox', { name: 'Ремонт', exact: true }).isChecked(),
                false,
              );
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests
                      .filter((row) => row.body?.command?.operation === 'rules_preview')
                      .at(-1).body.command.input.expectedPolicyRevision,
                ),
                2,
              );
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .click();
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .waitFor({ state: 'detached' });
              await shot('categories', panel);
              await close('Категории и правила');
              await home.getByRole('button', { name: 'Настройки', exact: true }).click();
              panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
              assert.equal(
                await panel.getByRole('radio', { name: 'Все желающие', exact: true }).isChecked(),
                true,
              );
              assert.equal(
                await panel
                  .getByRole('button', { name: 'Пригласить продавца', exact: true })
                  .count(),
                0,
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'invitations',
                    ).length,
                ),
                0,
                'open admission does not fetch invitation controls',
              );
              await panel.getByRole('radio', { name: 'По приглашению', exact: true }).check();
              assert.equal(
                await panel
                  .getByRole('button', { name: 'Пригласить продавца', exact: true })
                  .count(),
                0,
                'unsaved invitation policy cannot expose an invitation',
              );
              await close('Настройки');
              await home.getByRole('button', { name: 'Настройки', exact: true }).click();
              assert.equal(
                await panel.getByRole('radio', { name: 'По приглашению', exact: true }).isChecked(),
                true,
                'internal Back preserves admission draft',
              );
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await panel.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
              await panel
                .getByRole('button', { name: 'Пригласить продавца', exact: true })
                .waitFor();
              const admissionWrites = await page.evaluate(() =>
                window.__shopRequests.filter((row) => row.body?.command?.operation === 'settings'),
              );
              assert.equal(admissionWrites.length, 2);
              assert.deepEqual(
                admissionWrites[1].body,
                admissionWrites[0].body,
                'admission retry preserves the immutable command',
              );
              await panel.getByRole('button', { name: 'Пригласить продавца', exact: true }).click();
              await panel.getByRole('button', { name: 'Скопировать ссылку', exact: true }).click();
              await panel.getByRole('status').filter({ hasText: 'Ссылка скопирована' }).waitFor();
              assert.deepEqual(await page.evaluate(() => window.__shopClipboard), [
                'https://max.ru/synthetic_seller_bot?startapp=invite_synthetic',
              ]);
              await panel.getByRole('button', { name: 'Пригласить продавца', exact: true }).click();
              await panel.getByRole('button', { name: 'Скопировать ссылку', exact: true }).click();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'invitation_create',
                    ).length,
                ),
                1,
                'copying the same invitation never creates another invitation',
              );
              await showInvitations(panel);
              await panel
                .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                .click();
              await panel
                .getByRole('button', { name: 'Пригласить продавца', exact: true })
                .waitFor();
              await page.evaluate(() => {
                window.__dropShopInvitationUrl = true;
              });
              await panel.getByRole('button', { name: 'Пригласить продавца', exact: true }).click();
              await panel
                .getByRole('alert')
                .filter({ hasText: 'Ссылка не сохранилась.' })
                .waitFor();
              await showInvitations(panel);
              await panel
                .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                .click();
              await panel
                .getByRole('alert')
                .filter({ hasText: 'Ссылка не сохранилась.' })
                .waitFor({ state: 'detached' });
              await panel.getByRole('button', { name: 'Пригласить продавца', exact: true }).click();
              await panel.getByRole('button', { name: 'Скопировать ссылку', exact: true }).click();
              await panel.getByRole('status').filter({ hasText: 'Ссылка скопирована' }).waitFor();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'invitation_create',
                    ).length,
                ),
                3,
                'revoking a lost invitation allows a new invitation',
              );
              await panel.getByRole('radio', { name: 'Все желающие', exact: true }).check();
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await panel
                .getByRole('status')
                .filter({ hasText: 'Ссылка скопирована' })
                .waitFor({ state: 'detached' });
              await panel
                .getByRole('button', { name: 'Сохранить', exact: true })
                .waitFor({ state: 'detached' });
              await panel
                .getByRole('button', { name: 'Пригласить продавца', exact: true })
                .waitFor({ state: 'detached' });
              assert.equal(
                await panel
                  .getByRole('button', { name: 'Пригласить продавца', exact: true })
                  .count(),
                0,
              );
              await shot('admission', panel);
              await close('Настройки');
              await home.getByRole('button', { name: 'Заявки', exact: true }).click();
              panel = page.getByRole('dialog', { name: 'Заявки', exact: true });
              const applications = panel.locator('[data-storefront-screen="applications"]');
              await applications
                .locator('summary')
                .filter({ hasText: /^Товары и услуги$/u })
                .click();
              await applications
                .getByText('Ремонт стиральной машины с выездом на дом', { exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__shopRequests.filter((row) => row.body?.command?.operation === 'decide')
                      .length,
                ),
                0,
                'reviewing application content does not approve it',
              );
              await panel.getByRole('button', { name: 'Одобрить', exact: true }).click();
              await panel.getByText('Продавец одобрен', { exact: true }).waitFor();
              await panel.getByText('Новых заявок нет').waitFor();
              await close('Заявки');
              await openSetting('Объявления в чате');
              panel = page.getByRole('dialog', { name: 'Объявления в чате', exact: true });
              assert.equal(
                await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).isVisible(),
                false,
              );
              await panel.getByText('Изменить текст', { exact: true }).click();
              await panel
                .getByRole('textbox', { name: /^Текст ответа бота/ })
                .fill('Магазин нашего чата');
              assert.equal(await page.evaluate(() => window.__shopSaves.length), 0);
              await close('Объявления в чате');
              await openSetting('Объявления в чате');
              assert.equal(
                await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).inputValue(),
                'Магазин нашего чата',
                'internal Back preserves unsaved response',
              );
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              assert.equal(
                await page.evaluate(() => window.__shopSaves.at(-1).karavanStorefrontMessageText),
                'Магазин нашего чата',
              );
              await close('Объявления в чате');
              await openSetting('Объявления в чате');
              assert.equal(
                await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).inputValue(),
                'Магазин нашего чата',
              );
              await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).uncheck();
              await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
              assert.equal(await page.evaluate(() => window.__shopSaves.length), 2);
              await shot('publications', panel);
              await close('Объявления в чате');
              if (width === 320) {
                await openSetting('Объявления в чате');
                panel = page.getByRole('dialog', { name: 'Объявления в чате', exact: true });
                await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).check();
                const scenario = panel.getByRole('button', {
                  name: 'Нет витрины',
                  exact: true,
                });
                await scenario.click();
                assert.equal(await scenario.getAttribute('aria-pressed'), 'true');
                assert.equal(
                  await scenario.evaluate((el) => getComputedStyle(el).color),
                  'rgb(255, 255, 255)',
                );
                assert.equal(
                  await panel.locator('.settings-storefront-editor__preview-button').count(),
                  1,
                  'chat marketplace has one catalog button',
                );
                await panel
                  .getByRole('radio', { name: 'Администраторы и выбранные пользователи' })
                  .check();
                await panel.locator('.settings-storefront__entry').nth(99).waitFor();
                await panel.getByRole('button', { name: 'Ещё пользователи' }).click();
                await panel.locator('.settings-storefront__entry').nth(101).waitFor();
                const longName =
                  'Александра Константинопольская-Рождественская — представитель районного сообщества';
                const entry = panel
                  .locator('.settings-storefront__entry')
                  .filter({ hasText: longName });
                await entry.getByRole('button', { name: `Отозвать доступ: ${longName}` }).click();
                const confirmation = page.getByRole('dialog', {
                  name: 'Отозвать доступ к добавлению ссылки?',
                });
                const name = confirmation.locator('.action-confirm-sheet__preview-title');
                assert.equal(await name.innerText(), longName);
                assert.ok(
                  await name.evaluate(
                    (node) => node.clientWidth >= 240 && node.scrollWidth <= node.clientWidth + 1,
                  ),
                );
                await page.screenshot({
                  path: `${output}/${engineName}-${width}-${theme}-revoke.png`,
                });
                await confirmation
                  .getByRole('button', { name: 'Отозвать доступ', exact: true })
                  .click();
                await confirmation.waitFor({ state: 'detached' });
                await entry.waitFor({ state: 'detached' });
                await panel.locator('.settings-drilldown__body').evaluate((node) => {
                  node.scrollTop = 250;
                });
                const scroll = await panel
                  .locator('.settings-drilldown__body')
                  .evaluate((node) => node.scrollTop);
                await close('Объявления в чате');
                await openSetting('Объявления в чате');
                assert.equal(
                  await panel
                    .locator('.settings-drilldown__body')
                    .evaluate((node) => node.scrollTop),
                  scroll,
                  'Back restores scroll',
                );
                await page.setViewportSize({ width: 320, height: 480 });
                await page.evaluate(() => {
                  document.documentElement.style.fontSize = '24px';
                });
                await panel.getByText('Изменить текст', { exact: true }).click();
                const response = panel.getByRole('textbox', { name: /^Текст ответа бота/ });
                await response.fill('Несохранённый текст');
                await response.focus();
                await shot('short-large-text', panel);
                const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
                assert.ok(
                  await save.evaluate((node) => {
                    const r = node.getBoundingClientRect();
                    return r.top >= 0 && r.bottom <= innerHeight;
                  }),
                  'save remains visible on short viewport',
                );
                await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
                const discard = page.getByRole('dialog', { name: 'Не сохранять изменения?' });
                await discard
                  .getByRole('button', { name: 'Продолжить настройку', exact: true })
                  .click();
                assert.equal(await response.inputValue(), 'Несохранённый текст');
                await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
                await discard.getByRole('button', { name: 'Не сохранять', exact: true }).click();
                await page.getByRole('dialog').waitFor({ state: 'detached' });
                await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
                await openSetting('Объявления в чате');
                assert.equal(
                  await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).isChecked(),
                  false,
                  'explicit discard restores saved settings',
                );
                await close('Объявления в чате');
                await page.setViewportSize({
                  width,
                  height: Number(process.env.SHOP_BROWSER_HEIGHT ?? 780),
                });
                await page.evaluate(() =>
                  document.documentElement.style.removeProperty('font-size'),
                );
              }
              assert.deepEqual(errors, []);
              count++;
              console.log(`Shop journey ${engineName}/${width}/${theme}: passed (${count}).`);
            }
            if (
              !['daily', 'seller-entry'].includes(process.env.SHOP_BROWSER_GROUP) &&
              (process.env.SHOP_BROWSER_WIDTH || (width === 360 && theme === 'light'))
            )
              for (const scenario of [
                'empty',
                'error',
                'unbound',
                'draft',
                'draft_empty',
                'invitation_paged',
                'permission_loss',
              ].filter(
                (scenario) =>
                  !process.env.SHOP_BROWSER_SCENARIOS ||
                  process.env.SHOP_BROWSER_SCENARIOS.split(',').includes(scenario),
              )) {
                additionalCases++;
                await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
                await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
                if (['draft', 'draft_empty'].includes(scenario)) {
                  let availability = home;
                  if (scenario === 'draft_empty') {
                    await availability
                      .getByRole('button', { name: 'Ссылка для продавцов', exact: true })
                      .waitFor();
                    await home.getByRole('button', { name: 'Настройки', exact: true }).click();
                    const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
                    availability = settings;
                    await settings
                      .getByRole('region', { name: 'Доступность магазина', exact: true })
                      .waitFor();
                  }
                  await availability
                    .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                    .waitFor();
                  assert.equal(
                    await availability
                      .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                      .count(),
                    0,
                  );
                  assert.equal(
                    await page.evaluate(
                      () =>
                        window.__shopRequests.filter(
                          (row) => row.body?.command?.operation === 'status',
                        ).length,
                    ),
                    0,
                  );
                  await availability
                    .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                    .click();
                  if (scenario === 'draft_empty') {
                    await availability
                      .getByText('Открыть магазин без продавцов?', { exact: true })
                      .waitFor();
                    await availability
                      .locator('.karavan-shop__row')
                      .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                      .click();
                    await availability
                      .getByRole('button', { name: 'Повторить проверку', exact: true })
                      .click();
                  }
                  if (scenario === 'draft_empty') await close('Настройки');
                  await home
                    .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                    .waitFor();
                  const statusWrites = await page.evaluate(() =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'status',
                    ),
                  );
                  const status = statusWrites[0].body.command.input;
                  assert.equal(status.status, 'active');
                  assert.equal(status.allowEmpty, scenario === 'draft_empty');
                  if (scenario === 'draft_empty') {
                    assert.equal(statusWrites.length, 2);
                    assert.deepEqual(statusWrites[1].body, statusWrites[0].body);
                    assert.equal(
                      await availability
                        .getByText('Приостановить просмотр магазина покупателями?', {
                          exact: true,
                        })
                        .count(),
                      0,
                      'successful activation retry closes its confirmation',
                    );
                  }
                  await shot(`opened-${scenario}`, home);
                  continue;
                }
                if (scenario === 'permission_loss') {
                  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
                  panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
                  await panel.getByRole('radio', { name: 'По приглашению', exact: true }).check();
                  await panel.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
                  await page.evaluate(() => window.__loseShopManage());
                  await panel
                    .getByRole('button', { name: 'Сохранить', exact: true })
                    .waitFor({ state: 'detached' });
                  assert.equal(await panel.getByRole('radio').count(), 0);
                  assert.equal(
                    await page.evaluate(
                      () =>
                        window.__shopRequests.filter(
                          (row) => row.body?.command?.operation === 'settings',
                        ).length,
                    ),
                    0,
                    'losing manage permission cannot submit an existing settings draft',
                  );
                  await shot(scenario, panel);
                  continue;
                }
                if (scenario === 'invitation_paged') {
                  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
                  panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
                  await showInvitations(panel);
                  await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
                  await panel.getByText('· использовано 25', { exact: false }).waitFor();
                  assert.equal(
                    await panel
                      .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                      .count(),
                    25,
                    'loading another page keeps the first invitations',
                  );
                  await page.evaluate(() => {
                    window.__dropShopInvitationUrl = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Пригласить продавца', exact: true })
                    .click();
                  const lost = panel
                    .getByRole('alert')
                    .filter({ hasText: 'Ссылка не сохранилась.' });
                  await lost.waitFor();
                  const minted = panel
                    .locator('.karavan-shop__row')
                    .filter({ hasText: /использовано\s+0/u });
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .waitFor();
                  assert.equal(
                    await panel
                      .getByRole('button', { name: 'В начало списка', exact: true })
                      .count(),
                    0,
                    'creating after loading pages exposes the new invitation without replacing earlier rows',
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await lost.waitFor({ state: 'detached' });
                  await page.evaluate(() => {
                    window.__deferShopClipboard = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Пригласить продавца', exact: true })
                    .click();
                  await panel
                    .getByRole('button', { name: 'Скопировать ссылку', exact: true })
                    .click();
                  await page.waitForFunction(
                    () => typeof window.__finishShopClipboard === 'function',
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await page.evaluate(() => {
                    window.__dropShopInvitationUrl = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Пригласить продавца', exact: true })
                    .click();
                  await lost.waitFor();
                  await page.evaluate(() => window.__finishShopClipboard());
                  await settleVisualFrame(page);
                  assert.equal(
                    await lost.isVisible(),
                    true,
                    'late clipboard completion cannot clear a newer lost invitation',
                  );
                  assert.equal(
                    await panel
                      .getByRole('button', { name: 'Пригласить продавца', exact: true })
                      .isDisabled(),
                    true,
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await lost.waitFor({ state: 'detached' });
                  await panel
                    .getByRole('button', { name: 'Пригласить продавца', exact: true })
                    .click();
                  await panel
                    .getByRole('button', { name: 'Скопировать ссылку', exact: true })
                    .click();
                  await panel
                    .getByRole('status')
                    .filter({ hasText: 'Ссылка скопирована' })
                    .waitFor();
                  await shot(scenario, panel);
                  continue;
                }
                if (scenario === 'unbound') {
                  await home
                    .getByRole('textbox', { name: 'Название магазина', exact: true })
                    .waitFor();
                  assert.equal(
                    await home
                      .getByRole('button', { name: 'Подключить магазин', exact: true })
                      .count(),
                    0,
                  );
                  assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
                  assert.ok(
                    (await page.evaluate(() => window.__shopRequests)).every(
                      (row) => !row.path.endsWith('/setup') && !row.path.includes('/bindings/'),
                    ),
                    'entering setup never creates or binds a marketplace',
                  );
                  await shot(scenario, home);
                  assert.deepEqual(errors, []);
                  continue;
                }
                await page.getByRole('button', { name: 'Товары и услуги', exact: true }).click();
                panel = page.getByRole('dialog', { name: 'Товары и услуги', exact: true });
                await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
                if (scenario === 'error') {
                  await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
                  await panel.getByRole('button', { name: 'Закрепить', exact: true }).waitFor();
                } else await panel.getByText('Товаров и услуг пока нет').waitFor();
                await shot(scenario, panel);
                assert.deepEqual(errors, []);
              }
            if (
              !['extra', 'seller-entry'].includes(process.env.SHOP_BROWSER_GROUP) &&
              (process.env.SHOP_BROWSER_WIDTH || (width === 360 && theme === 'light'))
            ) {
              await runDailyChecks({ page, url, theme, shot });
              dailyProfiles++;
              console.log(`Daily profile ${engineName}/${width}/${theme}: passed.`);
            }
            assert.deepEqual(errors, []);
          } catch (error) {
            const page = context.pages()[0];
            if (page) {
              await page.screenshot({ path: `${output}/failure.png` });
              console.error((await page.locator('body').innerText()).slice(-5000));
            }
            throw error;
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
  if (process.env.SHOP_BROWSER_NATIVE_SHARE !== '0') await runShopNativeShareChecks({ base, url });
  console.log(
    `Shop management browser: ${count} main journeys, ${additionalCases} additional cases, ${dailyProfiles} daily UX profiles passed. Screenshots: ${output}`,
  );
} finally {
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
