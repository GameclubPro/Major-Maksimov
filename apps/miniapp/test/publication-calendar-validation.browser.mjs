import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3019/app/');
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp('/tmp/maxim-publication-calendar-');
const browser = await chromium.launch();
const failures = [];
const start = new Date('2030-01-01T10:00:00Z');

async function chooseTime(page, value) {
  await page.locator('.broadcast-planner__custom-time .time-field__button').click();
  const dialog = page.locator('.time-field-sheet__panel');
  const [hour, minute] = value.split(':');
  await dialog.getByRole('textbox', { name: 'Часы', exact: true }).fill(hour);
  await dialog.getByRole('textbox', { name: 'Минуты', exact: true }).fill(minute);
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
}

function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected, name);
  } catch (error) {
    failures.push(error.message);
    console.error(`FAIL ${name}: ${JSON.stringify(actual)}`);
  }
}

try {
  for (const [name, device] of [
    ['desktop-window', { viewport: { width: 384, height: 650 } }],
    ['iphone-se', devices['iPhone SE']],
    ['android', devices['Pixel 7']],
  ])
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...device,
        colorScheme,
        timezoneId: 'Europe/Moscow',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const scenario = `${name}-${colorScheme}`;
      try {
        // FLAG: Exercise only local preview state; never publish to MAX or call production APIs.
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        await installNativeVisualModeInitScript(context);
        await page.clock.setFixedTime(start);
        await page.goto(`${base}publications?preview=1&profile=publisher&compose=1`);
        const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
        await editor.waitFor();
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 16 });
        await editor.fill(
          'Проверка расписания\nПрайс и ассортимент в нашей группе\nhttps://max.ru/',
        );
        await page.locator('.publication-target-picker__summary').click();
        await page
          .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
          .click();
        await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
        await page
          .getByRole('group', { name: 'Время публикации', exact: true })
          .getByRole('button', { name: 'Расписание', exact: true })
          .click();
        const primary = page.getByRole('button', { name: 'Проверить расписание', exact: true });
        const feedback = page.locator('.publication-submit-feedback');
        const summary = page.locator('.broadcast-planner__compact-summary');
        await summary.waitFor();
        await primary.click();
        await feedback.waitFor();
        await page.screenshot({ path: `${output}/${scenario}-missing-time.png` });
        check(
          `${scenario}: validation focuses the calendar control`,
          await summary.evaluate((element) => document.activeElement === element),
          true,
        );
        check(
          `${scenario}: calendar correction is reachable above the submit bar`,
          await summary.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.top >= 0 &&
              rect.bottom <=
                document.querySelector('.publications-publish-bar').getBoundingClientRect().top &&
              element.contains(
                document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
              )
            );
          }),
          true,
        );
        const kinds = page.getByRole('group', { name: 'Тип расписания', exact: true });
        await kinds.getByRole('button', { name: 'Повтор', exact: true }).click();
        check(
          `${scenario}: switching schedule kind clears obsolete feedback`,
          await feedback.count(),
          0,
        );
        await kinds.getByRole('button', { name: 'Даты', exact: true }).click();
        await summary.click();
        await page.locator('[data-broadcast-schedule-day="2030-01-01"]').click();
        await page
          .locator('.broadcast-planner__dock')
          .getByRole('button', { name: 'Время', exact: true })
          .click();
        await chooseTime(page, '13:01');
        const customError = page.locator('.broadcast-planner__custom-time .time-field__error');
        check(
          `${scenario}: rejected custom time explains how to correct it`,
          await customError.count(),
          1,
        );
        check(
          `${scenario}: rejected time stays editable`,
          await page.locator('.broadcast-planner__custom-time .time-field__value').textContent(),
          '13:01',
        );
        check(
          `${scenario}: a too-close time is never selected`,
          await page.getByRole('button', { name: 'Удалить время 13:01', exact: true }).count(),
          0,
        );
        await page.screenshot({ path: `${output}/${scenario}-invalid-time.png` });
        await chooseTime(page, '13:07');
        const selected = page.getByRole('button', { name: 'Удалить время 13:07', exact: true });
        await selected.waitFor();
        check(`${scenario}: correcting custom time clears its error`, await customError.count(), 0);
        await chooseTime(page, '13:07');
        check(`${scenario}: adding the same time again preserves it`, await selected.count(), 1);
        await chooseTime(page, '13:17');
        if (await selected.count()) await selected.click();
        check(`${scenario}: explicit remove deletes only that time`, await selected.count(), 0);
        await page.getByRole('button', { name: 'Удалить время 13:17', exact: true }).waitFor();
        await page.getByRole('button', { name: /^Готово/u }).click();
        check(
          `${scenario}: valid calendar selection clears submit feedback`,
          await feedback.count(),
          0,
        );
        await primary.click();
        const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
        await review.waitFor();
        assert.match(
          await review.locator('.publication-preview__facts').textContent(),
          /1 янв., 13:17/u,
        );
        await page.screenshot({ path: `${output}/${scenario}-review.png` });
        await page.clock.setFixedTime(new Date('2030-01-01T10:16:00Z'));
        await review.getByRole('button', { name: 'Сохранить расписание', exact: true }).click();
        await feedback.waitFor();
        check(
          `${scenario}: final confirmation still rejects an expired slot`,
          await review.count(),
          0,
        );
        await page.clock.setFixedTime(start);
        await primary.click();
        await review.waitFor();
        await review.getByRole('button', { name: 'Сохранить расписание', exact: true }).click();
        await page.locator('.publications-page:not(.is-editor)').waitFor();
        await page.getByRole('button', { name: 'Расписания', exact: true }).click();
        const saved = page
          .locator('.publication-feed-card')
          .filter({ hasText: 'Проверка расписания' });
        await saved.waitFor();
        assert.match(await saved.innerText(), /1 янв., 13:17/u);
        check(`${scenario}: browser errors`, errors, []);
        console.log(
          `CHECKED ${scenario}: focus, correction, duplicate time, explicit removal, review, expiration, saved schedule`,
        );
      } catch (error) {
        await page.screenshot({ path: `${output}/${scenario}-failure.png` });
        throw error;
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(failures, [], 'Calendar validation regressions');
} finally {
  console.log(`Screenshots: ${output}`);
  await browser.close();
  await stopChildProcess(server);
}
