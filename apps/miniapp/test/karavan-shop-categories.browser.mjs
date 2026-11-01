import assert from 'node:assert/strict';
import { karavanMarketplaceCategories } from '@maxim/contracts/karavan-marketplace';

export async function runShopCategoryChecks({ begin, page, home, requests, shot }) {
  await begin('daily_safe_categories');
  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Настройки', exact: true })
    .getByRole('button', { name: 'Категории и правила', exact: true })
    .click();
  const panel = page.getByRole('dialog', { name: 'Категории и правила', exact: true });
  const services = panel.locator('.karavan-shop__category').filter({ hasText: 'Услуги' });
  await services.locator('summary').click();
  const whole = services.getByRole('checkbox', { name: 'Вся категория', exact: true });
  assert.equal(await whole.evaluate((input) => input.indeterminate), true);
  await whole.check();
  await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() =>
    window.__shopRequests.some((row) => row.body?.command?.operation === 'rules_update'),
  );
  await panel
    .getByRole('button', { name: 'Сохранить', exact: true })
    .waitFor({ state: 'detached' });
  const writes = await requests('rules_update');
  assert.equal(writes.length, 1);
  assert.deepEqual(
    writes[0].body.command.input.rules.allowedCategoryIds,
    ['services', 'grocery'],
    'selecting an entire partially selected category must not duplicate its identity',
  );
  assert.deepEqual([...writes[0].body.command.input.rules.allowedSubcategoryIds].sort(), [
    'grocery.bread',
    'services.beauty',
    'services.repair',
  ]);
  await shot('categories-entire-selection', panel);

  await begin('daily_property_legacy');
  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Настройки', exact: true })
    .getByRole('button', { name: 'Категории и правила', exact: true })
    .click();
  await services.locator('summary').click();
  await whole.check();
  await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() =>
    window.__shopRequests.some((row) => row.body?.command?.operation === 'rules_update'),
  );
  const legacyWrite = (await requests('rules_update'))[0].body.command.input;
  assert.deepEqual([...legacyWrite.rules.allowedSubcategoryIds].sort(), [
    'grocery.bread',
    'real_estate.room',
    'services.beauty',
    'services.repair',
  ]);
  assert.equal(
    legacyWrite.requiresAcceptance,
    false,
    'hidden legacy property selections are preserved',
  );

  await begin('daily_full_categories');
  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Настройки', exact: true })
    .getByRole('button', { name: 'Категории и правила', exact: true })
    .click();
  await panel.locator('.karavan-shop__category').first().waitFor();
  assert.equal(await panel.locator('.karavan-shop__category').count(), 17);
  for (const [, label] of karavanMarketplaceCategories) {
    const summary = panel.locator('.karavan-shop__category summary').filter({ hasText: label });
    await summary.scrollIntoViewIfNeeded();
    assert.equal(await summary.isVisible(), true, `category is reachable: ${label}`);
  }
  assert.equal((await requests('rules_update')).length, 0, 'reading the full list is not a write');
  const properties = panel.locator('.karavan-shop__category').filter({ hasText: 'Недвижимость' });
  await properties.locator('summary').click();
  assert.equal(
    await properties.getByRole('checkbox').count(),
    1,
    'property rules apply to all types',
  );
  assert.equal(
    await properties.getByRole('checkbox', { name: 'Вся категория', exact: true }).isChecked(),
    true,
    'property category remains selected without product subcategories',
  );
  await shot('categories-full-taxonomy', panel);

  await begin('daily_category_legacy_order');
  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Настройки', exact: true })
    .getByRole('button', { name: 'Категории и правила', exact: true })
    .click();
  await panel.locator('.karavan-shop__category').first().waitFor();
  await panel.getByRole('button', { name: 'Изменить порядок категорий', exact: true }).click();
  assert.deepEqual(await panel.locator('.karavan-shop__block > span').allTextContents(), [
    'Продукты',
    'Услуги',
  ]);
  await panel.getByRole('button', { name: 'Ниже: Продукты', exact: true }).click();
  await panel.getByRole('button', { name: 'Выше: Продукты', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: 'Сохранить', exact: true }).count(), 0);

  await begin('format_setup_full_categories');
  await home.getByRole('button', { name: /^Магазин участников/ }).click();
  await home
    .locator('.karavan-module__setup-rules > summary')
    .filter({ hasText: 'Категории и правила' })
    .click();
  const categories = home.getByRole('group', { name: 'Разрешённые категории', exact: true });
  assert.equal(await categories.locator(':scope > div').count(), 17);
  const propertyChoice = categories.locator(':scope > div').filter({ hasText: 'Недвижимость' });
  assert.equal(await propertyChoice.locator('details').count(), 0);
  await shot('categories-full-setup', home);
}
