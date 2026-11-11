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

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const output = await mkdtemp('/tmp/maxim-publisher-catalog-');
const server = await ensureMiniappDevServer(base);
let browser;
let activePage;

async function assertCatalogBounds(page) {
  const metrics = await page.evaluate(() => {
    const list = document.querySelector('.publisher-entities-page__list');
    const nav = document.querySelector('.bottom-nav');
    const shell = document.querySelector('.app-shell');
    const contentRect = document.querySelector('.shell-content').getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      listBottom: Math.min(listRect.bottom, contentRect.bottom),
      navTop: navRect.top,
      navBottom: navRect.bottom,
      viewport: innerHeight,
      overflow: document.documentElement.scrollWidth - innerWidth,
      shellBottom: shell.getBoundingClientRect().bottom,
      listHeight: list.clientHeight,
    };
  });
  assert.ok(metrics.listBottom <= metrics.navTop - 7, JSON.stringify(metrics));
  assert.ok(metrics.navBottom <= metrics.viewport, JSON.stringify(metrics));
  assert.ok(metrics.shellBottom <= metrics.viewport + 1, JSON.stringify(metrics));
  assert.ok(metrics.listHeight >= 120 && metrics.overflow <= 1, JSON.stringify(metrics));
}

async function assertLastRowReachable(page) {
  await page.locator('.publisher-entities-page__list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.publisher-entity-row');
    const last = rows[rows.length - 1];
    return last?.getAttribute('aria-posinset') === last?.getAttribute('aria-setsize');
  });
  await page.locator('.publisher-entity-row__main').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const list = document.querySelector('.publisher-entities-page__list');
    const row = list?.querySelector('.publisher-entity-row:last-of-type');
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return (
      rect.top >= listRect.top &&
      rect.bottom <= listRect.bottom &&
      row.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 12))
    );
  });
}

