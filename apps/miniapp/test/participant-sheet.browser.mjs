import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/';
const screenshotDir = mkdtempSync(join(tmpdir(), 'maxim-participant-sheet-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/participant-sheet-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/app/test/fixtures/participant-sheet-harness.tsx');
  </script></body></html>`,
  }),
);

const fresh = async () => {
  await page.goto(new URL('participant-sheet-test', base).href);
  await page.getByRole('dialog').waitFor();
};
const render = (options) =>
  page.evaluate((next) => window.participantSheetTest.render(next), options);
const actions = () => page.evaluate(() => window.participantSheetTest.actions);

try {
  await fresh();
  await page.getByRole('button', { name: 'Мут', exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.id === 'participant-sheet-mute-composer',
  );
  await page.getByRole('button', { name: '6 ч', exact: true }).click();
  await page.getByRole('button', { name: 'К участнику', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('participant-sheet__action--mute'),
  );
  await page.getByRole('button', { name: 'Мут', exact: true }).click();
  assert.equal(
    await page.getByRole('slider', { name: 'Срок ограничения в часах' }).inputValue(),
    '24',
  );
  console.log(
    'PASS: editor focus returns to its command and discarding resets the unsaved duration',
  );

  await fresh();
  await page.getByRole('button', { name: 'Мут', exact: true }).click();
  await page.getByRole('button', { name: '6 ч', exact: true }).click();
  assert.equal(
    await page.getByRole('slider', { name: 'Срок ограничения в часах' }).inputValue(),
    '6',
  );
  await page.getByRole('button', { name: 'Назначить мут', exact: true }).click();
  assert.deepEqual(await actions(), [{ kind: 'mute', payload: 6 }]);
  await page.getByRole('button', { name: 'Как работает мут' }).click();
  assert.match(
    await page.locator('#participant-sheet-hint-mute').innerText(),
    /после возвращения/u,
  );
  await page.evaluate(() => window.participantSheetTest.back());
  await page.locator('#participant-sheet-hint-mute').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#participant-sheet-hint-mute').count(), 0);
  assert.equal(await page.locator('#participant-sheet-mute-composer').count(), 1);
  await render({ isApplyingModeration: true });
  await page.locator('#participant-sheet-mute-composer input:disabled').waitFor();
  assert.equal(await page.getByRole('slider').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '6 ч', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.participantSheetTest.back());
  assert.equal(await page.locator('#participant-sheet-mute-composer').count(), 1);
  assert.deepEqual(await actions(), [{ kind: 'mute', payload: 6 }]);
  console.log(
    'PASS: duration presets submit the selected value; busy moderation locks edits and native back',
  );

  await fresh();
  await page.getByRole('button', { name: 'Защита', exact: true }).click();
  await page.getByRole('button', { name: 'Что делает защита' }).click();
  await page.getByRole('radio', { name: 'На срок' }).focus();
  await page.keyboard.press('End');
  await page.locator('[data-immunity-mode="always"][aria-checked="true"]').waitFor();
  assert.equal(
    await page.getByRole('radio', { name: 'Всегда' }).getAttribute('aria-checked'),
    'true',
  );
  assert.match(
    await page.locator('#participant-sheet-hint-immunity').innerText(),
    /пока вы её не снимете/u,
  );
  assert.equal(await page.getByRole('slider').count(), 0);
  await page.getByRole('button', { name: 'Сохранить защиту', exact: true }).click();
  assert.deepEqual(await actions(), [{ kind: 'save', payload: { mode: 'always' } }]);
  assert.equal(
    await page.getByRole('button', { name: 'Сохраняем...', exact: true }).getAttribute('aria-busy'),
    'true',
  );
  console.log(
    'PASS: unlimited protection has matching help text, radio navigation and a minimal payload',
  );

  await fresh();
  await page.evaluate(() =>
    window.participantSheetTest.render({
      item: {
        ...window.participantSheetTest.participant,
        immunity: { mode: 'always', expiresAt: null, dailyViolationLimit: null },
      },
    }),
  );
  await page.getByRole('button', { name: 'Защита', exact: true }).click();
  assert.equal(
    await page.getByRole('radio', { name: 'Всегда' }).getAttribute('aria-checked'),
    'true',
  );
  await page.getByRole('button', { name: 'Снять защиту', exact: true }).click();
  assert.deepEqual(await actions(), [{ kind: 'clear' }]);
  assert.equal(
    await page.getByRole('button', { name: 'Снимаем...', exact: true }).getAttribute('aria-busy'),
    'true',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Сохранить защиту', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'Сохраняем...', exact: true }).count(), 0);
  console.log('PASS: only the chosen protection action shows progress');

  await fresh();
  await page.getByRole('button', { name: 'Защита', exact: true }).click();
  await page.getByRole('slider', { name: 'Срок защиты в днях' }).fill('7');
  await page.getByRole('slider', { name: 'Лимит сообщений с нарушениями в день' }).fill('5');
  await page.evaluate(() =>
    window.participantSheetTest.render({
      item: { ...window.participantSheetTest.participant, violationCount: 4 },
    }),
  );
  await page.getByRole('button', { name: 'К участнику', exact: true }).click();
  await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: 'Срок защиты в днях' }).inputValue(), '7');
  await page.getByRole('button', { name: 'Сохранить защиту', exact: true }).click();
  assert.deepEqual(await actions(), [
    {
      kind: 'save',
      payload: {
        mode: 'limited',
        durationHours: 168,
        dailyViolationLimit: 5,
      },
    },
  ]);
  for (const slider of await page.getByRole('slider').all())
    assert.equal(await slider.isDisabled(), true);
  await page.evaluate(() =>
    window.participantSheetTest.render({
      isSavingImmunity: false,
      item: { ...window.participantSheetTest.participant, userId: '654321' },
    }),
  );
  await page.locator('#participant-sheet-immunity-composer').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Защита', exact: true }).click();
  assert.equal(await page.getByRole('slider', { name: 'Срок защиты в днях' }).inputValue(), '3');
  assert.equal(
    await page.getByRole('slider', { name: 'Лимит сообщений с нарушениями в день' }).inputValue(),
    '3',
  );
  console.log(
    'PASS: protection parameters are frozen while saving and reset for a different participant',
  );

  for (const role of ['owner', 'admin', 'bot']) {
    await page.evaluate(
      (role) =>
        window.participantSheetTest.render({
          item: {
            ...window.participantSheetTest.participant,
            userId: role,
            role: role === 'bot' ? 'member' : role,
            isBot: role === 'bot',
          },
        }),
      role,
    );
    await page.getByRole('button', { name: 'Бан', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Бан', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Мут', exact: true }).isDisabled(), true);
    assert.equal(
      await page.getByRole('button', { name: 'Защита', exact: true }).isDisabled(),
      true,
    );
  }
  console.log(
    'PASS: owner, administrator and bot profiles expose no unavailable moderation actions',
  );

  for (const [name, width, height, theme] of [
    ['iphone-se', 320, 568, 'light'],
    ['iphone', 390, 844, 'light'],
    ['android-dark', 412, 915, 'dark'],
    ['desktop-dark', 1280, 900, 'dark'],
  ]) {
    await page.setViewportSize({ width, height });
    await fresh();
    await page.evaluate((theme) => (document.documentElement.dataset.maxTheme = theme), theme);
    await page.getByRole('button', { name: 'Мут', exact: true }).click();
    await page.getByRole('button', { name: 'Как работает мут' }).click();
    for (const composer of ['mute', 'immunity']) {
      if (composer === 'immunity') {
        await page.getByRole('button', { name: 'К участнику', exact: true }).click();
        await page.getByRole('button', { name: 'Защита', exact: true }).click();
        await page.getByRole('button', { name: 'Что значит лимит защиты' }).click();
      }
      await page.screenshot({
        path: join(screenshotDir, `${name}-${composer}.png`),
        fullPage: true,
      });
      const overflows = await page
        .locator('.participant-sheet')
        .evaluate((panel) =>
          [...panel.querySelectorAll('button, output, .participant-sheet__hint')]
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent?.trim()),
        );
      assert.deepEqual(overflows, [], `${name} ${composer} has overflowing controls`);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: mobile and desktop controls fit in both themes; screenshots: ${screenshotDir}`,
  );
} finally {
  await browser.close();
}
