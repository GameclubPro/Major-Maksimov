import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const output = mkdtempSync(join(tmpdir(), 'maxim-suggestion-review-'));
console.log(`Screenshots: ${output}`);
let browser;
try {
  for (const [name, engine, width, height] of [
    ['android', chromium, 412, 915],
    ['iphone', webkit, 390, 844],
  ]) {
    browser = await engine.launch({
      headless: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^(?:all|https?|no)_proxy$/iu.test(key)),
      ),
    });
    for (const profile of ['moderation', 'publisher'])
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
        });
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const fixture = new URL('test/browser/suggestion-review.html', base);
        fixture.search = new URLSearchParams({ profile, theme, media: '1' }).toString();
        await page.goto(fixture.href);
        const editor = page.getByRole('textbox', { name: 'Текст предложки', exact: true });
        await editor.waitFor();
        assert.equal(await page.locator('.shell-topbar, .bottom-nav').count(), 0);
        await page.getByRole('button', { name: 'Открыть фото: Фото 1' }).waitFor();
        await page.getByRole('button', { name: 'Открыть фото: Фото 1' }).click();
        await page.getByRole('dialog', { name: 'Просмотр фото' }).waitFor();
        await page.getByRole('button', { name: 'Закрыть просмотр' }).click();
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Анна Смирнова ↗' }).count(), 1);
        await editor.evaluate((el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          while (walker.nextNode())
            if (walker.currentNode.textContent.includes('300')) {
              walker.currentNode.textContent = walker.currentNode.textContent.replace('300', '350');
              break;
            }
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '5' }),
          );
        });
        await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await page.getByText('Изменения сохранены', { exact: true }).waitFor();
        const saved = await page.evaluate(
          () => window.reviewCalls.find((x) => x.path.endsWith('/save'))?.body.text,
        );
        assert.equal(saved, '  **Цена** 350 ₽\n\n[Описание](https://example.test/)\n\n');
        await page.screenshot({
          path: `${output}/${name}-${profile}-${theme}-edit.png`,
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
        await page.getByRole('button', { name: 'Текст', exact: true }).click();
        const publish = page.getByRole('button', {
          name: profile === 'moderation' ? 'Опубликовать' : 'В публикацию',
          exact: true,
        });
        await publish.waitFor();
        await page.waitForFunction(
          () => !document.querySelector('.suggestion-review__dock .button--primary').disabled,
        );
        await editor.evaluate((el) => {
          el.focus();
          const text = [...el.querySelectorAll('a')].at(-1)?.firstChild ?? el.firstChild;
          const range = document.createRange();
          range.selectNodeContents(text);
          range.collapse(false);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        });
        await page.setViewportSize({ width, height: 430 });
        await page.waitForFunction(() => {
          const selection = getSelection();
          if (!selection?.rangeCount) return false;
          const range = selection.getRangeAt(0).cloneRange();
          if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset)
            range.setStart(range.startContainer, range.startOffset - 1);
          const caret = range.getBoundingClientRect();
          const dock = document.querySelector('.suggestion-review__dock').getBoundingClientRect();
          return caret.height > 0 && caret.top >= 0 && caret.bottom < dock.top;
        });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const dock = await page.locator('.suggestion-review__dock').boundingBox();
        assert.ok(
          dock && dock.y >= 0 && dock.y + dock.height <= 431,
          'Actions remain above the keyboard',
        );
        await page.screenshot({
          path: `${output}/${name}-${profile}-${theme}-keyboard.png`,
          fullPage: false,
        });
        await page.setViewportSize({ width, height });
        fixture.searchParams.set('mediaError', '1');
        fixture.searchParams.set('long', '1');
        await page.goto(fixture.href);
        await page.getByRole('button', { name: 'Повторить', exact: true }).click();
        await page.getByRole('button', { name: 'Открыть фото: Фото 1' }).waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        fixture.searchParams.delete('mediaError');
        fixture.searchParams.delete('long');
        fixture.searchParams.set('mode', 'reject');
        await page.goto(fixture.href);
        await page.getByRole('button', { name: 'Платное размещение', exact: true }).click();
        await page.getByRole('button', { name: 'Отклонить и отправить', exact: true }).click();
        await page
          .getByText('Укажите контакт для согласования размещения.', { exact: false })
          .waitFor();
        await page
          .getByRole('textbox', { name: 'Контакт для размещения', exact: true })
          .fill('https://max.ru/editor');
        await page.screenshot({
          path: `${output}/${name}-${profile}-${theme}-reject.png`,
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Отклонить и отправить', exact: true }).click();
        await page.getByText('Отклонено', { exact: true }).waitFor();
        const rejected = await page.evaluate(() =>
          window.reviewCalls.filter((x) => x.path.endsWith('/reject')),
        );
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].body.reason, 'paid');
        assert.equal(rejected[0].body.contactUrl, 'https://max.ru/editor');
        await page.getByRole('button', { name: 'Обновить статус', exact: true }).click();
        await page.getByText('Отклонено', { exact: true }).waitFor();
        fixture.searchParams.set('mode', 'edit');
        fixture.searchParams.set('stale', '1');
        await page.goto(fixture.href);
        await page.getByText('Мой несохранённый текст', { exact: true }).click();
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Мой несохранённый текст', exact: true })
            .inputValue(),
          'Мой старый черновик',
        );
        assert.equal(
          JSON.parse(
            await page.evaluate(() =>
              localStorage.getItem(
                `suggestion-review-v1:${document.body.dataset.miniappProfile}:101:suggestion-1`,
              ),
            ),
          ).text,
          'Мой старый черновик',
        );
        fixture.searchParams.delete('stale');
        fixture.searchParams.set('error', '1');
        await page.goto(fixture.href);
        await page.getByRole('button', { name: 'Повторить', exact: true }).click();
        await editor.waitFor();
        assert.deepEqual(errors, []);
        console.log(
          `${name} ${profile} ${theme}: edit, paid rejection, stale draft, refresh, error recovery passed`,
        );
        await context.close();
      }
    const page = await browser.newPage();
    for (const breaks of [1, 2, 3, 5]) {
      for (const value of [
        `  📣 **Цена** 300 ₽${'\n'.repeat(breaks)}[Сайт](https://example.test/)  \n\n`,
        '# Заголовок  \n> Цитата  \n\n  - пункт\n    - подпункт\n\n```\n  code\n```\n',
      ]) {
        const url = new URL('test/browser/rich-text.html', base);
        url.search = new URLSearchParams({ preserve: '1', value }).toString();
        await page.goto(url.href);
        const editor = page.getByRole('textbox', { name: 'Greeting', exact: true });
        await editor.waitFor();
        await editor.evaluate((el) => el.dispatchEvent(new InputEvent('input', { bubbles: true })));
        assert.equal(await page.getByTestId('markdown').textContent(), value);
      }
    }
    console.log(`${name}: whitespace and formatted DOM round trips passed`);
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
