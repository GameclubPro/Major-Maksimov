import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:5175/app/';
const screenshotDir = mkdtempSync(join(tmpdir(), 'maxim-traffic-ui-'));
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height, theme, platform] of [
    ['iphone-se-light', 320, 568, 'light', 'ios'],
    ['iphone-dark', 390, 844, 'dark', 'ios'],
    ['android-light', 412, 915, 'light', 'android'],
    ['desktop-dark', 1280, 900, 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: '/* Local MAX bridge shim. */',
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
    await page.getByRole('button', { name: 'Ограничения', exact: true }).click();
    const panel = page.locator('.settings-drilldown__panel--limits');
    await panel.waitFor({ state: 'visible' });
    const lengthEnabled = panel.getByRole('checkbox', {
      name: 'Включить ограничение длины сообщения',
      exact: true,
    });
    await lengthEnabled.check();
    const length = panel.getByRole('spinbutton', { name: 'Лимит длины сообщения, символы' });
    const lengthSlider = panel.getByRole('slider', { name: 'Лимит длины сообщения', exact: true });
    await length.fill('137');
    await lengthSlider.focus();
    await lengthSlider.blur();
    assert.equal(
      await length.inputValue(),
      '137',
      'focusing a stepped range preserves exact input',
    );
    for (const invalid of ['49', '1501', '1.5', '']) {
      await length.fill(invalid);
      assert.equal(await length.getAttribute('aria-invalid'), 'true');
      const errorId = await length.getAttribute('aria-describedby');
      assert.ok(errorId);
      assert.match(await page.locator(`[id="${errorId}"]`).innerText(), /от 50 до 1500/u);
    }
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    assert.equal(await panel.isVisible(), true, 'invalid numeric draft blocks Save');
    assert.equal(await length.inputValue(), '');
    const dismissToasts = async () => {
      const close = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
      while (await close.count()) await close.first().click();
    };
    await dismissToasts();
    for (const valid of ['50', '1500', '137']) {
      await length.fill(valid);
      assert.notEqual(await length.getAttribute('aria-invalid'), 'true');
      assert.equal(await lengthSlider.getAttribute('aria-valuetext'), `${valid} символов`);
    }
    await length.fill('49');
    await lengthEnabled.uncheck();
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await dismissToasts();
    await page.getByRole('button', { name: 'Ограничения', exact: true }).click();
    assert.equal(
      await lengthEnabled.isChecked(),
      false,
      'disabling explicitly cancels the invalid numeric draft',
    );
    await lengthEnabled.check();
    assert.equal(await length.inputValue(), '137', 'last valid length remains saved');
    await lengthSlider.focus();
    await lengthSlider.press('Home');
    await lengthSlider.press('ArrowRight');
    assert.equal(await length.inputValue(), '60', 'range retains its original step of ten');
    await length.fill('137');
    if (width === 320 || width === 412) {
      await length.focus();
      await page.setViewportSize({ width, height: Math.max(320, height - 260) });
      await length.scrollIntoViewIfNeeded();
      assert.equal(
        await panel
          .locator('.settings-length-limit__value-row > .settings-native-toggle__title')
          .evaluate((element) => {
            const text = document.createRange();
            text.selectNodeContents(element);
            return text.getClientRects().length === 1;
          }),
        true,
        'maximum label stays on one line beside or above numeric field',
      );
      assert.equal(
        await length.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.height >= 44 &&
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            element ===
              document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          );
        }),
        true,
        'exact numeric input remains reachable above keyboard-sized viewport',
      );
      await page.screenshot({ path: join(screenshotDir, `${name}-exact-length-keyboard.png`) });
      await length.blur();
      await page.setViewportSize({ width, height });
    }
    await panel
      .getByRole('button', { name: 'Пояснение для лимита сообщений', exact: true })
      .click();
    const countHint = panel.locator('#message-count-limit-hint');
    await countHint.waitFor({ state: 'visible' });
    assert.match(await countHint.innerText(), /Редактирование не расходует\s+лимит/u);
    assert.match(await countHint.innerText(), /Попытки сверх лимита не продлевают ожидание/u);
    assert.match(await countHint.innerText(), /фото одного альбома — как одна публикация/u);
    await countHint.scrollIntoViewIfNeeded();
    assert.equal(
      await countHint.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      true,
    );
    await page.screenshot({ path: join(screenshotDir, `${name}-count-hint.png`) });
    await panel
      .getByRole('button', { name: 'Пояснение для лимита сообщений', exact: true })
      .click();
    assert.equal(await countHint.count(), 0);
    const phones = panel.getByRole('checkbox', { name: 'Разрешить номера телефонов', exact: true });
    const explanation = panel.getByRole('checkbox', {
      name: 'Включить сообщение от бота для ограничений сообщений',
      exact: true,
    });
    await phones.uncheck();
    await explanation.check();
    await panel.getByRole('checkbox', { name: 'Медленный режим', exact: true }).check();
    const slow = panel.getByRole('spinbutton', { name: 'Медленный режим: интервал в секундах' });
    await slow.fill('90');
    await panel.getByRole('checkbox', { name: 'Интервал для вложений', exact: true }).check();
    await panel
      .getByRole('spinbutton', { name: 'Интервал для вложений: интервал в секундах' })
      .fill('120');
    await slow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshotDir, `${name}-intervals.png`) });
    await panel
      .getByRole('checkbox', { name: 'Разрешить отправку стикеров', exact: true })
      .uncheck();
    assert.equal(
      await panel
        .getByRole('checkbox', { name: 'Ограничить отправку стикеров по времени', exact: true })
        .count(),
      0,
    );
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.settings-drilldown__footer-actions [aria-busy="true"]'),
    );
    if (await panel.isVisible())
      await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    await page.getByRole('button', { name: 'Ограничения', exact: true }).click();
    assert.equal(
      await length.inputValue(),
      '137',
      'exact numeric limit persists after Save/reopen',
    );
    assert.equal(await phones.isChecked(), false);
    assert.equal(await explanation.isChecked(), true);
    assert.equal(await slow.inputValue(), '90');
    assert.equal(
      await panel
        .getByRole('spinbutton', { name: 'Интервал для вложений: интервал в секундах' })
        .inputValue(),
      '120',
    );
    assert.equal(
      await panel
        .getByRole('checkbox', { name: 'Разрешить отправку стикеров', exact: true })
        .isChecked(),
      false,
    );
    assert.deepEqual(
      await panel.evaluate((element) =>
        [...element.querySelectorAll('input, .settings-native-toggle__title')]
          .filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2)
          .map((node) => node.getAttribute('aria-label') || node.textContent),
      ),
      [],
      `${name}: overflow`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await panel
        .locator('.settings-native-toggle__title-wrap:has(.settings-native-toggle__title-actions)')
        .evaluateAll((rows) =>
          rows.every((row) => {
            const title = row.querySelector('.settings-native-toggle__title');
            return (
              !title || title.getBoundingClientRect().width >= row.getBoundingClientRect().width - 2
            );
          }),
        ),
      true,
      `${name}: status must not squeeze the title into a narrow column`,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${name}: intervals, sticker permission, save and layout`);
  }
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
}
