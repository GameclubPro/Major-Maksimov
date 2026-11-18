import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('Local preview required');
const browser = await chromium.launch(captureBrowserLaunchOptions('chromium', base.href));
const page = await browser.newPage();
try {
  await page.goto(new URL('?preview=1&networks=1', base).href);
  await page.locator('.chat-card').first().waitFor();
  const report = await page.evaluate(async () => {
    const resource = (filename) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${filename}`))?.name;
    const transportUrl = resource('preview-transport.ts');
    const react = await import(resource('react.js'));
    const dom = await import(resource('react-dom_client.js'));
    const { createElement: h } = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    const { QueryClient, QueryClientProvider } = await import(resource('@tanstack_react-query.js'));
    const { createPreviewApiTransport, PREVIEW_REQUEST_HANDLERS } = await import(transportUrl);
    const { PREVIEW_NOT_HANDLED } = await import(
      new URL('preview-transport-runtime.ts', transportUrl).href
    );
    const { getPreviewNetworkEntities } = await import(
      new URL('preview-transport-network-state.ts', transportUrl).href
    );
    const { useNetworkStatistics } = await import(
      new URL('../../features/networks/network-statistics.ts', transportUrl).href
    );
    const { readCompleteNetworkSettings } = await import(
      new URL('../../features/network-settings/network-settings-controller.ts', transportUrl).href
    );
    const { ApiRequestError } = await import(new URL('../api-request-error.ts', transportUrl).href);
    const sized = new WeakSet();
    let size = 1;
    const handler = (context) => {
      if (!sized.has(context.state)) {
        sized.add(context.state);
        getPreviewNetworkEntities(context.state, 'chat').forEach((item, index) => {
          item.favoriteTypes = index < size ? ['important'] : [];
        });
      }
      return PREVIEW_NOT_HANDLED;
    };
    PREVIEW_REQUEST_HANDLERS.unshift(handler);
    const wait = async (predicate) => {
      const deadline = performance.now() + 30_000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Timed out waiting for hook state');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const results = [];
    try {
      for (size of [1, 8, 50, 501]) {
        const source = createPreviewApiTransport({ search: '?networks=1&networksScenario=large' });
        const calls = [];
        let deny = false;
        const api = {
          request: async (path, init) => {
            calls.push(path);
            if (deny && path.includes('/stats'))
              throw new ApiRequestError(403, '{}', 'Access revoked');
            const response = await source.request(path, init);
            return path.includes('/stats') ? { ...response, retryAfterMs: 250 } : response;
          },
          requestKeepalive: () => undefined,
        };
        const catalogue = await api.request('/managed-entities/networks/chat');
        const card = catalogue.items.find((item) => item.favoriteType === 'important');
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        let latest;
        let firstAt;
        let actor = 'fixture-actor';
        const options = {
          api,
          scopeKey: actor,
          entityType: 'chat',
          favoriteType: 'important',
          range: '7d',
          compositionVersion: card.compositionVersion,
          enabled: true,
        };
        function Probe() {
          latest = useNetworkStatistics({ ...options, scopeKey: actor });
          if (latest.data && firstAt === undefined) firstAt = performance.now();
          return h('span', null, latest.phase);
        }
        const render = (visible = true) =>
          root.render(
            h(
              QueryClientProvider,
              { client },
              visible ? [h(Probe, { key: 'first' }), h(Probe, { key: 'second' })] : null,
            ),
          );
        const started = performance.now();
        render();
        await wait(() => latest?.phase === 'settled');
        const readyMs = performance.now() - started;
        const statsRequests = calls.filter((path) => path.includes('/stats')).length;
        if (latest.data.items.length !== size) throw new Error('Incomplete statistics');
        render(false);
        await wait(() => !host.textContent);
        render();
        await wait(() => host.textContent === 'settledsettled');
        await new Promise((resolve) => setTimeout(resolve, 60));
        const cachedRequests =
          calls.filter((path) => path.includes('/stats')).length - statsRequests;
        const readAt = calls.length;
        const readStart = performance.now();
        const settings = await readCompleteNetworkSettings(api, {
          entityType: 'chat',
          section: 'links',
          target: { mode: 'category', favoriteType: 'important' },
        });
        if (settings.recipientCount !== size) throw new Error('Settings scope was truncated');
        results.push({
          size,
          firstMs: Math.round(firstAt - started),
          readyMs: Math.round(readyMs),
          statsRequests,
          cachedRequests,
          settingsPages: calls
            .slice(readAt)
            .filter((path) =>
              new URL(path, window.location.origin).pathname.endsWith('/networks/settings/read'),
            ).length,
          settingsMs: Math.round(performance.now() - readStart),
        });
        if (size === 501) {
          actor = 'another-actor';
          render();
          await wait(() => latest?.phase === 'checking');
          if (latest.data.items.length >= 501)
            throw new Error('A different actor inherited cached data');
          options.enabled = false;
          render();
          await wait(() => latest?.phase === 'idle');
          const stoppedAt = calls.length;
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (calls.length !== stoppedAt) throw new Error('Invisible statistics session continued');
          actor = 'fixture-actor';
          options.enabled = true;
          render();
          await wait(() => latest?.phase === 'settled');
        }
        // A cached display must disappear after a fresh denial, including after remount.
        deny = true;
        latest.refresh();
        await wait(() => latest.phase === 'error');
        if (latest.data !== null || latest.error.retryable)
          throw new Error('Denied cache remained visible');
        render(false);
        await wait(() => !host.textContent);
        render();
        await wait(() => host.textContent === 'errorerror');
        if (latest.data !== null) throw new Error('Denied data restored after remount');
        root.unmount();
        client.clear();
        host.remove();

        if (size === 501) {
          deny = false;
          const abort = new AbortController();
          const before = calls.length;
          let cancelled = false;
          try {
            await readCompleteNetworkSettings(
              api,
              {
                entityType: 'chat',
                section: 'links',
                target: { mode: 'category', favoriteType: 'important' },
              },
              () => abort.abort(),
              abort.signal,
            );
          } catch {
            cancelled = abort.signal.aborted;
          }
          if (!cancelled || calls.length - before !== 1)
            throw new Error('Cancelled settings continued loading');
        }
      }
    } finally {
      PREVIEW_REQUEST_HANDLERS.splice(PREVIEW_REQUEST_HANDLERS.indexOf(handler), 1);
    }
    return results;
  });
  for (const row of report) {
    assert.equal(row.cachedRequests, 0, 'complete remount reuses its exact display snapshot');
    assert.equal(
      row.statsRequests,
      Math.ceil(row.size / 20),
      'concurrent observers share one request chain',
    );
    assert.equal(
      row.settingsPages,
      Math.ceil(row.size / 16),
      'full settings coverage through adaptive pages',
    );
  }
  console.log(
    JSON.stringify(
      {
        environment:
          'local Chromium preview; statistics fixture pages contain 20 entities, no production latency claim',
        report,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
