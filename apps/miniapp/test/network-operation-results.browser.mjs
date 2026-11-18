import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:5197/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Operation results checks require a local dev server');
}
for (const [engine, viewport, colorScheme] of [
  ['webkit', { width: 320, height: 504 }, 'light'],
  ['chromium', { width: 412, height: 811 }, 'dark'],
]) {
  const browser = await { chromium, webkit }[engine].launch(
    captureBrowserLaunchOptions(engine, base.href),
  );
  try {
    const page = await browser.newPage({ viewport, colorScheme });
    await page.goto(new URL('?preview=1&networks=1', base).href);
    await page.locator('.bottom-nav').waitFor();
    await page.evaluate(async () => {
      const fixture = await import('/app/test/browser/network-operation-results-fixture.tsx');
      fixture.mountNetworkOperationResultsFixture();
    });
    const search = page.getByRole('searchbox', { name: 'Поиск получателей' });
    const clear = page.getByRole('button', { name: 'Очистить: Поиск получателей' });
    const bounds = await clear.boundingBox();
    assert.ok(bounds.width >= 44 && bounds.height >= 44);
    await clear.click();
    assert.equal(await search.inputValue(), '');
    assert.equal(await search.evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(
      await search.evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.borderWidth, style.outlineStyle, style.backgroundColor];
      }),
      ['0px', 'none', 'rgba(0, 0, 0, 0)'],
    );
    assert.equal(await clear.count(), 0);
    await search.fill('Новый запрос');
    await clear.click();
    assert.equal(await search.inputValue(), '');
    const failures = page.locator('.network-settings-failures');
    const rows = failures.locator('li');
    const details = page.locator('.network-settings-details');
    assert.equal(await details.getAttribute('open'), null);
    assert.equal(await rows.count(), 50);
    assert.ok((await failures.innerText()).includes('Не применено · 120'));
    assert.deepEqual(
      await rows
        .locator('strong')
        .allTextContents()
        .then((names) => names.slice(0, 2)),
      ['Чат №1', 'Чат №2'],
    );
    await failures.getByRole('button', { name: 'Показать ещё ошибки · 50' }).click();
    assert.equal(await rows.count(), 100);
    await failures.getByRole('button', { name: 'Показать ещё ошибки · 20' }).click();
    assert.equal(await rows.count(), 120);
    assert.equal(await details.getAttribute('open'), null);
    await details.locator('summary').click();
    assert.equal(await details.locator('li').count(), 50);
    await details.getByRole('button', { name: 'Показать ещё результаты' }).click();
    assert.equal(await details.locator('li').count(), 60);
    assert.equal(await rows.count(), 120);
    await page.getByRole('button', { name: 'Продолжить наблюдение' }).click();
    assert.match(await page.getByRole('status').innerText(), /Применяем настройки/u);
    await page.getByRole('button', { name: 'Получить итог' }).click();
    assert.match(await page.getByRole('status').innerText(), /Изменения не применены/u);
    assert.match(await page.getByRole('status').innerText(), /60 из 180/u);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    console.log(
      `${engine} ${viewport.width}px ${colorScheme}: 120 failures, independent details, search clear/focus passed`,
    );
  } finally {
    await browser.close();
  }
}
