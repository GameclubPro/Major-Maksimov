import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { checkPublicationHistoryReview } from './publication-review.browser-helpers.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/publication-actions-test*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-actions-harness.tsx');</script></body></html>`,
    }),
  );
  const pending = [],
    all = [];
  await page.route('**/api/publications/**', (route) => {
    pending.push(route);
    all.push(route.request().postDataJSON());
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const next = async () => {
    for (let i = 0; i < 100; i++) {
      if (pending.length) return pending.shift();
      await page.waitForTimeout(20);
    }
    throw Error('Missing action request');
  };
  const settle = async (route, status = 200) => {
    await page.waitForFunction(
      () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy,
    );
    const data =
      status === 200
        ? (await read()).response
        : {
            message: 'Ошибка отправки',
            ...(status === 409 ? { code: 'PUBLICATION_REVISION_CONFLICT' } : {}),
          };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    await page.waitForFunction(
      () => !JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy,
    );
  };
  const open = (name) => page.getByRole('button', { name, exact: true }).click();
  const confirm = () =>
    page.getByRole('dialog').getByRole('button', { name: 'Отменить', exact: true }).click();
  await page.goto(`${base}publication-actions-test`);
  await open('Отмена публикации');
  await confirm();
  const first = await next();
  const identity = first.request().postDataJSON();
  assert.equal(identity.expectedRevision, 4);
  assert.ok(identity.requestId);
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Сохраняем...', exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(all.length, 1);
  await first.abort('failed');
  await page.waitForFunction(
    () => !JSON.parse(document.querySelector('[data-testid="state"]').textContent).busy,
  );
  assert.equal((await read()).action, 'cancel');
  await confirm();
  const repeat = await next();
  assert.deepEqual(repeat.request().postDataJSON(), identity);
  await settle(repeat);
  assert.equal((await read()).action, null);
  assert.equal((await read()).details, null);
  assert.ok((await read()).invalidated.includes('list'));
  assert.ok((await read()).invalidated.includes('calendar'));
  await open('Отмена публикации');
  await confirm();
  const newAction = await next();
  assert.notEqual(newAction.request().postDataJSON().requestId, identity.requestId);
  await settle(newAction, 409);
  assert.equal((await read()).action, null);
  assert.ok((await read()).invalidated.includes('details'));
  console.log(
    'PASS: action identity survives failed response, pending confirmation is disabled, success clears the slot, conflict refreshes data',
  );

  for (const [trigger, label, path] of [
    ['Пауза расписания', 'Пауза', 'pause'],
    ['Возобновление расписания', 'Запустить', 'resume'],
  ]) {
    await open(trigger);
    await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    const r = await next();
    assert.ok(r.request().url().endsWith(`/${path}`));
    assert.equal(r.request().postDataJSON().expectedRevision, 4);
    await settle(r);
  }
  await open('Повтор устаревшего');
  assert.equal(pending.length, 0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /С последними правками/ })
    .click();
  const latest = await next();
  const latestBody = latest.request().postDataJSON();
  assert.equal(latestBody.contentMode, 'latest');
  assert.equal(latestBody.expectedPublicationVersion, 4);
  assert.equal(latestBody.expectedContentRevision, 3);
  await settle(latest, 500);
  assert.equal((await read()).retry, true);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /С последними правками/ })
    .click();
  const retry = await next();
  assert.deepEqual(retry.request().postDataJSON(), latestBody);
  await settle(retry);
  assert.equal((await read()).retry, false);
  assert.ok((await read()).invalidated.includes('deliveries'));
  await open('Повтор актуального');
  const original = await next();
  assert.equal(original.request().postDataJSON().contentMode, 'original');
  assert.equal('expectedContentRevision' in original.request().postDataJSON(), false);
  await settle(original);
  console.log(
    'PASS: retry chooses the right content revision, retains its identity on error and invalidates deliveries after success',
  );

  await open('Решить неопределённость');
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  const ambiguous = await next();
  const ambiguousBody = ambiguous.request().postDataJSON();
  assert.equal(ambiguousBody.deliveryId, 'delivery-a');
  assert.equal(ambiguousBody.resolution, 'mark_sent');
  await settle(ambiguous, 500);
  assert.equal((await read()).ambiguous, true);
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  const resolve = await next();
  assert.deepEqual(resolve.request().postDataJSON(), ambiguousBody);
  await settle(resolve);
  for (const [width, height] of [
    [390, 844],
    [412, 915],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.goto(`${base}publication-actions-test?partial=1`);
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-max-theme', value),
        theme,
      );
      await open('Действия: Пост прежнего администратора');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Отменить отправки', exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      assert.match(await dialog.innerText(), /Отменить отправки в ваших чатах и каналах/);
      assert.match(await dialog.innerText(), /остальных чатах и каналах продолжатся/);
      await dialog.evaluate((element) =>
        Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        ),
      );
      const rect = await dialog.boundingBox();
      assert.ok(
        rect &&
          rect.x >= 0 &&
          rect.x + rect.width <= width + 1 &&
          rect.y >= 0 &&
          rect.y + rect.height <= height + 1,
        JSON.stringify({ width, height, rect }),
      );
      if (process.env.PUBLICATION_ACTION_SCREENSHOTS) {
        await mkdir(process.env.PUBLICATION_ACTION_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: `${process.env.PUBLICATION_ACTION_SCREENSHOTS}/cancel-${width}-${theme}.png`,
        });
      }
      await confirm();
      const scoped = await next();
      assert.ok(scoped.request().url().endsWith('/cancel'));
      await settle(scoped);
    }
  }
  console.log(
    'PASS: partial administrators can cancel from the post menu with the exact scope visible on mobile in both themes',
  );
  assert.equal((await read()).ambiguous, false);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: ambiguous resolution requires confirmation and preserves its independent identity until success',
  );
  await checkPublicationHistoryReview(browser, base);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
