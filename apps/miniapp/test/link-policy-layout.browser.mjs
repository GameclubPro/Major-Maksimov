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
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const output = mkdtempSync(join(tmpdir(), 'maxim-link-policy-layout-'));

async function checkNetworkPendingRule(page, base) {
  await page.goto(
    `${base}networks?preview=1&networks=1&type=chat&category=important&tab=communities`,
  );
  await page.locator('[data-network-entity-id]').first().waitFor();
  await page.evaluate(async () => {
    const source = performance
      .getEntriesByType('resource')
      .findLast((entry) => new URL(entry.name).pathname.endsWith('/preview-transport.ts'))?.name;
    const { PREVIEW_REQUEST_HANDLERS } = await import(source);
    const { PREVIEW_NOT_HANDLED } = await import('/app/src/lib/api/preview-transport-runtime.ts');
    const { handleNetworkSettingsPreviewRequest } =
      await import('/app/src/lib/api/preview-transport-network-settings.ts');
    window.__pendingRuleRequests = [];
    PREVIEW_REQUEST_HANDLERS.unshift(async (context) => {
      const { url, method, init } = context;
      const body = init.body ? JSON.parse(init.body) : null;
      window.__pendingRuleRequests.push({ path: url.pathname, method, body });
      if (method === 'POST' && url.pathname.endsWith('/networks/settings/read')) {
        const response = await handleNetworkSettingsPreviewRequest(context);
        return {
          ...response,
          fields: {
            ...response.fields,
            ...(body.section === 'links'
              ? {
                  linkRulesPolicy: {
                    kind: 'common',
                    value: { version: 1, mode: 'DENY_SELECTED', rules: [] },
                  },
                }
              : {}),
            ...(body.section === 'reports'
              ? { reportsEnabled: { kind: 'common', value: true } }
              : {}),
          },
        };
      }
      return PREVIEW_NOT_HANDLED;
    });
  });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const hub = page.locator('[data-network-settings-overview]');
  await hub.waitFor();
  await hub.getByRole('button', { name: 'Ссылки', exact: true }).click();
  const panel = page.locator('.network-settings-editor');
  const policy = panel.getByRole('radiogroup', { name: 'Режим модерации ссылок', exact: true });
  await policy.getByRole('radio', { name: 'Запрещать по списку', exact: true }).waitFor();
  const prepare = panel.getByRole('button', { name: 'Проверить изменения', exact: true });
  await panel.getByRole('button', { name: 'Добавить', exact: true }).click();
  const input = panel.getByRole('textbox', { name: 'Ссылка или сайт', exact: true });
  await input.fill('https://example.com/network-pending');
  assert.equal(await prepare.isDisabled(), true, 'network footer blocks pending rule');
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
  const discard = page.getByRole('dialog', { name: 'Отменить изменения правила?', exact: true });
  await discard.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
  assert.equal(await input.inputValue(), 'https://example.com/network-pending');
  assert.equal(
    await page.evaluate(
      () =>
        window.__pendingRuleRequests.filter(
          (request) => request.path.endsWith('/preview') || request.path.endsWith('/apply'),
        ).length,
    ),
    0,
    'pending editor cannot prepare or apply',
  );
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
  await discard.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  assert.equal(await input.count(), 0);
  assert.equal(
    await prepare.isDisabled(),
    true,
    'discard clears pending error and does not create a change',
  );
  await policy.getByRole('radio', { name: 'Разрешать все', exact: true }).click();
  assert.equal(await prepare.isEnabled(), true, 'real change can prepare after explicit discard');
  await prepare.click();
  await page.getByRole('button', { name: /^Применить ·/u }).waitFor();
  const preview = await page.evaluate(() =>
    window.__pendingRuleRequests.find((request) => request.path.endsWith('/preview')),
  );
  assert.deepEqual(
    preview.body.changes,
    [{ path: 'linkRulesPolicy', op: 'set', value: { version: 1, mode: 'ALLOW_ALL', rules: [] } }],
    'discarded rule never appears in prepared request',
  );
  await panel.getByRole('button', { name: 'Изменить', exact: true }).click();
  await policy.getByRole('radio', { name: 'Запрещать по списку', exact: true }).click();
  await panel.getByRole('button', { name: 'Добавить', exact: true }).click();
  await input.fill('https://example.com/old-scope');
  await page.evaluate(async () => {
    const { createNetworkSettingsScope } =
      await import('/app/src/lib/network-settings-workspace-state.ts');
    const scopeId = new URL(location.href).searchParams.get('scope');
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith('maxim.network.settings.scope.v1:') && key.endsWith(':' + scopeId),
    );
    const stored = JSON.parse(localStorage.getItem(key));
    const scope = createNetworkSettingsScope({
      userId: stored.userId,
      scope: stored.scope,
      title: stored.title,
      returnTo: stored.returnTo,
    });
    const url = new URL(location.href);
    url.searchParams.set('scope', scope.scopeId);
    url.pathname = url.pathname.replace(/\/settings\/[^/]+\/?$/u, '/settings');
    history.pushState(null, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await hub.waitFor();
  await hub.getByRole('button', { name: 'Ссылки', exact: true }).click();
  await policy.waitFor();
  assert.equal(await input.count(), 0, 'scope change resets editor and marker');
  await policy.getByRole('radio', { name: 'Удалять все', exact: true }).click();
  assert.equal(await prepare.isEnabled(), true, 'new scope has no pending-rule error');
  await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
  const leave = page.getByRole('dialog', { name: 'Выйти без сохранения?', exact: true });
  await leave.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
  await hub.waitFor();
  await hub.getByRole('button', { name: 'Система жалоб', exact: true }).click();
  await panel.locator('.reports-toggle--activation small').waitFor();
  assert.equal(
    await panel.locator('.reports-toggle--activation small').innerText(),
    'Включены',
    'network reports copy reflects shared scope',
  );
}

async function checkLabels(group, label) {
  const problems = await group.evaluate((element) => {
    const issues = [];
    const buttons = [...element.querySelectorAll('[role="radio"]')];
    if (buttons.length !== 4) issues.push('Expected all four link policies');
    for (const [index, button] of buttons.entries()) {
      const box = button.getBoundingClientRect();
      if (box.width < 44 || box.height < 44) issues.push('Policy target smaller than 44px');
      if (box.left < -1 || box.right > innerWidth + 1) issues.push('Policy outside viewport');
      for (const other of buttons.slice(index + 1)) {
        const bounds = other.getBoundingClientRect();
        if (
          Math.min(box.right, bounds.right) - Math.max(box.left, bounds.left) > 1 &&
          Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top) > 1
        )
          issues.push('Policy targets overlap');
      }
      const node = [...button.querySelectorAll('span')].find((span) =>
        span.textContent.trim(),
      )?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) {
        issues.push('Policy label missing');
        continue;
      }
      for (const match of node.textContent.matchAll(/\S+/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1)
          issues.push(`Word split across lines: ${match[0]}`);
        if (rects.some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1))
          issues.push(`Policy label clipped: ${match[0]}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Page overflow');
    return issues;
  });
  assert.deepEqual(problems, [], `${label}: ${JSON.stringify(problems)}`);
}

try {
  for (const [engine, browserType] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await browserType.launch(captureBrowserLaunchOptions(engine, base));
    try {
      for (const width of [280, 320, 393]) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: 740 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          try {
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            await installMaxBridgeShimInitScript(
              context,
              {},
              { colorScheme: theme, platform: 'ios' },
            );
            await installNativeVisualModeInitScript(context);
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`${base}chat/preview-chat/settings?preview=1&focus=links`);
            const group = page.getByRole('radiogroup', { name: 'Режим модерации ссылок' });
            await group.waitFor();
            await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
            for (const fontSize of [16, 20]) {
              await page.evaluate(async (size) => {
                document.documentElement.style.fontSize = `${size}px`;
                await document.fonts.ready;
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
              }, fontSize);
              await checkLabels(group, `${engine} ${width}px ${theme} ${fontSize}px text`);
              if (fontSize === 16 && width === 393) {
                const rows = await group
                  .getByRole('radio')
                  .evaluateAll((nodes) =>
                    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
                  );
                assert.equal(
                  new Set(rows).size,
                  2,
                  'Ordinary smartphone uses the approved two-column panel',
                );
              }
            }
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '16px';
            });
            for (const name of [
              'Разрешать все',
              'Удалять все',
              'Разрешать по списку',
              'Запрещать по списку',
            ]) {
              const option = group.getByRole('radio', { name, exact: true });
              await option.click();
              assert.equal(await option.getAttribute('aria-checked'), 'true');
            }
            await page.getByRole('button', { name: 'Добавить', exact: true }).click();
            const editor = page.getByRole('region', { name: 'Добавление правила' });
            const select = editor.getByRole('combobox', { name: 'Область правила' });
            await select.scrollIntoViewIfNeeded();
            assert.equal(
              await select.evaluate((node) => getComputedStyle(node).appearance),
              'none',
            );
            const values = await select
              .locator('option')
              .evaluateAll((nodes) => nodes.map((node) => node.value));
            for (const value of values) {
              await select.selectOption(value);
              assert.equal(await select.inputValue(), value);
            }
            await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
            if (width === 320) {
              await page.getByRole('button', { name: 'Добавить', exact: true }).click();
              const pending = page.getByRole('textbox', { name: 'Ссылка или сайт', exact: true });
              await pending.fill('https://example.com/pending-rule');
              const pendingEditor = page.getByRole('region', { name: 'Добавление правила' });
              await pendingEditor.locator('.links-panel__expiry > summary').click();
              await pendingEditor.getByRole('button', { name: /^Время окончания:/u }).click();
              const timePicker = page.getByRole('dialog', { name: 'Время окончания', exact: true });
              await timePicker.waitFor();
              await timePicker.press('Escape');
              await timePicker.waitFor({ state: 'hidden' });
              assert.equal(
                await page.getByRole('dialog', { name: 'Отменить изменения правила?' }).count(),
                0,
                'Escape closes only the child time picker',
              );
              assert.equal(await pending.inputValue(), 'https://example.com/pending-rule');
              await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
              assert.equal(await pending.count(), 1, 'Outer Save must retain the pending rule');
              assert.equal(await pending.inputValue(), 'https://example.com/pending-rule');
              assert.equal(await pending.getAttribute('aria-invalid'), 'false');
              await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              const discard = page.getByRole('dialog', { name: 'Отменить изменения правила?' });
              await discard.waitFor();
              await discard.getByRole('button', { name: 'Продолжить редактирование' }).click();
              assert.equal(await pending.inputValue(), 'https://example.com/pending-rule');
              await page
                .getByRole('region', { name: 'Добавление правила' })
                .getByRole('button', { name: 'Добавить', exact: true })
                .click();
              await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await group.waitFor({ state: 'hidden' });
              await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
              await page
                .getByRole('button', {
                  name: 'Изменить правило https://example.com/pending-rule',
                  exact: true,
                })
                .waitFor();
              await page.getByRole('button', { name: 'Добавить', exact: true }).click();
              await pending.fill('https://example.com/discard-rule');
              await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              await discard
                .getByRole('button', { name: 'Отменить изменения', exact: true })
                .click();
              await page.getByRole('button', { name: 'Добавить', exact: true }).click();
              assert.equal(await pending.inputValue(), '', 'Only explicit discard clears input');
              await page
                .getByRole('region', { name: 'Добавление правила' })
                .getByRole('button', { name: 'Отмена', exact: true })
                .click();
            }
            assert.equal(
              await page.locator('.links-panel').getByText('МАЙОР', { exact: true }).count(),
              0,
            );
            await group.scrollIntoViewIfNeeded();
            await page.screenshot({
              path: join(output, `${engine}-${width}-${theme}.png`),
              animations: 'disabled',
            });
            if (width === 320) await checkNetworkPendingRule(page, base);
            assert.deepEqual(errors, []);
            console.log(
              `PASS ${engine} ${width}px ${theme}: four modes, two-column panel, large text, themed rule scope`,
            );
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Link policy screenshots: ${output}`);
} finally {
  await stopChildProcess(server);
}
