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
const output = await mkdtemp('/tmp/maxim-publication-scheduling-');
const browser = await chromium.launch();
const start = new Date('2030-01-01T10:00:00Z');

async function assertReachable(locator) {
  assert.equal(
    await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return (
        r.top >= 0 &&
        r.bottom <= visualViewport.height + visualViewport.offsetTop + 1 &&
        r.left >= 0 &&
        r.right <= innerWidth + 1 &&
        element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
      );
    }),
    true,
  );
}

async function chooseTime(page, value) {
  await page.locator('.publication-once-fields .time-field__button').click();
  const dialog = page.locator('.time-field-sheet__panel');
  const [hour, minute] = value.split(':');
  await dialog.getByRole('textbox', { name: 'Часы', exact: true }).fill(hour);
  await dialog.getByRole('textbox', { name: 'Минуты', exact: true }).fill(minute);
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
}

try {
  for (const [name, device] of [
    ['iphone-se', devices['iPhone SE']],
    ['android', devices['Pixel 7']],
    ['desktop', { viewport: { width: 1280, height: 900 } }],
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
      try {
        // FLAG: Use only the local preview transport; never create real publications or contact MAX.
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
        await applyNativeVisualMode(page, {
          safeTop: name === 'iphone-se' ? 20 : 24,
          safeBottom: 0,
        });
        await editor.fill('Регрессия отложенной публикации');
        await page.locator('.publication-target-picker__summary').click();
        await page
          .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
          .click();
        await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
        const modes = page.getByRole('group', { name: 'Время публикации', exact: true });
        await modes.getByRole('button', { name: 'Отложить', exact: true }).click();
        const primary = page.getByRole('button', { name: 'Проверить и отложить', exact: true });
        const feedback = page.locator('.publication-submit-feedback');
        const date = page.locator('.publication-once-fields input[type="date"]');

        await chooseTime(page, '14:37');
        await primary.click();
        await feedback.getByText('Выберите дату публикации.', { exact: true }).waitFor();
        await assertReachable(feedback);
        await assertReachable(primary);
        await page.waitForFunction(() =>
          document.activeElement?.matches('.publication-once-fields input[aria-invalid="true"]'),
        );
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-missing-date.png` });
        // Changing modes must preserve partially entered fields as well as complete times.
        await modes.getByRole('button', { name: 'Сейчас', exact: true }).click();
        await modes.getByRole('button', { name: 'Отложить', exact: true }).click();
        await page.getByRole('button', { name: 'Время: 14:37', exact: true }).waitFor();
        await date.fill('2030-01-01');
        await page.locator('.publication-once-fields .time-field__button').click();
        await page
          .locator('.time-field-sheet__panel')
          .getByRole('button', { name: 'Очистить', exact: true })
          .click();
        await primary.click();
        await feedback.getByText('Выберите время публикации.', { exact: true }).waitFor();
        await assertReachable(feedback);
        await page.waitForFunction(() =>
          document.activeElement?.matches('.publication-once-fields button[aria-invalid="true"]'),
        );

        await chooseTime(page, '13:01');
        await primary.click();
        await feedback
          .getByText('Выберите время минимум на 2 минуты позже текущего.', { exact: true })
          .waitFor();
        await assertReachable(feedback);
        if (name !== 'desktop') {
          await editor.focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(() =>
            document.querySelector('.publications-page').classList.contains('is-keyboard-open'),
          );
          await primary.click();
          await assertReachable(feedback);
          await assertReachable(primary);
          await page.screenshot({ path: `${output}/${name}-${colorScheme}-keyboard-error.png` });
          await page.evaluate(() => {
            delete visualViewport.height;
            visualViewport.dispatchEvent(new Event('resize'));
          });
        }

        await chooseTime(page, '13:03');
        await primary.click();
        const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
        await review.waitFor();
        assert.match(await review.innerText(), /13:03/u);
        await page.clock.setFixedTime(new Date('2030-01-01T10:02:00Z'));
        await review.getByRole('button', { name: 'Запланировать', exact: true }).click();
        await feedback
          .getByText('Выберите время минимум на 2 минуты позже текущего.', { exact: true })
          .waitFor();
        assert.equal(await review.count(), 0);
        assert.equal(await editor.innerText(), 'Регрессия отложенной публикации');
        await assertReachable(feedback);
        await page.clock.setFixedTime(start);

        await date.fill('2030-01-02');
        await chooseTime(page, '14:37');
        await modes.getByRole('button', { name: 'Расписание', exact: true }).click();
        await page.locator('.broadcast-planner__compact-summary').click();
        await page.locator('[data-broadcast-schedule-day="2030-01-02"]').click();
        await page
          .locator('.broadcast-planner__dock')
          .getByRole('button', { name: 'Время', exact: true })
          .click();
        assert.equal(
          await page.getByRole('button', { name: 'Удалить время 14:37', exact: true }).count(),
          0,
        );
        await page.locator('.broadcast-planner__custom-time .time-field__button').click();
        await page.getByRole('textbox', { name: 'Часы', exact: true }).fill('16');
        await page.getByRole('textbox', { name: 'Минуты', exact: true }).fill('11');
        await page.getByRole('button', { name: 'Применить', exact: true }).click();
        await page.getByRole('button', { name: /^Готово/u }).click();
        await modes.getByRole('button', { name: 'Отложить', exact: true }).click();
        assert.equal(await date.inputValue(), '2030-01-02');
        await page.getByRole('button', { name: 'Время: 14:37', exact: true }).waitFor();
        await primary.click();
        await review.waitFor();
        assert.match(
          await review.locator('.publication-review-timing time').textContent(),
          /2 января 2030 г\. в 14:37/u,
        );
        await assertReachable(review.getByRole('button', { name: 'Запланировать', exact: true }));
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-review.png` });
        await review.getByRole('button', { name: 'Запланировать', exact: true }).click();
        await page.locator('.publications-page:not(.is-editor)').waitFor();
        await page.getByRole('button', { name: 'Расписания', exact: true }).click();
        const saved = page
          .locator('.publication-feed-card')
          .filter({ hasText: 'Регрессия отложенной публикации' });
        await saved.waitFor();
        assert.match(await saved.innerText(), /2 янв., 14:37/u);
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}-${colorScheme}: missing fields, minimum time, keyboard feedback, expired review, mode switching, saved schedule`,
        );
      } catch (error) {
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-failure.png` });
        throw error;
      } finally {
        await context.close();
      }
    }
} finally {
  console.log(`Screenshots: ${output}`);
  await browser.close();
  await stopChildProcess(server);
}
