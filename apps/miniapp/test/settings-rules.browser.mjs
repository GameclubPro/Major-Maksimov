import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { setPhoneKeyboard } from '../../../scripts/miniapp-smartphone.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-rules-publication-'));
let browser;
async function assertToastContrast(toast) {
  const contrasts = await toast.evaluate((node) => {
    const parseColor = (color) => color.match(/[\d.]+/gu).map(Number);
    const luminance = (rgb) =>
      rgb
        .slice(0, 3)
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const style = getComputedStyle(node);
    const stops = (style.backgroundImage.match(/rgba?\([^)]+\)/gu) ?? [style.backgroundColor]).map(
      parseColor,
    );
    return [...node.querySelectorAll('h4, p')]
      .filter((text) => getComputedStyle(text).display !== 'none')
      .map((text) => {
        const color = parseColor(getComputedStyle(text).color);
        const alpha = color[3] ?? 1;
        return Math.min(
          ...stops.map((background) => {
            const blended = color
              .slice(0, 3)
              .map((value, index) => value * alpha + background[index] * (1 - alpha));
            const foregroundLum = luminance(blended);
            const backgroundLum = luminance(background);
            return (
              (Math.max(foregroundLum, backgroundLum) + 0.05) /
              (Math.min(foregroundLum, backgroundLum) + 0.05)
            );
          }),
        );
      });
  });
  assert.ok(contrasts.length > 0);
  for (const ratio of contrasts)
    assert.ok(ratio >= 4.5, `Toast text contrast ${ratio.toFixed(2)}:1`);
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/settings-rules-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
    window.__vite_plugin_react_preamble_installed__=true;
    await import('/app/test/fixtures/settings-rules-harness.tsx');
  </script></body></html>`,
    }),
  );
  let requests = [];
  let initial;
  await page.route('**/api/chats/*/rules**', (route) => {
    requests.push(route);
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const fresh = async () => {
    requests = [];
    await page.goto(`${base}settings-rules-test`);
    await page.waitForFunction(() =>
      Boolean(
        JSON.parse(document.querySelector('[data-testid="state"]')?.textContent ?? '{}').draft,
      ),
    );
    initial = (await read()).draft;
  };
  const waitCount = async (count) => {
    for (let i = 0; i < 100 && requests.length < count; i++) await page.waitForTimeout(20);
    assert.equal(requests.length, count);
  };
  const reply = async (index, status = 200, body) => {
    const route = requests[index];
    const done = page.waitForResponse(
      (response) =>
        response.url() === route.request().url() &&
        response.request().method() === route.request().method(),
    );
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        body ??
          (status === 200
            ? { ...initial, ...route.request().postDataJSON() }
            : { message: 'Ошибка сохранения' }),
      ),
    });
    await done;
    await page.waitForTimeout(50);
  };
  await fresh();
  const editor = page.getByLabel('Правила', { exact: true });
  await editor.fill('Первая редакция');
  await waitCount(1);
  assert.equal(requests[0].request().method(), 'PUT');
  assert.equal(new URL(requests[0].request().url()).pathname, '/api/chats/chat-a/rules');
  assert.equal(Object.hasOwn(requests[0].request().postDataJSON(), 'publishedMessageId'), false);
  assert.equal(await editor.isEnabled(), true);
  await editor.fill('Новая редакция во время сохранения');
  await reply(0);
  assert.equal((await read()).draft.text, 'Новая редакция во время сохранения');
  assert.equal((await read()).dirty, true);
  console.log('PASS: autosave payload excludes publication metadata and preserves newer edits');

  await fresh();
  await editor.fill('Не терять после ошибки');
  await waitCount(1);
  await reply(0, 500);
  await page.waitForTimeout(1000);
  assert.equal(requests.length, 1);
  assert.equal((await read()).draft.text, 'Не терять после ошибки');
  assert.equal((await read()).dirty, true);
  console.log('PASS: failed autosave retains draft and pauses unchanged retries');

  await fresh();
  await editor.fill('Публикация после сохранения');
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(1);
  await page.getByRole('button', { name: 'Другой чат' }).click();
  await editor.fill('Черновик другого чата');
  await reply(0);
  assert.equal((await read()).draft.text, 'Черновик другого чата');
  assert.equal(requests.filter((r) => r.request().method() === 'POST').length, 0);
  assert.deepEqual((await read()).events, []);
  console.log('PASS: navigation during save prevents subsequent publication');

  for (const status of [200, 500]) {
    await fresh();
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await waitCount(1);
    assert.deepEqual(requests[0].request().postDataJSON(), { mode: 'new_message' });
    await page.getByRole('button', { name: 'Другой чат' }).click();
    const before = await read();
    await reply(0, status, {
      chatId: 'chat-a',
      messageId: 'new-post',
      url: null,
      publishedAt: '2026-10-03T01:00:00.000Z',
      operation: 'created',
    });
    assert.deepEqual(await read(), before);
  }
  console.log('PASS: late publication success/error cannot affect another chat');

  await fresh();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(1);
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click({ force: true });
  await page
    .getByRole('button', { name: 'Удалить публикацию', exact: true })
    .click({ force: true });
  await page.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
  assert.equal((await read()).resetConfirmation, false);
  await reply(0, 200, {
    chatId: 'chat-a',
    messageId: 'new-post',
    url: null,
    publishedAt: '2026-10-03T01:00:00.000Z',
    operation: 'created',
  });
  // FLAG: Response headers alone do not prove React has committed the mutation result.
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector('[data-testid="state"]')?.textContent ?? '{}');
    return state.busy === false;
  });
  assert.equal(requests.length, 1);
  assert.equal((await read()).draft.publishedMessageId, 'new-post');
  assert.equal((await read()).draft.publishedUrl, null);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: duplicate-click protection and missing new link preserve publication identity',
  );

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, { ...initial, revision: '2026-11-10T06:01:00.000Z' });
  assert.equal((await read()).pendingReset, true);
  assert.equal((await read()).draft.publishedMessageId, 'old-post');
  assert.deepEqual((await read()).events, ['Пост правил ещё удаляется']);
  await waitCount(2);
  assert.equal(requests[1].request().method(), 'GET');
  const removed = {
    ...initial,
    revision: '2026-11-10T06:02:00.000Z',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
  };
  await reply(1, 200, removed);
  assert.equal((await read()).pendingReset, false);
  assert.equal((await read()).draft.publishedMessageId, null);
  await page.waitForTimeout(2100);
  assert.equal(requests.length, 2);
  console.log('PASS: accepted deletion retains receipt and stops readback after confirmed cleanup');

  await fresh();
  await editor.fill('Черновик во время удаления');
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  assert.equal(requests[0].request().method(), 'DELETE');
  await page.waitForTimeout(1000);
  assert.equal(requests.length, 1, 'Autosave must wait while deletion is in flight');
  await reply(0, 200, removed);
  assert.equal((await read()).draft.text, 'Черновик во время удаления');
  assert.equal((await read()).draft.publishedMessageId, null);
  await waitCount(2);
  const saveAfterReset = requests[1].request().postDataJSON();
  assert.equal(saveAfterReset.text, 'Черновик во время удаления');
  assert.equal(saveAfterReset.expectedRevision, removed.revision);
  await reply(1, 200, { ...removed, ...saveAfterReset });
  console.log(
    'PASS: deletion serializes autosave and preserves dirty text with authoritative revision',
  );

  await fresh();
  await page.getByRole('button', { name: 'Подготовить фото', exact: true }).click();
  await page
    .getByRole('button', { name: 'Удалить публикацию', exact: true })
    .click({ force: true });
  await page.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
  assert.equal(requests.length, 0);
  assert.equal((await read()).resetConfirmation, false);
  console.log('PASS: reset cannot overlap image preparation');

  await fresh();
  await editor.fill('Редакция при устаревшей версии');
  await waitCount(1);
  await reply(0, 409, { message: 'Правила уже изменены. Обновите данные.' });
  await waitCount(2);
  assert.equal(requests[1].request().method(), 'GET');
  await editor.fill('Продолжение ввода после конфликта');
  await reply(1, 200, removed);
  await page.waitForTimeout(1100);
  assert.equal(requests.length, 2, 'A 409 must pause automatic writes across further typing');
  assert.equal((await read()).draft.text, 'Продолжение ввода после конфликта');
  assert.equal((await read()).draft.revision, removed.revision);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await waitCount(3);
  assert.equal(requests[2].request().postDataJSON().expectedRevision, removed.revision);
  await reply(2, 200, { ...removed, ...requests[2].request().postDataJSON() });
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).dirty === false,
  );
  assert.equal((await read()).dirty, false);
  console.log(
    'PASS: conflict pauses autosave and receipt-only refresh permits explicit save retry',
  );

  await fresh();
  await editor.fill('Не затирать чужие изменения');
  await waitCount(1);
  await reply(0, 409);
  await waitCount(2);
  await reply(1, 200, { ...removed, text: 'Изменения другого администратора' });
  await editor.fill('Локальный черновик остаётся');
  await page.waitForTimeout(1100);
  assert.equal(requests.length, 2);
  assert.equal((await read()).draft.text, 'Локальный черновик остаётся');
  assert.equal((await read()).draft.revision, initial.revision);
  console.log('PASS: conflicting saved content cannot silently advance the local write revision');

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, initial);
  await page.getByRole('button', { name: 'Скрыть правила', exact: true }).click();
  await page.waitForTimeout(1200);
  assert.equal(requests.length, 1, 'Closed Rules must stop automatic readback');
  await page.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
  await waitCount(2);
  assert.equal(requests[1].request().method(), 'GET', 'Manual check must never delete again');
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  const otherChat = await read();
  await reply(1, 200, removed);
  assert.deepEqual(await read(), otherChat);
  console.log('PASS: closed modules stop readback and a late check cannot affect another chat');

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, {
    ...initial,
    publishedMessageId: 'concurrent-post',
    publishedUrl: 'https://max.ru/concurrent-post',
  });
  assert.equal((await read()).pendingReset, false);
  assert.equal((await read()).draft.publishedMessageId, 'concurrent-post');
  assert.deepEqual((await read()).events, ['В чате уже другой пост правил']);
  console.log('PASS: a newer concurrent post is preserved without claiming its deletion');

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, initial);
  await page.getByRole('button', { name: 'Скрыть правила', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
  await waitCount(2);
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(3);
  assert.equal(requests[2].request().method(), 'POST');
  await reply(2, 200, {
    chatId: 'chat-a',
    messageId: 'newer-post',
    url: 'https://max.ru/newer-post',
    publishedAt: '2026-11-10T06:03:00.000Z',
    operation: 'created',
  });
  await reply(1, 200, initial);
  assert.equal((await read()).draft.publishedMessageId, 'newer-post');
  assert.equal((await read()).pendingReset, false);
  console.log('PASS: a late readback cannot overwrite a newer publication in the same chat');

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, initial);
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(3);
  assert.equal(requests[1].request().method(), 'POST');
  assert.equal(requests[2].request().method(), 'GET');
  await reply(1, 200, {
    chatId: 'chat-a',
    messageId: 'post-after-read-started',
    url: 'https://max.ru/post-after-read-started',
    publishedAt: '2026-11-10T06:04:00.000Z',
    operation: 'created',
  });
  await reply(2, 200, initial);
  assert.equal((await read()).draft.publishedMessageId, 'post-after-read-started');
  assert.equal((await read()).pendingReset, false);
  console.log('PASS: readback started during publication cannot overwrite its later receipt');

  await fresh();
  await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, initial);
  await page.getByRole('button', { name: 'Скрыть правила', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
  await waitCount(2);
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await reply(1, 200, removed);
  assert.equal((await read()).draft.publishedMessageId, 'old-post');
  console.log('PASS: readback from an earlier visit cannot replace the same chat on return');

  for (const operation of ['save', 'reset']) {
    await fresh();
    if (operation === 'save') {
      await editor.fill('Сохранение из прошлого посещения');
    } else {
      await page.getByRole('button', { name: 'Удалить публикацию', exact: true }).click();
    }
    await waitCount(1);
    const earlierResponse =
      operation === 'save'
        ? {
            ...initial,
            ...requests[0].request().postDataJSON(),
            revision: '2026-11-10T06:03:00.000Z',
          }
        : removed;
    await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
    await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
    await page.getByRole('button', { name: 'Обновить с сервера', exact: true }).click();
    await waitCount(2);
    assert.equal(requests[1].request().method(), 'GET');
    const newer = {
      ...initial,
      text: 'Актуальные правила нового посещения',
      revision: '2026-11-10T06:05:00.000Z',
      publishedMessageId: 'post-from-newer-visit',
      publishedUrl: 'https://max.ru/post-from-newer-visit',
    };
    await reply(1, 200, newer);
    assert.equal((await read()).draft.text, newer.text);
    await reply(0, 200, earlierResponse);
    const currentVisit = await read();
    assert.equal(currentVisit.draft.text, newer.text);
    assert.equal(currentVisit.draft.revision, newer.revision);
    assert.equal(currentVisit.draft.publishedMessageId, newer.publishedMessageId);
    assert.deepEqual(currentVisit.events, []);
    console.log(`PASS: late ${operation} response cannot replace a newer visit's draft or receipt`);
  }
  const builderPattern = '**/src/pages/settings-rules-text.ts*';
  const holdBuilder = async () => {
    let capture;
    const pending = new Promise((resolve) => {
      capture = resolve;
    });
    const handler = (route) => capture(route);
    await page.route(builderPattern, handler);
    return {
      pending,
      async release(route) {
        await route.continue();
        await page.unroute(builderPattern, handler);
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy === false,
        );
      },
    };
  };

  let builder = await holdBuilder();
  await fresh();
  await page.getByRole('button', { name: 'Автотекст', exact: true }).click();
  let builderRoute = await builder.pending;
  assert.equal((await read()).busy, true);
  assert.equal(await editor.isDisabled(), true);
  assert.equal(requests.length, 0);
  await page.getByRole('button', { name: 'Обновить с сервера', exact: true }).click();
  await waitCount(1);
  const receiptDuringLoad = {
    ...initial,
    revision: '2026-11-10T06:08:00.000Z',
    publishedMessageId: 'receipt-during-autofill',
    publishedUrl: 'https://max.ru/receipt-during-autofill',
  };
  await reply(0, 200, receiptDuringLoad);
  await builder.release(builderRoute);
  const filled = (await read()).draft;
  assert.equal(filled.autoTextEnabled, true);
  assert.match(filled.text, /^Правила чата:/u);
  assert.match(filled.text, /Пожалуйста, не флудите и не спамьте\./u);
  assert.equal(filled.revision, receiptDuringLoad.revision);
  assert.equal(filled.publishedMessageId, receiptDuringLoad.publishedMessageId);
  await waitCount(2);
  assert.equal(requests[1].request().method(), 'PUT');
  assert.equal(requests[1].request().postDataJSON().expectedRevision, receiptDuringLoad.revision);
  await reply(1, 200, { ...filled, revision: '2026-11-10T06:09:00.000Z' });
  console.log('PASS: lazy autofill preserves publication metadata refreshed during loading');

  builder = await holdBuilder();
  await fresh();
  await page.getByRole('button', { name: 'Автотекст', exact: true }).click();
  builderRoute = await builder.pending;
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await builder.release(builderRoute);
  await page.waitForTimeout(1000);
  assert.equal((await read()).draft.autoTextEnabled, false);
  assert.equal((await read()).draft.text, initial.text);
  assert.deepEqual((await read()).events, []);
  assert.equal(requests.length, 0);
  console.log('PASS: lazy autofill cannot modify the same chat after leaving and returning');

  builder = await holdBuilder();
  await fresh();
  await page.getByRole('button', { name: 'Автотекст', exact: true }).click();
  builderRoute = await builder.pending;
  await page.getByRole('button', { name: 'Обновить с сервера', exact: true }).click();
  await waitCount(1);
  const editedDuringLoad = {
    ...initial,
    text: 'Новый сохранённый текст во время автозаполнения',
    revision: '2026-11-10T06:10:00.000Z',
  };
  await reply(0, 200, editedDuringLoad);
  await builder.release(builderRoute);
  assert.equal((await read()).draft.text, editedDuringLoad.text);
  assert.equal((await read()).draft.autoTextEnabled, false);
  assert.equal(requests.length, 1);
  console.log('PASS: lazy autofill cancels when editable content changes during loading');

  builder = await holdBuilder();
  await fresh();
  await page.getByRole('button', { name: 'Обновить с сервера', exact: true }).click();
  await waitCount(1);
  await reply(0, 200, { ...initial, autoTextEnabled: true });
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  builderRoute = await builder.pending;
  assert.equal(requests.length, 1);
  assert.equal((await read()).busy, true);
  await builderRoute.continue();
  await page.unroute(builderPattern);
  await waitCount(2);
  assert.equal(requests[1].request().method(), 'PUT');
  const preparedPayload = requests[1].request().postDataJSON();
  assert.equal(preparedPayload.autoTextEnabled, true);
  assert.match(preparedPayload.text, /^Правила чата:/u);
  await reply(1, 200, {
    ...initial,
    ...preparedPayload,
    revision: '2026-11-10T06:11:00.000Z',
  });
  await waitCount(3);
  assert.equal(requests[2].request().method(), 'POST');
  await reply(2, 200, {
    chatId: 'chat-a',
    messageId: 'auto-text-post',
    url: 'https://max.ru/auto-text-post',
    publishedAt: '2026-11-10T06:12:00.000Z',
    operation: 'created',
  });
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy === false,
  );
  assert.equal((await read()).draft.publishedMessageId, 'auto-text-post');
  console.log('PASS: publication waits for lazy autotext generation and its exact saved draft');

  builder = await holdBuilder();
  await fresh();
  await page.getByRole('button', { name: 'Автотекст', exact: true }).click();
  builderRoute = await builder.pending;
  await builderRoute.abort('failed');
  await page.unroute(builderPattern);
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy === false,
  );
  const failedImport = await read();
  assert.equal(failedImport.draft.text, initial.text);
  assert.equal(failedImport.draft.autoTextEnabled, false);
  assert.equal(
    failedImport.textError,
    'Не удалось загрузить автотекст правил. Проверьте соединение и повторите.',
  );
  assert.deepEqual(failedImport.events, ['Не удалось собрать текст правил']);
  assert.equal(requests.length, 0);
  console.log(
    'PASS: lazy import failure keeps the draft and reports a readable error without writes',
  );
  assert.deepEqual(errors, []);
  await page.close();

  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
    ['android-light', devices['Pixel 7'], 'light', 'android'],
    ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      await context.route('**/rules-screen-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/app/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
          window.__vite_plugin_react_preamble_installed__=true;
          await import('/app/test/fixtures/settings-rules-screen-harness.tsx');
        </script></body></html>`,
        }),
      );
      const screenPage = await context.newPage();
      const screenErrors = [];
      screenPage.on('pageerror', (error) => screenErrors.push(error.message));
      let rules;
      let deleteCalls = 0;
      let publishCalls = 0;
      const detail =
        'Предыдущий пост правил ещё удаляется. Подождите немного и повторите публикацию. Если ошибка остаётся, обратитесь в поддержку: результат предыдущей операции нужно проверить.';
      await screenPage.route('**/api/chats/chat-a/**', async (route) => {
        try {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          // FLAG: Module imports also contain /api/. Intercept only this fixture's HTTP routes.
          assert.ok(pathname.startsWith('/api/chats/chat-a/'));
          const screen = await screenPage.evaluate(() => window.__RULES_SCREEN__);
          assert.ok(screen, 'The fixture must initialize its screen before mounting SettingsPage');
          rules ??= screen.rules;
          if (pathname.endsWith('/settings-screen')) {
            await route.fulfill({ json: { ...screen, rules } });
          } else if (pathname.endsWith('/rules/publish') && request.method() === 'DELETE') {
            deleteCalls += 1;
            rules = { ...rules, revision: '2026-11-10T06:01:00.000Z' };
            await route.fulfill({ json: rules });
          } else if (pathname.endsWith('/rules/publish') && request.method() === 'POST') {
            publishCalls += 1;
            await route.fulfill({ status: 400, json: { message: detail } });
          } else if (pathname.endsWith('/rules')) {
            if (request.method() === 'PUT') rules = { ...rules, ...request.postDataJSON() };
            await route.fulfill({ json: rules });
          } else {
            await route.fulfill({ status: 500, json: { message: 'Unexpected rules request' } });
          }
        } catch (error) {
          screenErrors.push(error instanceof Error ? error.message : String(error));
          console.error('Rules screen route failed:', error);
          await route.abort().catch(() => {});
        }
      });
      await screenPage.goto(`${base}rules-screen-test`);
      const panel = screenPage.locator('.settings-drilldown__panel--rules-screen');
      await panel.waitFor();
      await applyNativeVisualMode(screenPage, {
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
      });
      await panel.getByRole('button', { name: 'Удалить пост правил', exact: true }).click();
      await screenPage.getByRole('button', { name: 'Удалить пост', exact: true }).click();
      await panel.getByText('Прежний пост ещё удаляется', { exact: true }).waitFor();
      assert.equal(
        await panel.getByRole('button', { name: 'Открыть', exact: true }).isVisible(),
        true,
      );
      await assertToastContrast(screenPage.locator('.toast--info').last());
      await screenPage.screenshot({ path: path.join(screenshots, `${name}-pending.png`) });
      await panel.getByRole('button', { name: 'Проверить и опубликовать', exact: true }).click();
      const danger = screenPage.locator('.toast--danger');
      await danger.waitFor();
      const description = danger.locator('p');
      await assertToastContrast(danger);
      assert.equal(await description.innerText(), detail);
      assert.equal(
        await description.evaluate((node) => {
          const style = getComputedStyle(node);
          return (
            style.display === 'block' &&
            !['hidden', 'clip'].includes(style.overflowY) &&
            node.scrollHeight <= node.clientHeight + 1
          );
        }),
        true,
        'The complete recovery instruction must remain visible on mobile',
      );
      await screenPage.screenshot({ path: path.join(screenshots, `${name}-error.png`) });
      await danger.getByRole('button', { name: 'Закрыть уведомление' }).click();
      for (const toast of await screenPage.locator('.toast__close').all()) await toast.click();
      // FLAG: Keep the receipt pending until the click; automatic readback can remove this button.
      await panel.getByRole('button', { name: 'Проверить удаление', exact: true }).click();
      rules = {
        ...rules,
        revision: '2026-11-10T06:02:00.000Z',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      };
      await panel.getByRole('button', { name: 'Опубликовать в чат', exact: true }).waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Открыть', exact: true }).count(), 0);
      assert.equal(deleteCalls, 1, 'Checking a queued delete must not submit another DELETE');
      assert.equal(publishCalls, 1, 'Readback must never publish automatically');
      const screenEditor = panel.getByRole('textbox', { name: 'Текст правил', exact: true });
      await screenEditor.focus();
      const keyboardMode = platform === 'ios' ? 'visual' : 'resize';
      await setPhoneKeyboard(screenPage, { mode: keyboardMode, height: 260 });
      await screenEditor.scrollIntoViewIfNeeded();
      assert.equal(
        await panel.locator('.settings-drilldown__footer').count(),
        0,
        'The existing editor layout hides its footer while the keyboard is open',
      );
      assert.equal(
        await screenEditor.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.top < visualViewport.height + visualViewport.offsetTop &&
            rect.bottom > visualViewport.offsetTop
          );
        }),
        true,
      );
      const visibleViewport = await screenPage.evaluate(() => ({
        width: Math.floor(visualViewport.width),
        height: Math.floor(visualViewport.height),
      }));
      // The visualViewport shim does not paint an OS keyboard over the covered layout area.
      await screenPage.screenshot({
        path: path.join(screenshots, `${name}-keyboard.png`),
        clip: { x: 0, y: 0, ...visibleViewport },
      });
      await setPhoneKeyboard(screenPage, { mode: keyboardMode, open: false });
      const restoredFooter = panel.locator('.settings-drilldown__footer');
      await restoredFooter.waitFor();
      assert.equal(
        await restoredFooter.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight + 1;
        }),
        true,
        'Closing the keyboard must restore all publication actions inside the viewport',
      );
      await screenPage.screenshot({ path: path.join(screenshots, `${name}-keyboard-closed.png`) });
      assert.deepEqual(screenErrors, []);
      console.log(
        `PASS ${name}: truthful deletion, full error, toast contrast, readback, keyboard editor and restored footer`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Rules publication screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
