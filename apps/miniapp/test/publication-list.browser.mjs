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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/publication-list-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-list-harness.tsx');</script></body></html>`,
    }),
  );
  const requests = [];
  const calendar = [];
  await page.route('**/api/publications?*', (route) => {
    requests.push(route);
  });
  await page.route('**/api/publications/calendar-availability', (route) => {
    calendar.push(route);
    const body = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ from: body.from, to: body.to, slots: [] }),
    });
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const waitState = async (expected) =>
    page.waitForFunction(
      (expected) => {
        const output = document.querySelector('[data-testid="state"]');
        if (!output || window.readPublicationListHarness().pendingNotifications !== 0) return false;
        const state = JSON.parse(output.textContent);
        return Object.entries(expected).every(([key, value]) => state[key] === value);
      },
      expected,
      { timeout: 5_000 },
    );
  const waitRequest = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const r = requests.find((route) => predicate(new URL(route.request().url()).searchParams));
      if (r) return r;
      await page.waitForTimeout(20);
    }
    throw Error('Expected list request missing');
  };
  const reply = async (route, marker, expected) => {
    const response = page.waitForResponse(route.request().url());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: marker }),
    });
    await (await response).finished();
    if (expected) await waitState(expected);
  };
  await page.goto(`${base}publication-list-test`);
  const first = await waitRequest((p) => p.get('view') === 'current');
  assert.equal(new URL(first.request().url()).searchParams.get('limit'), '30');
  await reply(first, 'initial-next', { pages: 1, marker: 'initial-next' });
  await page.getByRole('button', { name: 'Ещё', exact: true }).click();
  const next = await waitRequest((p) => p.get('cursor') === 'initial-next');
  await reply(next, null, { pages: 2, marker: null });
  assert.equal((await read()).pages, 2);
  assert.equal(requests.length, 2);
  console.log('PASS: pagination uses the server cursor and waits for explicit load-more');

  await page.getByLabel('Поиск').fill('alpha');
  const old = await waitRequest((p) => p.get('query') === 'alpha');
  await page.getByLabel('Поиск').fill('beta');
  await page.getByRole('button', { name: 'Каналы', exact: true }).click();
  const current = await waitRequest(
    (p) => p.get('query') === 'beta' && p.get('entityType') === 'channel',
  );
  assert.equal(new URL(current.request().url()).searchParams.has('cursor'), false);
  await reply(current, 'beta-next', {
    query: 'beta',
    entity: 'channel',
    pages: 1,
    marker: 'beta-next',
  });
  await reply(old, 'alpha-next');
  // FLAG: Prove the stale response settled before checking that it did not replace beta.
  // Waiting only for beta could pass while the old response was still being consumed.
  await page.waitForFunction(
    () => {
      const snapshot = window.readPublicationListHarness();
      return (
        snapshot.pendingNotifications === 0 &&
        snapshot.queries.some(
          (query) =>
            query.key[0] === 'publications' &&
            query.key[1] === 'list' &&
            query.key[2] === 'current' &&
            query.key[3] === 'alpha' &&
            query.key[4] === 'all' &&
            query.status === 'success' &&
            query.fetchStatus === 'idle' &&
            query.marker === 'alpha-next',
        )
      );
    },
    undefined,
    { timeout: 5_000 },
  );
  assert.equal((await read()).marker, 'beta-next');
  assert.equal((await read()).pages, 1);
  assert.equal(new URL(page.url()).searchParams.get('query'), 'beta');
  assert.equal(new URL(page.url()).searchParams.get('entity'), 'channel');
  console.log('PASS: new filters reset cursor scope and reject late old-query results');

  await page.getByRole('button', { name: 'Редактор', exact: true }).click();
  await waitState({ editor: true });
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).calendar,
    undefined,
    { timeout: 5_000 },
  );
  assert.equal(calendar.length, 1);
  const body = calendar[0].request().postDataJSON();
  assert.deepEqual(body.audience, {
    selection: 'SELECTED',
    mode: 'SNAPSHOT',
    targets: [{ chatId: 'target-a', entityType: 'channel' }],
  });
  assert.equal(body.excludePublicationId, 'publication-a');
  assert.ok(Date.parse(body.to) > Date.parse(body.from));
  const before = requests.length;
  await page.getByLabel('Поиск').fill('editor-query');
  await waitState({ editor: true, query: 'editor-query' });
  // Keep the no-request observation beyond the hook's 250 ms search debounce.
  await page.waitForTimeout(400);
  assert.equal(requests.length, before);
  await page.getByRole('button', { name: 'Редактор', exact: true }).click();
  const after = await waitRequest((p) => p.get('query') === 'editor-query');
  await reply(after, null, {
    view: 'current',
    query: 'editor-query',
    entity: 'channel',
    editor: false,
    pages: 1,
    marker: null,
  });
  await page.getByRole('button', { name: 'История', exact: true }).click();
  const history = await waitRequest(
    (p) => p.get('view') === 'history' && p.get('query') === 'editor-query',
  );
  assert.equal(new URL(history.request().url()).searchParams.get('entityType'), 'channel');
  await reply(history, null, { view: 'history', pages: 1, marker: null });
  assert.equal((await read()).view, 'history');
  assert.equal(calendar.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: editor suspends the feed, calendar retains target/exclusion scope and filters survive return',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
