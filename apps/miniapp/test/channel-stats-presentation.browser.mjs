import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Local server required');
}
const browser = await chromium.launch();
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-channel-stats-reflow-'));
try {
  for (const width of [280, 320, 393, 430, 1280]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 740 }, colorScheme: theme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/statistics-presentation-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html lang="ru" data-max-theme="${theme}"><body data-miniapp-profile="moderation" class="channel-stats-page-open"><div id="root"></div><script type="module">
import RefreshRuntime from '/app/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
await import('/app/test/fixtures/channel-stats-presentation-harness.tsx');
</script></body></html>`,
        }),
      );
      await page.goto(new URL('statistics-presentation-test', base).href);
      await page.locator('.channel-summary-table').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => {
        const svg = document.querySelector('.channel-stats-graph__svg');
        return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 0.1;
      });

      const ordinaryCards = await page
        .locator('.channel-summary-card--compact')
        .evaluateAll((cards) =>
          cards.slice(0, 2).map((card) => card.getBoundingClientRect().height),
        );
      assert.ok(
        ordinaryCards.every((height) => height < 144),
        JSON.stringify(ordinaryCards),
      );
      assert.match(
        await page.locator('.channel-audience-board__series').innerText(),
        /Выбранный период/,
      );
      assert.match(
        await page.locator('.channel-audience-board__series').innerText(),
        /Предыдущий период/,
      );
      const slider = page.getByRole('slider', { name: 'Динамика аудитории' });
      await slider.focus();
      await page.keyboard.press('Home');
      assert.equal(await slider.getAttribute('aria-valuenow'), '1');
      await page.keyboard.press('End');
      assert.equal(
        await slider.getAttribute('aria-valuenow'),
        await slider.getAttribute('aria-valuemax'),
      );
      await slider.evaluate((element) => element.blur());

      for (const stress of [false, true]) {
        if (stress) {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '20px';
            window.renderStatistics('stress');
          });
          const dataStatus = page.locator('.channel-insights__data-status');
          await dataStatus.waitFor();
          assert.match(await dataStatus.innerText(), /Обновляем данные канала/);
          assert.match(await dataStatus.innerText(), /Данные доступны с/);
          assert.equal(
            await page.locator('.channel-insights__calculated-at time').getAttribute('datetime'),
            '2026-10-21T09:45:00.000Z',
          );
          assert.match(
            await page.locator('.channel-insights__calculated-at').innerText(),
            /12:45.*МСК/,
          );
        }
        const issues = await page.evaluate(() => {
          const problems = [];
          for (const cell of document.querySelectorAll(
            '.channel-summary-table th, .channel-summary-table td',
          )) {
            if (cell.scrollWidth > cell.clientWidth + 1)
              problems.push(`Table cell clipped: ${cell.textContent}`);
            if (cell.tagName === 'TH') {
              const words = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
              while (words.nextNode()) {
                for (const match of words.currentNode.textContent.matchAll(/\S+/gu)) {
                  const range = document.createRange();
                  range.setStart(words.currentNode, match.index);
                  range.setEnd(words.currentNode, match.index + match[0].length);
                  if (range.getClientRects().length > 1)
                    problems.push(`Table heading word split: ${match[0]}`);
                }
              }
            }
          }
          for (const value of document.querySelectorAll(
            '.channel-summary-card--compact > strong, .channel-audience-metric :is(b, small, em), .channel-audience-board__legend :is(b, em)',
          )) {
            if (value.scrollWidth > value.clientWidth + 1)
              problems.push(`KPI clipped: ${value.textContent}`);
            const range = document.createRange();
            range.selectNodeContents(value);
            const card = value
              .closest(
                '.channel-summary-card--compact, .channel-audience-metric, .channel-audience-board__legend > span',
              )
              .getBoundingClientRect();
            for (const rect of range.getClientRects()) {
              if (rect.left < card.left || rect.right > card.right || rect.bottom > card.bottom)
                problems.push(`KPI outside card: ${value.textContent}`);
            }
          }
          const svg = document.querySelector('.channel-stats-graph__svg');
          const bounds = svg.getBoundingClientRect();
          const dates = [];
          for (const label of svg.querySelectorAll(
            '.channel-stats-graph__axis-text, .channel-stats-graph__x-label',
          )) {
            const rect = label.getBoundingClientRect();
            const size =
              Number.parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM().a;
            if (size < 10) problems.push(`Small chart label: ${size}`);
            if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
              problems.push(`Chart label outside plot: ${label.textContent}`);
            if (label.classList.contains('channel-stats-graph__x-label')) dates.push(rect);
          }
          for (let index = 1; index < dates.length; index++) {
            if (dates[index].left < dates[index - 1].right + 4)
              problems.push('Overlapping chart dates');
          }
          if (document.documentElement.scrollWidth > innerWidth + 1)
            problems.push('Horizontal page overflow');
          return problems;
        });
        assert.deepEqual(
          issues,
          [],
          `${width}px ${theme} stress=${stress}: ${JSON.stringify(issues)}`,
        );
      }
      if (width <= 430) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '32px';
          window.renderStatistics();
        });
        const clipping = await page.evaluate(() => {
          const issues = [];
          const selectors = [
            '.channel-summary-card--compact > small',
            '.channel-audience-board__heading strong',
            '.channel-insights__overview-toolbar .segmented-control__item',
            '.channel-audience-selection strong',
          ];
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (!elements.length) issues.push(`Missing reflow target: ${selector}`);
            for (const element of elements) {
              const bounds = element.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(element);
              if (
                element.scrollWidth > element.clientWidth + 1 ||
                element.scrollHeight > element.clientHeight + 1
              )
                issues.push(`Clipped text: ${element.textContent}`);
              const container = element
                .closest(
                  '.channel-summary-card--compact, .channel-audience-board__heading, .channel-insights__range, .channel-audience-selection',
                )
                .getBoundingClientRect();
              for (const rect of range.getClientRects()) {
                if (
                  rect.left < bounds.left - 1 ||
                  rect.right > bounds.right + 1 ||
                  rect.top < bounds.top - 1 ||
                  rect.bottom > bounds.bottom + 1
                )
                  issues.push(`Text outside element: ${element.textContent}`);
                if (
                  rect.left < container.left - 1 ||
                  rect.right > container.right + 1 ||
                  rect.top < container.top - 1 ||
                  rect.bottom > container.bottom + 1
                )
                  issues.push(`Text outside container: ${element.textContent}`);
              }
            }
          }
          const scroll = document.querySelector('.channel-summary-table-scroll');
          if (!scroll) issues.push('Missing day-table scroll region');
          else {
            const bounds = scroll.getBoundingClientRect();
            if (
              bounds.left < -1 ||
              bounds.right > innerWidth + 1 ||
              scroll.scrollHeight > scroll.clientHeight + 1
            )
              issues.push('Day-table scroll region clips or leaves viewport');
            for (const element of scroll.querySelectorAll('th, td')) {
              if (
                element.scrollWidth > element.clientWidth + 1 ||
                element.scrollHeight > element.clientHeight + 1
              )
                issues.push(`Clipped day-table cell: ${element.textContent}`);
              const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              while (texts.nextNode()) {
                if (!texts.currentNode.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(texts.currentNode);
                const lines = new Set(
                  [...range.getClientRects()]
                    .filter((rect) => rect.width > 0)
                    .map((rect) => Math.round(rect.top)),
                );
                if (lines.size > 1)
                  issues.push(`Day-table text split: ${texts.currentNode.textContent}`);
              }
            }
          }
          return issues;
        });
        assert.deepEqual(clipping, [], `${width}px ${theme} 200% text`);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
        const scroll = page.getByRole('region', { name: 'Таблица по дням', exact: true });
        await scroll.focus();
        await scroll.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        assert.equal(
          await scroll.evaluate((element) => {
            const end = element
              .querySelector('tbody tr:last-child td:last-child')
              .getBoundingClientRect();
            const bounds = element.getBoundingClientRect();
            return end.right <= bounds.right + 1;
          }),
          true,
          'last day-table column is reachable inside contained scroller',
        );
        await scroll.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await page.screenshot({
          path: join(screenshots, `${width}-${theme}-200-percent.png`),
          fullPage: true,
        });
      }
      for (const scenario of ['empty', 'unavailable']) {
        await page.evaluate((scenario) => window.renderStatistics(scenario), scenario);
        await page.locator('.channel-stats-graph__empty').waitFor();
        assert.match(
          await page.locator('.channel-stats-graph__empty').innerText(),
          scenario === 'empty' ? /Пока нет данных/ : /недоступны/,
        );
        assert.equal(await page.getByRole('slider').count(), 0);
        assert.equal(await page.locator('.channel-insights__calculated-at').count(), 0);
        assert.deepEqual(
          await page.locator('.channel-summary-card--compact > strong').allTextContents(),
          ['—', '—', '—', '—'],
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS statistics ${width}px ${theme}: full counts, text zoom, chart labels, series, timestamps, keyboard`,
      );
      await page.close();
    }
  }
  console.log(`Statistics reflow screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