try {
  browser = await chromium.launch();
  for (const profile of [
    { name: 'se', device: devices['iPhone SE'], platform: 'ios', safeTop: 20, safeBottom: 0 },
    { name: 'iphone', device: devices['iPhone 15'], platform: 'ios', safeTop: 59, safeBottom: 34 },
    {
      name: 'android',
      device: devices['Pixel 7'],
      platform: 'android',
      safeTop: 24,
      safeBottom: 24,
    },
    {
      name: 'compact',
      device: { viewport: { width: 320, height: 480 }, isMobile: true, hasTouch: true },
      platform: 'ios',
      safeTop: 20,
      safeBottom: 34,
    },
    {
      name: 'desktop',
      device: { viewport: { width: 1280, height: 900 } },
      platform: 'web',
      safeTop: 0,
      safeBottom: 0,
    },
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
        colorScheme,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ body: '' }),
      );
      await installMaxBridgeShimInitScript(context, profile, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}?preview=1&profile=publisher`);
      await page.locator('.publisher-entity-row').first().waitFor();
      await applyNativeVisualMode(page, profile);
      for (const view of ['Каналы', 'Чаты']) {
        await page.getByRole('navigation').getByRole('link', { name: view, exact: true }).click();
        await page.getByRole('list', { name: `${view} Публика`, exact: true }).waitFor();
        await assertCatalogBounds(page);
        await assertLastRowReachable(page);
      }
      await page
        .locator('.publisher-entity-row__title strong')
        .first()
        .evaluate((title) => {
          title.textContent = 'Очень длинное название сообщества без потери доступа к настройкам';
        });
      const title = page.locator('.publisher-entity-row__title strong').first();
      assert.ok(await title.evaluate((element) => element.clientHeight > 30));
      await assertCatalogBounds(page);
      await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}.png` });

      const search = page.getByRole('searchbox');
      await search.fill('Нет такого сообщества');
      await page.getByText('Ничего не найдено', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
      await page.locator('.publisher-entity-row').first().waitFor();
      await assertCatalogBounds(page);

      if (profile.name !== 'desktop') {
        await search.focus();
        await page.evaluate(() => {
          Object.defineProperty(visualViewport, 'height', { configurable: true, value: 260 });
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.locator('.bottom-nav').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'Внимание', exact: true }).click();
        await page.locator('.publisher-entity-row').first().waitFor();
        await page.locator('.publisher-entity-row__main').last().scrollIntoViewIfNeeded();
        const visibleRow = await page
          .locator('.publisher-entity-row__main')
          .last()
          .evaluate((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom <= visualViewport.height + visualViewport.offsetTop + 1;
          });
        assert.ok(visibleRow, 'The list remains reachable above the keyboard');
        await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-keyboard.png` });
        await page.evaluate(() => {
          delete visualViewport.height;
          document.activeElement?.blur();
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.locator('.bottom-nav').waitFor({ state: 'visible' });
        await assertCatalogBounds(page);
      }

      await page.getByRole('navigation').getByRole('link', { name: 'Посты', exact: true }).click();
      await page.locator('.publications-page').waitFor();
      await page.getByRole('navigation').getByRole('link', { name: 'Чаты', exact: true }).click();
      await page.locator('.publisher-entity-row').first().waitFor();
      await assertCatalogBounds(page);

      if (['se', 'android', 'compact'].includes(profile.name)) {
        await page.goto(`${base}?preview=1&profile=publisher&publisherState=large`);
        await page.locator('.publisher-entity-row').first().waitFor();
        await applyNativeVisualMode(page, profile);
        await page.locator('.publisher-entities-page__list').hover();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await page.getByRole('status').filter({ hasText: '200 получателей' }).count()) break;
          await page.mouse.wheel(0, 1200);
          await page.waitForTimeout(60);
        }
        await page.getByRole('status').filter({ hasText: '200 получателей' }).waitFor();
        await page.locator('.publisher-entities-page__list.is-virtual').waitFor();
        await assertLastRowReachable(page);
        await assertCatalogBounds(page);
        await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-virtual.png` });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '32px';
          document.querySelector('.publisher-entities-page__list').scrollTop = 0;
        });
        await page.waitForFunction(
          () =>
            document.querySelector('.publisher-entity-row')?.getBoundingClientRect().height >= 240,
        );
        const clippedText = await page.locator('.publisher-entity-row').evaluateAll((rows) =>
          rows.flatMap((row) => {
            const bounds = row.getBoundingClientRect();
            return [
              ...row.querySelectorAll('.publisher-entity-row__copy, .publisher-entity-row__status'),
            ]
              .filter((copy) => {
                const box = copy.getBoundingClientRect();
                return box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1;
              })
              .map((copy) => copy.textContent);
          }),
        );
        assert.deepEqual(clippedText, [], '200% text fits virtual rows without clipping');
        for (const label of ['Все', 'Готовы', 'Внимание']) {
          const button = page.getByRole('button', { name: label, exact: true });
          await button.scrollIntoViewIfNeeded();
          assert.ok(
            await button.evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              const text = range.getBoundingClientRect();
              const box = node.getBoundingClientRect();
              return text.left >= box.left - 1 && text.right <= box.right + 1;
            }),
            `${label} stays readable at 200%`,
          );
          await button.tap();
          assert.equal(await button.getAttribute('aria-pressed'), 'true');
        }
        await page.getByRole('button', { name: 'Все', exact: true }).tap();
        await page.locator('.publisher-entities-page__list.is-virtual').waitFor();
        await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-200pct.png` });
        await page.locator('.publisher-entities-page__list').evaluate((list) => {
          list.scrollTop = list.scrollHeight;
        });
        await page.waitForFunction(() => {
          const row = document.querySelector('.publisher-entity-row:last-of-type');
          return row?.getAttribute('aria-posinset') === '200';
        });
        const lastStatus = page.locator('.publisher-entity-row__status').last();
        await lastStatus.scrollIntoViewIfNeeded();
        assert.ok(
          await lastStatus.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            const list = node.closest('.publisher-entities-page__list').getBoundingClientRect();
            return (
              bounds.top >= list.top - 1 &&
              bounds.bottom <= list.bottom + 1 &&
              node.contains(
                document.elementFromPoint(
                  bounds.left + bounds.width / 2,
                  bounds.top + bounds.height / 2,
                ),
              )
            );
          }),
          'Last status remains reachable even when a large-text row exceeds the viewport',
        );
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '16px';
        });
        await page.waitForFunction(
          () =>
            document.querySelector('.publisher-entity-row')?.getBoundingClientRect().height === 120,
        );
        await page.setViewportSize({
          width: profile.device.viewport.height,
          height: profile.device.viewport.width,
        });
        await applyNativeVisualMode(page, { ...profile, safeTop: 0, safeBottom: 0 });
        await assertCatalogBounds(page);
        await assertLastRowReachable(page);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(`Publisher catalog layout passed. Screenshots: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed())
    await activePage.screenshot({ path: `${output}/failure.png` });
  console.error(`Failure screenshot: ${output}/failure.png`);
  throw error;
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
