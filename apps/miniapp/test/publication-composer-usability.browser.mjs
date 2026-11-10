import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-publication-usability-'));
let browser;

async function assertReachable(locator) {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      fits:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= (viewport?.offsetTop ?? 0) - 1 &&
        rect.bottom <= (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0) + 1,
      touch: rect.width >= 44 && rect.height >= 44,
      unobscured: element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.deepEqual(result, { fits: true, touch: true, unobscured: true });
}

async function pasteClipboardImage(editor, color, href = null) {
  return editor.evaluate(
    (element, { color, href }) => {
      element.focus();
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 2, 2);
      const imageUrl = canvas.toDataURL('image/png');
      const png = Uint8Array.from(atob(imageUrl.split(',')[1]), (character) =>
        character.charCodeAt(0),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([png], 'clipboard.png', { type: 'image/png' }));
      const imageHtml = `<img src="${imageUrl}">`;
      clipboardData.setData(
        'text/html',
        href
          ? element.innerHTML.replace('Абзац 18', `<a href="${href}">Абзац 18</a>`) + imageHtml
          : imageHtml,
      );
      if (href) clipboardData.setData('text/plain', element.innerText);
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
      return selection.toString();
    },
    { color, href },
  );
}

async function assertManualLinkDraftRoundTrip(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    // FLAG: Capture actual local draft/publish responses without changing their content.
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(base).origin
        ? route.continue()
        : route.abort(),
    );
    await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
      // FLAG: Retry one reset of the local Vite module GET; effect requests and HTTP errors
      // are not retried. A second reset still fails the scenario.
      const response = await route.fetch({ maxRetries: 1 });
      const source = await response.text();
      const marker = 'if (result !== PREVIEW_NOT_HANDLED) {';
      assert.ok(source.includes(marker));
      await route.fulfill({
        response,
        body: source.replace(
          marker,
          `${marker}
          if (context.url.pathname.startsWith('/publications')) {
            (window.__manualLinkApi ??= []).push({ path: context.url.pathname, method: context.method,
              request: typeof context.init.body === 'string' ? JSON.parse(context.init.body) : null,
              response: structuredClone(result) });
          }
        `,
        ),
      });
    });
    await context.addInitScript(() => {
      window.__manualLinkPasteCount = 0;
      document.addEventListener('paste', () => {
        window.__manualLinkPasteCount += 1;
      });
    });
    await installMaxBridgeShimInitScript(context, {});
    await page.goto(`${base}publications?preview=1&profile=publisher`);
    await page.getByRole('button', { name: 'Создать публикацию', exact: true }).click();
    await page.getByRole('button', { name: 'Написать', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
    const label = 'Ручная ссылка';
    const text = `${label} без HTML-вставки`;
    const callToAction = 'Подписаться на нас 👇';
    const href = 'https://example.com/manual-only?source=publik&read=1';
    const markdown = `[${label}](${href}) без HTML-вставки\n\n**${callToAction}**`;
    await editor.fill(text);
    await editor.evaluate((element, length) => {
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, length);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, label.length);
    await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
    await page.getByRole('button', { name: 'Ссылка', exact: true }).click();
    await page.getByRole('textbox', { name: 'Адрес ссылки', exact: true }).fill(href);
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await editor.evaluate((element) => {
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Жирный', exact: true }).click();
    await page.keyboard.insertText(callToAction);
    await page.locator('.publication-target-picker__summary').click();
    const picker = page.getByRole('dialog', { name: 'Получатели', exact: true });
    await picker
      .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
      .click();
    await picker.getByRole('button', { name: 'Завершить выбор получателей' }).click();
    await page
      .locator('.publications-editor-header')
      .getByRole('button', { name: 'Назад', exact: true })
      .click();
    await page.locator('.publications-page:not(.is-editor)').waitFor();
    const saved = await page.evaluate(() =>
      window.__manualLinkApi.findLast(
        ({ request, response }) => request?.content && response?.publication?.lifecycle === 'DRAFT',
      ),
    );
    assert.equal(saved.request.content.text, markdown);
    assert.equal(saved.request.content.textFormat, 'markdown');
    assert.equal(saved.response.publication.content.text, markdown);
    assert.equal(saved.response.publication.content.textFormat, 'markdown');
    const draftId = saved.response.publication.id;
    await page.getByRole('button', { name: 'Черновики', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Черновики', exact: true })
      .getByRole('button', { name: new RegExp(text, 'u') })
      .click();
    await editor.waitFor();
    assert.equal(await editor.innerText(), `${text}\n\n${callToAction}`);
    assert.equal(await editor.locator('a').getAttribute('href'), href);
    assert.equal(await editor.locator('strong, b').innerText(), callToAction);
    const reopened = await page.evaluate(
      (draftId) =>
        window.__manualLinkApi.findLast(
          ({ path, method }) => path === `/publications/drafts/${draftId}` && method === 'GET',
        ),
      draftId,
    );
    assert.equal(reopened.response.publication.content.text, markdown);
    assert.equal(reopened.response.publication.content.textFormat, 'markdown');
    await page.getByRole('button', { name: 'Проверить пост', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
    const preview = review.locator('.publication-preview__text');
    const previewCallToAction = preview.locator('strong');
    await previewCallToAction.waitFor();
    assert.equal(await preview.locator('br').count(), 2);
    assert.equal(await previewCallToAction.innerText(), callToAction);
    assert.equal(
      await previewCallToAction.evaluate(
        (element) =>
          element.previousSibling?.nodeName === 'BR' &&
          element.previousSibling.previousSibling?.nodeName === 'BR',
      ),
      true,
    );
    await review.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await page.locator('.publications-page:not(.is-editor)').waitFor();
    const published = await page.evaluate(() =>
      window.__manualLinkApi.findLast(({ request }) => request?.intent === 'publish'),
    );
    assert.equal(published.path, `/publications/${draftId}`);
    assert.equal(published.request.content.text, markdown);
    assert.equal(published.request.content.textFormat, 'markdown');
    assert.equal(await page.evaluate(() => window.__manualLinkPasteCount), 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS manual-only: Link button, native blank paragraph and bold CTA survive draft save, reopen GET, review and publish; no paste',
    );
  } catch (error) {
    await page.screenshot({ path: `${output}/manual-only-failure.png` });
    throw error;
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ headless: true });
  await assertManualLinkDraftRoundTrip(browser);
  for (const [name, device] of [
    ['iphone-se', devices['iPhone SE']],
    ['iphone', devices['iPhone 15']],
    ['android', devices['Pixel 7']],
    ['desktop', { viewport: { width: 1280, height: 900 } }],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...device, colorScheme });
      const page = await context.newPage();
      const errors = [];
      const heldClipboardRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        // FLAG: Preview-only flow; no external traffic or real publication is allowed.
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        // FLAG: Inject a stale-access response only into the local preview transport.
        // Hold its refresh operation open to exercise the real editor's waiting state.
        await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
          // FLAG: Same bounded ECONNRESET-only retry for the local source module, never publish.
          const response = await route.fetch({ maxRetries: 1 });
          const source = await response.text();
          const marker = 'for (const handler of handlers) {';
          assert.ok(source.includes(marker));
          const errorModule = new URL('src/lib/api-request-error.ts', base).pathname;
          const body =
            `import { ApiRequestError as AccessRefreshSmokeError } from '${errorModule}';\n` +
            source.replace(
              marker,
              `
            const smoke = window.__publicationAccessSmoke ??= { attempts: [], refreshes: [], released: false };
            if (/^\\/publications\\/[^/]+$/.test(context.url.pathname) && context.method === 'PUT' && JSON.parse(context.init.body).intent === 'publish') {
              smoke.attempts.push({ path: context.url.pathname, body: context.init.body });
              if (smoke.attempts.length === 1) throw new AccessRefreshSmokeError(409, JSON.stringify({ code: 'PUBLISHER_SETUP_REQUIRED', blockerCode: 'bot_access_expired' }), 'Обновляется проверка доступа Публика. Повторите позже.');
            }
            if (context.url.pathname === '/publisher/entities/refresh-selected') smoke.refreshes.push(JSON.parse(context.init.body));
            if (context.url.pathname.startsWith('/publisher/refresh-operations/') && !smoke.released) return { operationId: context.url.pathname.split('/').at(-1), state: 'running', total: 1, completed: 0, failed: 0 };
            ${marker}
          `,
            );
          const resultMarker = 'const result = await handler(context);';
          assert.ok(body.includes(resultMarker));
          const withStaleCatalog = body.replace(
            resultMarker,
            `${resultMarker}
            if (context.url.pathname.startsWith('/publisher/entities') && result?.items) {
              if (context.url.searchParams.get('readiness') === 'ready') throw new Error('Stale recipients must remain visible');
              for (const entity of result.items) if (entity.readiness?.canPublish) {
                entity.readiness = { ...entity.readiness, state: 'setup_required', canPublish: false, blockerCode: 'bot_access_expired' };
              }
            }
          `,
          );
          await route.fulfill({ response, body: withStaleCatalog });
        });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        await installNativeVisualModeInitScript(context);
        await page.goto(`${base}publications?preview=1&profile=publisher`);
        const create = page.getByRole('button', { name: 'Создать публикацию', exact: true });
        await create.waitFor();
        await applyNativeVisualMode(page, {
          safeTop: name.startsWith('iphone') ? 59 : 24,
          safeBottom: name.startsWith('iphone') ? 34 : 0,
        });
        assert.equal(await create.locator('span').isVisible(), true);
        await create.click();
        await page.getByRole('button', { name: 'Написать', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
        const primary = page.getByRole('button', { name: 'Проверить пост', exact: true });
        const scroll = page.locator('.publications-editor');
        await editor.waitFor();
        await assertReachable(primary);
        await primary.click();
        await page
          .locator('.publication-submit-feedback')
          .getByText('Добавьте текст, фото или видео.', { exact: true })
          .waitFor();
        assert.equal(await editor.getAttribute('aria-invalid'), 'true');

        const postActions = page.getByRole('button', { name: /После публикации/u });
        assert.equal(await postActions.getAttribute('aria-expanded'), 'false');
        await page.locator('.publication-target-picker__summary').click();
        const picker = page.getByRole('dialog', { name: 'Получатели', exact: true });
        await picker.waitFor();
        await picker.getByText('Проверяем права Публика', { exact: true }).first().waitFor();
        await page.waitForFunction(() =>
          document.activeElement?.matches('.publication-target-picker__editor.is-sheet'),
        );
        await picker
          .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
          .click();
        const done = picker.getByRole('button', { name: 'Завершить выбор получателей' });
        assert.equal(await done.textContent(), 'Готово · 1');
        await assertReachable(done);
        if (name !== 'desktop') {
          await picker
            .getByRole('button', { name: 'Выбрать Садоводы Южного, чат', exact: true })
            .click();
          await picker.getByRole('searchbox').focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(
            () =>
              document
                .querySelector('.publication-target-picker__editor.is-sheet')
                .getBoundingClientRect().height <= 301,
          );
          await assertReachable(done);
          assert.ok(
            await picker
              .locator('.publication-target-picker__list')
              .evaluate((element) => element.clientHeight >= 58),
            'Search keeps at least one recipient row visible',
          );
          await page.evaluate(() => {
            delete visualViewport.height;
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await picker
            .getByRole('button', { name: 'Убрать Садоводы Южного, чат', exact: true })
            .click();
        }
        await done.click();

        const text = Array.from(
          { length: 18 },
          (_, index) =>
            `Абзац ${index + 1}. Проверяем удобство длинного поста и сохранение текста.`,
        ).join('\n\n');
        // Exercise the clipboard handler used by people pasting a prepared post.
        await editor.evaluate((element, content) => {
          element.focus();
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', content);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
        }, text);
        await editor.press('End');
        await editor.pressSequentially(' Дополнение');
        await editor.evaluate((element) => {
          const node = element.firstChild;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 7);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
        await page.getByRole('button', { name: 'Жирный', exact: true }).click();
        await editor.locator('strong, b').first().waitFor();
        assert.equal(await editor.locator('strong, b').first().textContent(), 'Абзац 1');
        const href = 'https://example.com/article?source=publik&read=1';
        await page.getByRole('button', { name: 'Ссылка', exact: true }).click();
        await page.getByRole('textbox', { name: 'Адрес ссылки', exact: true }).fill(href);
        await page.getByRole('button', { name: 'Применить', exact: true }).click();
        await page.keyboard.insertText('Первый абзац');
        assert.equal(await editor.locator('a').textContent(), 'Первый абзац');
        assert.equal(await editor.locator('a').getAttribute('href'), href);
        assert.equal(await editor.locator('strong, b').first().textContent(), 'Первый абзац');
        await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
        const authoredText = await editor.innerText();
        await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }));
        await assertReachable(primary);
        await assertReachable(page.getByRole('button', { name: 'Форматирование', exact: true }));
        assert.equal(
          await page
            .locator('.publication-content-composer')
            .getByText('Фото', { exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await page
            .locator('.publication-video-tool')
            .getByText('Видео', { exact: true })
            .isVisible(),
          true,
        );
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-long.png` });

        if (name !== 'desktop') {
          await editor.focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(() =>
            document.querySelector('.publications-page').classList.contains('is-keyboard-open'),
          );
          await assertReachable(primary);
          await primary.click();
          await page.getByRole('dialog', { name: 'Проверка публикации', exact: true }).waitFor();
          await page.evaluate(() => {
            delete visualViewport.height;
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page
            .getByRole('dialog', { name: 'Проверка публикации', exact: true })
            .getByRole('button', { name: 'Назад', exact: true })
            .click();
          assert.equal(await editor.innerText(), authoredText);
        }

        await postActions.click();
        await page.getByRole('switch', { name: 'Закрепить пост', exact: true }).check();
        await page.getByRole('switch', { name: 'Удалить автоматически', exact: true }).check();
        await postActions.click();
        assert.match(
          await postActions.textContent(),
          /Закрепить с уведомлением.*Удаление через 1 дн./u,
        );
        const pastedHref = 'https://example.com/pasted?source=publik&read=1';
        // FLAG: After the editor is ready, hold any late clipboard-code download. Publishing
        // immediately after the first rich paste must use its links, not the previous plain text.
        await context.route(/\/src\/lib\/max-rich-text-clipboard\.ts(?:\?|$)/u, (route) => {
          heldClipboardRequests.push(route);
        });
        await editor.evaluate((element, href) => {
          element.focus();
          const pastedHtml = element.innerHTML.replace(
            'Дополнение',
            `<a href="${href}">Дополнение</a>`,
          );
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', element.innerText);
          clipboardData.setData('text/html', pastedHtml);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
        }, pastedHref);
        await primary.click();
        const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
        await review.waitFor();
        assert.match(await review.locator('.publication-preview__text').textContent(), /Абзац 18/u);
        assert.match(
          await review.locator('.publication-preview__facts').textContent(),
          /Закрепить с уведомлением.*Удаление через 1 дн./u,
        );
        await assertReachable(review.getByRole('button', { name: 'Опубликовать', exact: true }));
        await review.getByRole('button', { name: 'Назад', exact: true }).click();
        assert.equal(await editor.innerText(), authoredText);
        const captionHref = 'https://example.com/image-caption?source=publik';
        await pasteClipboardImage(editor, '#204080', captionHref);
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.publication-content-composer .broadcast-message-card img')
              .length === 1,
        );
        await page.waitForFunction(
          () => !document.querySelector('.publication-content-composer[aria-busy="true"]'),
        );
        assert.equal(
          await pasteClipboardImage(editor, '#c06020'),
          authoredText,
          'Pasting an image without a caption preserves the selected text',
        );
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.publication-content-composer .broadcast-message-card img')
              .length === 2,
        );
        await primary.click();
        await review.getByRole('button', { name: 'Опубликовать', exact: true }).click();
        const checking = page.getByRole('button', { name: 'Проверяем доступ...', exact: true });
        await checking.waitFor();
        await page.waitForFunction(() => window.__publicationAccessSmoke?.refreshes.length === 1);
        assert.equal(await checking.isDisabled(), true);
        await assertReachable(checking);
        await checking.evaluate((element) => element.click());
        assert.equal(await editor.innerText(), authoredText);
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-access-refresh.png` });
        assert.equal(await page.evaluate(() => window.__publicationAccessSmoke.attempts.length), 1);
        await page.evaluate(() => {
          window.__publicationAccessSmoke.released = true;
        });
        await page.locator('.publications-page:not(.is-editor)').waitFor();
        const access = await page.evaluate(() => window.__publicationAccessSmoke);
        assert.equal(access.attempts.length, 2);
        assert.deepEqual(access.attempts[0], access.attempts[1]);
        assert.equal(access.refreshes.length, 1);
        const submitted = JSON.parse(access.attempts[0].body);
        assert.equal(submitted.content.textFormat, 'markdown');
        assert.ok(
          submitted.content.text.includes(`[Абзац 18](${captionHref})`),
          `${name}: a pasted image retains the links in its accompanying HTML caption`,
        );
        assert.ok(submitted.content.text.includes(`[Первый абзац](${href})`));
        assert.ok(
          submitted.content.text.includes(`[Дополнение](${pastedHref})`),
          `${name}: immediate publication retains the pasted link while late clipboard downloads are held (${heldClipboardRequests.length})`,
        );
        assert.equal(submitted.content.text.includes('data-max-link-'), false);
        assert.equal(submitted.content.media.length, 2, 'Each clipboard image is processed once');
        assert.deepEqual(
          access.refreshes[0].targets,
          submitted.audience.targets.map(({ chatId, entityType }) => ({ id: chatId, entityType })),
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}-${colorScheme}: create, targets, long text, keyboard, options, review, preview publish`,
        );
      } catch (error) {
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-failure.png` });
        throw error;
      } finally {
        for (const request of heldClipboardRequests) await request.abort();
        await context.close();
      }
    }
  }
} finally {
  console.log(`Screenshots: ${output}`);
  await browser?.close();
  await stopChildProcess(server);
}
