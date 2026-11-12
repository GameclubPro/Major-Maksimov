import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
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
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output = process.env.PUBLISHER_AUDIT_OUTPUT ?? (await mkdtemp('/tmp/maxim-publisher-audit-'));
await mkdir(output, { recursive: true });
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const profiles = [
  [chromium, 320, 568, 'light'],
  [webkit, 320, 568, 'light'],
  [webkit, 393, 749, 'dark'],
  [chromium, 667, 320, 'dark'],
];
const observations = [];
const failures = [];

async function check(name, callback) {
  try {
    const result = await callback();
    observations.push({ name, status: 'passed', ...result });
  } catch (error) {
    observations.push({ name, status: 'failed', error: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

async function assertTextFits(locator) {
  const metrics = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const button = element.closest('.broadcast-content-composer__tool, button, label');
      const bounds = button.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        text: element.textContent.trim(),
        bounds: bounds.toJSON(),
        textRects: [...range.getClientRects()].map((rect) => rect.toJSON()),
        viewportWidth: innerWidth,
      };
    }),
  );
  assert.ok(metrics.length > 0, 'expected text controls');
  for (const { text, bounds, textRects, viewportWidth } of metrics) {
    assert.ok(bounds.left >= -1 && bounds.right <= viewportWidth + 1, text);
    for (const rect of textRects.filter((rect) => rect.width > 0 && rect.height > 0)) {
      assert.ok(
        rect.left >= bounds.left - 1 &&
          rect.right <= bounds.right + 1 &&
          rect.top >= bounds.top - 1 &&
          rect.bottom <= bounds.bottom + 1,
        JSON.stringify({ text, bounds, rect }),
      );
    }
  }
  return metrics;
}

console.log(`Publisher audit regression artifacts: ${output}`);
try {
  for (const [engine, width, height, theme] of profiles) {
    const profile = `${engine.name()}-${width}x${height}-${theme}`;
    if (
      process.env.PUBLISHER_AUDIT_PROFILE &&
      !process.env.PUBLISHER_AUDIT_PROFILE.split(',').includes(profile)
    ) {
      continue;
    }
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      for (const fontSize of [16, 32]) {
        const id = `${profile}-${fontSize}px`;
        const context = await browser.newContext({
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          locale: 'ru-RU',
          timezoneId: 'Europe/Moscow',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(
            context,
            { platform: engine === webkit ? 'ios' : 'android', safeTop: 0, safeBottom: 0 },
            { colorScheme: theme },
          );
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          await page.clock.setFixedTime(new Date('2026-07-20T12:00:00Z'));
          await page.goto(`${base}publisher/channel/preview-channel?preview=1&profile=publisher`);
          await page.locator('.publisher-entity-modules-page').waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = `${size}px`;
          }, fontSize);

          await check(`${id}: native and browser back`, async () => {
            const inlineBack = page.getByRole('link', {
              name: 'Вернуться к списку',
              includeHidden: true,
            });
            assert.equal(await page.evaluate(() => window.WebApp.BackButton.isVisible), true);
            assert.equal(await inlineBack.isVisible(), false);
            await page.evaluate(() => {
              document.documentElement.dataset.maxClient = 'browser';
            });
            assert.equal(await inlineBack.isVisible(), true);
            await inlineBack.click();
            await page.locator('.publisher-entities-page').waitFor();
            await page.goto(`${base}publisher/channel/preview-channel?preview=1&profile=publisher`);
            await page.locator('.publisher-entity-modules-page').waitFor();
            await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
            await page.evaluate((size) => {
              document.documentElement.style.fontSize = `${size}px`;
              window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__();
            }, fontSize);
            await page.locator('.publisher-entities-page').waitFor();
            return { nativeBack: true, browserBack: true };
          });

          await page.goto(
            `${base}publisher/channel/preview-channel?preview=1&profile=publisher&focus=vk`,
          );
          await page.locator('.vk-parsing-workspace').waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = `${size}px`;
          }, fontSize);
          await page.evaluate(() => document.fonts.ready);
          await check(`${id}: VK filters and targets`, async () => {
            const metrics = await assertTextFits(page.locator('.vk-parsing-filter-chip'));
            const targets = await page
              .locator('.vk-workspace-dialog')
              .locator(
                '.settings-drilldown__close, .vk-info-button, .vk-parsing-icon-button, .vk-parsing-action-button, .vk-parsing-filter-more select',
              )
              .evaluateAll((elements) =>
                elements
                  .map((element) => ({
                    name: element.getAttribute('aria-label') || element.textContent.trim(),
                    ...element.getBoundingClientRect().toJSON(),
                  }))
                  .filter((rect) => rect.width > 0 && rect.height > 0),
              );
            assert.ok(targets.length >= 4);
            for (const target of targets) {
              assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(target));
            }
            await page.screenshot({ path: `${output}/${id}-vk-filters.png` });
            return { metrics, targets };
          });
          await check(`${id}: queue date keeps draft and explicit save`, async () => {
            await page.getByRole('button', { name: 'Очередь', exact: true }).click();
            const queue = page.locator('.vk-queue-item').first();
            // Native date inputs expose different roles across browser engines.
            const input = queue.locator('.date-field input[type=date]');
            await input.waitFor();
            const original = await input.inputValue();
            const name = await input.getAttribute('aria-label');
            assert.match(name, /^Дата публикации: /u);
            await input.fill('');
            assert.equal(await queue.locator('.date-field__value').innerText(), 'дд.мм.гггг');
            await input.fill('2026-07-21');
            assert.equal(await queue.locator('.date-field__value').innerText(), '21.07.2026');
            assert.equal(
              await queue.getByRole('button', { name: 'Сохранить время', exact: true }).isEnabled(),
              true,
            );
            await queue
              .getByRole('button', { name: 'Отменить изменение времени', exact: true })
              .click();
            assert.equal(await input.inputValue(), original);
            assert.equal(
              await queue.getByRole('button', { name: 'Сохранить время', exact: true }).count(),
              0,
            );
            const metrics = await queue.locator('.date-field__value').evaluate((value) => ({
              width: value.clientWidth,
              scrollWidth: value.scrollWidth,
            }));
            assert.ok(metrics.scrollWidth <= metrics.width + 1, JSON.stringify(metrics));
            await queue.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${output}/${id}-queue-date.png` });
            return { original, label: name, metrics };
          });

          await page.goto(`${base}publications?preview=1&profile=publisher&compose=1`);
          await page.locator('.publications-editor').waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = `${size}px`;
          }, fontSize);
          await page.evaluate(() => document.fonts.ready);
          await check(`${id}: editor tools`, async () => {
            await page.locator('.broadcast-content-composer__tool-label').first().waitFor();
            const metrics = await assertTextFits(
              page.locator('.broadcast-content-composer__tool-label'),
            );
            await page
              .locator('.broadcast-content-composer__media-actions')
              .scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${output}/${id}-editor-tools.png` });
            return { metrics };
          });
          await check(`${id}: timing choices`, async () => {
            await page.locator('.publication-timing-tabs').scrollIntoViewIfNeeded();
            const metrics = await assertTextFits(page.locator('.publication-timing-tabs button'));
            await page.getByRole('button', { name: 'Расписание', exact: true }).click();
            await page.getByRole('button', { name: 'Отложить', exact: true }).click();
            await page.getByRole('button', { name: 'Сейчас', exact: true }).click();
            await page.screenshot({ path: `${output}/${id}-timing.png` });
            return { metrics };
          });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
  await writeFile(`${output}/results.json`, JSON.stringify(observations, null, 2));
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log(`Passed ${observations.length} Publisher regression cases.`);
