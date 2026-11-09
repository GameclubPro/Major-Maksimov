import assert from 'node:assert/strict';

export async function checkPublicationHistoryReview(browser, base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/publication-review-test*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-review-harness.tsx');</script></body></html>`,
    }),
  );
  let resolved = new Map();
  let holdReads = false;
  const held = [];
  const requestedPages = [];
  const reply = (route, data) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/review-api/publications/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fixture = await page.evaluate(() => window.publicationReviewFixture);
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.match(url.pathname, /\/occurrences\/old-occurrence\/resolve-ambiguous$/u);
      resolved.set(body.deliveryId, body.resolution === 'mark_sent' ? 'SENT' : 'FAILED');
    }
    const details = structuredClone(fixture.details);
    details.delivery.ambiguous = fixture.details.delivery.ambiguous - resolved.size;
    details.delivery.sent = [...resolved.values()].filter((status) => status === 'SENT').length;
    details.delivery.failed = [...resolved.values()].filter((status) => status === 'FAILED').length;
    const all = fixture.deliveries.map((delivery) => ({
      ...delivery,
      status: resolved.get(delivery.id) ?? delivery.status,
    }));
    let response = details;
    if (url.pathname.endsWith('/deliveries')) {
      requestedPages.push(Object.fromEntries(url.searchParams));
      const items = all.filter((delivery) =>
        url.searchParams.get('status')
          ? delivery.status === url.searchParams.get('status')
          : delivery.status !== url.searchParams.get('excludeStatus'),
      );
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? items.findIndex((delivery) => delivery.id === cursor) + 1 : 0;
      response = {
        items: items.slice(start, start + 1),
        nextCursor: items.length > start + 1 ? items[start].id : null,
      };
    }
    if (holdReads && request.method() === 'GET') {
      held.push({ route, response });
      return;
    }
    await reply(route, response);
  });

  try {
    for (const [width, height] of [
      [390, 844],
      [412, 915],
    ]) {
      for (const theme of ['light', 'dark']) {
        resolved = new Map();
        requestedPages.length = 0;
        await page.setViewportSize({ width, height });
        await page.goto(`${base}publication-review-test`);
        await page.evaluate((value) => (document.documentElement.dataset.maxTheme = value), theme);
        const first = page.getByRole('button', {
          name: 'Подтвердить публикацию в Старая доставка a',
          exact: true,
        });
        const second = page.getByRole('button', {
          name: 'Подтвердить публикацию в Старая доставка b',
          exact: true,
        });
        await first.waitFor();
        await second.waitFor();
        assert.equal(await page.getByText('Нужно проверить: 2', { exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: /^Повторить запуск:/ }).count(), 0);
        assert.ok(
          requestedPages.some(
            (query) => query.status === 'AMBIGUOUS' && query.cursor === 'delivery-a',
          ),
        );
        const panel = page.getByRole('dialog', { name: 'Изменённое расписание', exact: true });
        const box = await panel.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.height <= height + 1);
        assert.equal(
          await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
      }
    }

    // FLAG: Hold a pre-decision read until after the mutation and its fresh reads settle.
    holdReads = true;
    await page.evaluate(() => window.refetchPublicationReview());
    await page.waitForFunction(() =>
      window.publicationReviewCache().some((query) => query.fetchStatus === 'fetching'),
    );
    for (let i = 0; i < 100 && held.length < 2; i++) await page.waitForTimeout(20);
    assert.ok(held.length >= 2, 'Expected both stale details and delivery reads');
    holdReads = false;
    await page
      .getByRole('button', { name: 'Подтвердить публикацию в Старая доставка a', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Сообщение опубликовано?', exact: true })
      .getByRole('button', { name: 'Подтвердить', exact: true })
      .click();
    await page.getByText('Нужно проверить: 1', { exact: true }).waitFor();
    for (const { route, response } of held.splice(0)) await reply(route, response);
    await page.waitForFunction(() =>
      window.publicationReviewCache().every((query) => query.fetchStatus === 'idle'),
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Подтвердить публикацию в Старая доставка a', exact: true })
        .count(),
      0,
    );
    await page
      .getByRole('button', { name: 'Подтвердить публикацию в Старая доставка b', exact: true })
      .waitFor();
    const snapshot = await page.evaluate(() => window.publicationReviewCache());
    assert.equal(snapshot.find((query) => query.key[1] === 'details').data.delivery.ambiguous, 1);
    assert.equal(
      snapshot
        .filter((query) => query.key[1] === 'deliveries')
        .flatMap((query) => query.data?.pages?.flatMap((entry) => entry.items) ?? [])
        .some((delivery) => delivery.id === 'delivery-a' && delivery.status === 'AMBIGUOUS'),
      false,
    );

    await page
      .getByRole('button', { name: 'Отметить неотправленной для Старая доставка b', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Сообщение не отправлено?', exact: true })
      .getByRole('button', { name: 'Подтвердить', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.publicationReviewCache().find((query) => query.key[1] === 'details')?.data.delivery
          .ambiguous === 0,
    );
    assert.equal(await page.getByRole('button', { name: /^Подтвердить публикацию в / }).count(), 0);
    assert.ok(
      requestedPages.some((query) => !query.status && !query.excludeStatus && !query.cursor),
    );
    assert.equal(await page.getByRole('button', { name: /^Повторить запуск:/ }).count(), 0);

    resolved = new Map();
    await page.goto(`${base}publication-review-test?stale-count=1`);
    await page
      .getByRole('button', { name: 'Подтвердить публикацию в Старая доставка a', exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'PASS: all-history uncertainty survives new schedules, pagination and stale counts; manual decisions cancel old reads without restoring resolved rows',
    );
  } finally {
    await context.close();
  }
}
