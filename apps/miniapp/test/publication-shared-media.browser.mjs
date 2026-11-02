import assert from 'node:assert/strict';
import { chromium } from 'playwright';
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
  for (const kind of ['image', 'video']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/publication-shared-media-test*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-shared-media-harness.tsx');</script></body></html>`,
        }),
      );
      const saves = [];
      const tests = [];
      const allSaves = [];
      const previews = [];
      let details;
      let sourceRevoked = false;
      const reply = (route, data, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      await page.route('**/api/publications/**', (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/publications/drafts') && request.method() === 'POST') {
          saves.push(route);
          allSaves.push(request.postData());
          return;
        }
        if (path.endsWith('/publications/test')) {
          tests.push(route);
          return;
        }
        if (path.includes('/assets/')) {
          const sourceId = path.split('/')[3];
          previews.push({ sourceId, afterRevocation: sourceRevoked });
          if (sourceRevoked && sourceId === details.id)
            return reply(route, { message: 'Доступ отозван' }, 403);
          return route.fulfill({
            contentType: kind === 'video' ? 'video/mp4' : 'image/png',
            body: Buffer.from('shared-preview'),
          });
        }
        if (request.method() === 'GET' && path === `/api/publications/shared-source-${kind}`)
          return reply(route, details);
        return reply(route, { message: `Unexpected request: ${request.method()} ${path}` }, 500);
      });
      const read = async () => JSON.parse(await page.getByTestId('state').innerText());
      const click = (name) => page.getByRole('button', { name, exact: true }).click();
      const next = async (queue, label) => {
        for (let i = 0; i < 150; i++) {
          if (queue.length) return queue.shift();
          await page.waitForTimeout(20);
        }
        throw new Error(`Missing ${label} request for ${kind}`);
      };
      const expectReference = (body, sourceId) => {
        assert.deepEqual(body.content.media, [
          {
            type: `${kind}-ref`,
            assetId: `shared-${kind}`,
            sourcePublicationId: sourceId,
          },
        ]);
      };
      await page.goto(`${base}publication-shared-media-test?kind=${kind}`);
      await page.getByTestId('state').waitFor();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).hydrated,
      );
      details = (await read()).response;
      await click('Создать копию');
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="state"]').textContent).context?.kind ===
          'duplicate',
      );
      assert.equal((await read()).cloud, null);
      assert.equal((await read()).retainedAssets[0].sourcePublicationId, details.id);
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="previews"]').textContent).length === 1,
      );
      assert.equal(previews.at(-1).sourceId, details.id);

      await click('Сохранить черновик');
      const initialSave = await next(saves, 'draft save');
      const frozenBody = initialSave.request().postData();
      expectReference(initialSave.request().postDataJSON(), details.id);
      assert.equal(initialSave.request().postDataJSON().expectedRevision, undefined);
      await click('Отправить тест');
      const beforeAck = await next(tests, 'private test before acknowledgement');
      expectReference(beforeAck.request().postDataJSON(), details.id);
      assert.deepEqual(beforeAck.request().postDataJSON().sourceTarget, {
        chatId: 'shared-chat',
        entityType: 'chat',
      });
      await reply(beforeAck, {});
      await page.waitForFunction(
        () => !JSON.parse(document.querySelector('[data-testid="state"]').textContent).testing,
      );
      assert.equal((await read()).cloud, null);
      await reply(initialSave, { message: 'Сохранение временно недоступно' }, 500);
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="state"]').textContent).saveStatus ===
          'error',
      );
      assert.equal((await read()).retainedAssets[0].sourcePublicationId, details.id);

      await click('Сохранить черновик');
      const retry = await next(saves, 'exact draft retry');
      assert.equal(retry.request().postData(), frozenBody);
      const draftId = `saved-copy-${kind}`;
      const response = {
        publication: {
          ...details,
          id: draftId,
          lifecycle: 'DRAFT',
          version: 1,
          access: { canManageAllTargets: true },
          targetCount: 1,
          targetOverflowCount: 0,
          content: { ...details.content, revision: 1 },
        },
        state: retry.request().postDataJSON().state,
      };
      await reply(retry, response);
      await page.waitForFunction((id) => {
        const state = JSON.parse(document.querySelector('[data-testid="state"]').textContent);
        return (
          state.cloud?.id === id &&
          state.saveStatus === 'saved' &&
          state.retainedAssets[0]?.sourcePublicationId === id
        );
      }, draftId);
      assert.equal(allSaves.length, 2);

      sourceRevoked = true;
      await click('Обновить предпросмотр');
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="previews"]').textContent).length === 1,
      );
      assert.equal(previews.at(-1).sourceId, draftId);
      await click('Отправить тест');
      const afterAck = await next(tests, 'private test from saved copy');
      expectReference(afterAck.request().postDataJSON(), draftId);
      await reply(afterAck, {});
      await page.waitForFunction(
        () => !JSON.parse(document.querySelector('[data-testid="state"]').textContent).testing,
      );
      assert.equal((await read()).actionError, '');
      assert.ok(previews.filter((entry) => entry.afterRevocation).length > 0);
      assert.ok(
        previews
          .filter((entry) => entry.afterRevocation)
          .every((entry) => entry.sourceId === draftId),
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS: shared ${kind} duplicate retains source before ACK, retries exact save, and rebases previews/test after ACK`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
