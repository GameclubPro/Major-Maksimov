import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReportsPeriod } from './reports-period.browser.mjs';
import { chromium } from 'playwright';
import { clickSettingsOverviewEntry } from './settings-overview-browser-helpers.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-reports-ui-'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_TEST_REUSE_SERVER === '1',
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, theme, platform] of [
    ['iphone-se-light', 320, 568, 'light', 'ios'],
    ['iphone-se-dark', 320, 568, 'dark', 'ios'],
    ['iphone-light', 390, 844, 'light', 'ios'],
    ['iphone-dark', 390, 844, 'dark', 'ios'],
    ['android-light', 412, 915, 'light', 'android'],
    ['android-dark', 412, 915, 'dark', 'android'],
    ['desktop-dark', 1280, 900, 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '/* local bridge */' }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
    const panel = page
      .locator('.settings-drilldown__panel')
      .filter({ has: page.locator('.reports-settings') });
    const panelBounds = async () => {
      await panel.evaluate((node) =>
        Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
      );
      return panel.boundingBox();
    };
    const settingsBounds = width <= 768 ? await panelBounds() : null;
    const assertStableMobilePanel = async () => {
      const bounds = await panelBounds();
      assert.ok(
        settingsBounds &&
          bounds &&
          Math.abs(bounds.height - settingsBounds.height) <= 1 &&
          Math.abs(bounds.y - settingsBounds.y) <= 1,
        `${name}: changing reports tabs must preserve panel height and position`,
      );
    };
    if (width <= 768) {
      assert.ok(settingsBounds && settingsBounds.height >= height - 16);
      await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
      await panel.locator('.reports-journal__item').first().waitFor();
      await assertStableMobilePanel();
      await checkReportsPeriod({ page, output: screenshots, name });
      await panel.getByRole('tab', { name: 'Настройки', exact: true }).click();
    }
    await panel.getByRole('switch', { name: 'Жалобы участников', exact: true }).check();
    if (width <= 768) await panel.getByRole('radio', { name: '6 голосов', exact: true }).click();
    else await panel.getByRole('spinbutton', { name: 'Порог жалоб' }).fill('6');
    await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).fill('спам, /alert');
    if (width <= 768)
      await panel.getByRole('radio', { name: 'История за 24 часа', exact: true }).click();
    else await panel.getByRole('combobox', { name: 'Удаление' }).selectOption('HISTORY_24H');
    await panel.getByRole('switch', { name: 'Ограничить участника', exact: true }).check();
    await panel.getByRole('spinbutton', { name: 'Длительность ограничения, ч' }).fill('24');
    const scroller = panel.locator('.settings-drilldown__body');
    if (width <= 768) {
      const tracks = await panel.locator('.reports-switch__track').evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return [rect.width, rect.height];
        }),
      );
      assert.deepEqual(tracks, [
        [48, 28],
        [48, 28],
      ]);
      const switches = await panel.getByRole('switch').evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return [rect.width, rect.height];
        }),
      );
      assert.ok(switches.every(([w, h]) => w >= 44 && h >= 44));
      await panel.getByRole('button', { name: 'Уменьшить длительность ограничения' }).click();
      assert.equal(
        await panel.getByRole('spinbutton', { name: 'Длительность ограничения, ч' }).inputValue(),
        '23',
      );
      await panel.getByRole('button', { name: '24 ч', exact: true }).click();
    }
    if (name === 'iphone-se-light') {
      await page.evaluate(async () => {
        const { PREVIEW_REQUEST_HANDLERS } = await import('/app/src/lib/api/preview-transport.ts');
        const { PREVIEW_NOT_HANDLED } =
          await import('/app/src/lib/api/preview-transport-runtime.ts');
        window.__REPORTS_KEYBOARD_WRITES__ = [];
        PREVIEW_REQUEST_HANDLERS.unshift(({ method, init }) => {
          if (method !== 'GET')
            window.__REPORTS_KEYBOARD_WRITES__.push(JSON.parse(String(init.body ?? '{}')));
          return PREVIEW_NOT_HANDLED;
        });
      });
      const duration = panel.getByRole('spinbutton', { name: 'Длительность ограничения, ч' });
      const aliases = panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' });
      await duration.fill('');
      assert.equal(await duration.inputValue(), '');
      assert.equal(await duration.getAttribute('aria-invalid'), 'true');
      await panel.getByRole('alert').waitFor({ state: 'visible' });
      assert.equal(await aliases.inputValue(), 'спам, /alert');
      assert.equal(
        await panel
          .getByRole('radio', { name: '6 голосов', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await duration.fill('24');
      assert.equal(await duration.getAttribute('aria-invalid'), null);

      // The threshold uses buttons on mobile; widen this same draft to exercise its keyboard field.
      await page.setViewportSize({ width: 1024, height: 900 });
      const threshold = panel.getByRole('spinbutton', { name: 'Порог жалоб' });
      await threshold.fill('');
      assert.equal(await threshold.inputValue(), '');
      assert.equal(await threshold.getAttribute('aria-invalid'), 'true');
      await panel.getByRole('alert').waitFor({ state: 'visible' });
      assert.equal(await duration.inputValue(), '24');
      assert.equal(await aliases.inputValue(), 'спам, /alert');
      await threshold.fill('6');
      assert.equal(await threshold.getAttribute('aria-invalid'), null);
      await page.setViewportSize({ width, height });
      await applyNativeVisualMode(page, { safeTop: 47, safeBottom: 34 });

      const invalidAliases = 'one, two, three, four, five, six';
      await aliases.fill(invalidAliases);
      assert.equal(await aliases.inputValue(), invalidAliases);
      assert.equal(await aliases.getAttribute('aria-invalid'), 'true');
      await panel.getByRole('alert').waitFor({ state: 'visible' });
      assert.equal(await duration.inputValue(), '24');
      await aliases.fill('спам, /alert');
      assert.equal(await aliases.getAttribute('aria-invalid'), null);
      assert.equal(await panel.getByRole('alert').count(), 0);
      assert.equal(
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(),
        true,
      );
      assert.deepEqual(await page.evaluate(() => window.__REPORTS_KEYBOARD_WRITES__), []);
      assert.deepEqual(errors, []);
    }
    await panel.getByRole('spinbutton', { name: 'Длительность ограничения, ч' }).blur();
    await scroller.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({ path: join(screenshots, `${name}-settings-top.png`) });
    if (width <= 768) {
      await panel.locator('.reports-group--measures').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `${name}-settings-measures.png`) });
      await panel.locator('.reports-group--commands').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `${name}-settings-commands.png`) });
      await page.setViewportSize({ width, height: Math.max(360, height - 260) });
      await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).focus();
      await panel
        .getByRole('textbox', { name: 'Дополнительные команды, до 5' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `${name}-keyboard.png`) });
      const inputBox = await panel
        .getByRole('textbox', { name: 'Дополнительные команды, до 5' })
        .boundingBox();
      assert.ok(
        inputBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= Math.max(360, height - 260),
      );
      await page.setViewportSize({ width, height });
      await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).blur();
      await page.waitForFunction(
        (expected) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--app-viewport-height')
            .trim() === `${expected}px`,
        height,
      );
      await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
      await panel.locator('.reports-journal__item').first().waitFor();
      await assertStableMobilePanel();
      await panel.getByRole('tab', { name: 'Настройки', exact: true }).click();
    }
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.settings-drilldown__footer-actions [aria-busy="true"]'),
    );
    if (name === 'iphone-se-light') {
      assert.equal(
        await page.evaluate(() => {
          const hasAuthoredZero = (value) =>
            value &&
            typeof value === 'object' &&
            Object.entries(value).some(
              ([key, child]) =>
                ((key === 'reportsThreshold' || key === 'reportsMuteDurationHours') &&
                  child === 0) ||
                hasAuthoredZero(child),
            );
          return window.__REPORTS_KEYBOARD_WRITES__.some(hasAuthoredZero);
        }),
        false,
        'Empty keyboard buffers must never author zero into the settings request',
      );
    }
    if (await panel.isVisible())
      await panel.getByRole('button', { name: 'Закрыть панель' }).click();
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
    if (width <= 768)
      assert.equal(
        await panel
          .getByRole('radio', { name: '6 голосов', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
    else
      assert.equal(await panel.getByRole('spinbutton', { name: 'Порог жалоб' }).inputValue(), '6');
    assert.equal(
      await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).inputValue(),
      'спам, /alert',
    );
    assert.equal(
      await panel.getByRole('spinbutton', { name: 'Длительность ограничения, ч' }).inputValue(),
      '24',
    );
    await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
    await panel.locator('.reports-journal__item').first().waitFor();
    if (width <= 768) await assertStableMobilePanel();
    await panel.evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
    await scroller.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({ path: join(screenshots, `${name}-journal-top.png`) });
    await panel.getByText('Сбор голосов', { exact: true }).click();
    await panel
      .getByRole('link', { name: 'Открыть профиль: Мария Волкова', exact: true })
      .waitFor();
    await panel
      .getByRole('link', { name: 'Открыть профиль: Александр Соколов', exact: true })
      .waitFor();
    await panel.getByRole('button', { name: 'Отклонить жалобы', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Отклонить жалобы?' });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await panel.getByText('Сбор голосов', { exact: true }).count(), 1);
    await panel.getByRole('button', { name: 'Отклонить жалобы', exact: true }).click();
    await confirm.getByRole('button', { name: 'Отклонить', exact: true }).click();
    await panel.getByText('Отклонено', { exact: true }).waitFor();
    await panel.getByText('Частично', { exact: true }).click();
    await panel.getByText('Не все сообщения удалось удалить.', { exact: true }).waitFor();
    await panel.getByRole('heading', { name: 'Участники', exact: true }).waitFor();
    for (const name of ['Андрей Николаев', 'Мария Волкова', 'Дмитрий Орлов', 'Елена Миронова']) {
      const link = panel.getByRole('link', { name: `Открыть профиль: ${name}`, exact: true });
      await link.waitFor();
      assert.match(await link.getAttribute('href'), /^https:\/\/max\.ru\//u);
    }
    assert.doesNotMatch(
      await panel.locator('.reports-journal__detail').innerText(),
      /10020030[0-9]/u,
    );
    await panel.getByText('Уже отсутствуют', { exact: true }).waitFor();
    await page.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.screenshot({ path: join(screenshots, `${name}-journal.png`) });
    await panel.getByRole('link', { name: 'Открыть профиль: Мария Волкова', exact: true }).click();
    await page.waitForFunction(() =>
      window.__MAXIM_VISUAL_BRIDGE_EVENTS__?.some((event) => event.type === 'openMaxLink'),
    );
    assert.equal(await panel.getByText('Не удалось открыть профиль.', { exact: true }).count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(
      await panel
        .locator('button, label, h3')
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2,
            )
            .map((node) => node.textContent),
        ),
      [],
    );
    assert.deepEqual(errors, []);
    await page.goto(
      new URL('chat/preview-chat/settings?preview=1&reportsAvailability=paused', base).href,
    );
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
    await panel.getByText('Приём жалоб приостановлен оператором.', { exact: true }).waitFor();
    assert.equal(
      await panel.getByRole('switch', { name: 'Жалобы участников', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(screenshots, `${name}-paused.png`) });
    await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
    await panel.getByText('Сбор голосов', { exact: true }).waitFor();
    await page.goto(
      new URL(
        'chat/preview-chat/settings?preview=1&reportsAvailability=paused&reportsOptIn=1',
        base,
      ).href,
    );
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
    const pausedSwitch = panel.getByRole('switch', { name: 'Жалобы участников', exact: true });
    assert.equal(await pausedSwitch.isChecked(), true);
    assert.equal(await pausedSwitch.isDisabled(), false);
    await pausedSwitch.uncheck();
    assert.equal(await pausedSwitch.isDisabled(), false);
    await pausedSwitch.check();
    assert.equal(await pausedSwitch.isChecked(), true);
    await pausedSwitch.uncheck();
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
    await pausedSwitch.waitFor();
    assert.equal(await pausedSwitch.isDisabled(), true);
    if (name === 'iphone-se-light') {
      await page.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
      for (const [title, suffix, label] of [
        ['Ночной режим', 'night', 'Включить закрытие чата на ночь'],
        ['Антидубль', 'duplicates', 'Включить антидубль'],
        ['Сообщения и боты', 'extra', 'Включить удаление собственных сообщений бота'],
      ]) {
        await clickSettingsOverviewEntry(page, title);
        const lazyPanel = page.locator(`.settings-drilldown__panel--${suffix}`);
        const toggle = lazyPanel.getByRole('checkbox', { name: label, exact: true });
        await toggle.waitFor();
        const initial = await toggle.isChecked();
        await toggle.setChecked(!initial);
        await lazyPanel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await clickSettingsOverviewEntry(page, title);
        await toggle.waitFor();
        assert.equal(await toggle.isChecked(), initial);
        await lazyPanel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${name}: report controls, save, journal and layout`);
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
