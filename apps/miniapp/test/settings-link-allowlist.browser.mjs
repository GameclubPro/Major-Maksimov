import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { evaluateLinkRulesPolicy } from '@maxim/contracts/settings';
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

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-links-panel-'));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-se-dark', devices['iPhone SE'], 'dark', 'ios'],
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
      await context.route('**/links-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/app/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type;
        window.__vite_plugin_react_preamble_installed__=true;
        await import('/app/test/fixtures/settings-links-harness.tsx');
      </script></body></html>`,
        }),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const dismissToasts = async () => {
        const close = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
        while (await close.count()) await close.first().click();
      };
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let seed;
      let saved;
      let failNext = false;
      let failNextSite = false;
      const writes = [];
      const siteWrites = [];
      await context.route('**/api/chats/chat-a/**', async (route) => {
        const request = route.request();
        const tail = new URL(request.url()).pathname.split('/').slice(4).join('/');
        seed ??= await page.evaluate(() => window.__LINKS_SCREEN__);
        saved ??= structuredClone(seed.settings);
        if (tail === 'settings-screen')
          return route.fulfill({ json: { ...seed, settings: saved } });
        if (tail === 'stop-words/status')
          return route.fulfill({
            json: { revision: saved.stopWordsRevision, imageScanStatus: 'shadow' },
          });
        if (tail === 'stop-words' && request.method() === 'GET')
          return route.fulfill({
            json: {
              policy: saved.stopWordsPolicy,
              revision: saved.stopWordsRevision,
              settingsRevision: saved.settingsRevision,
              storageStatus: 'valid',
              imageScanStatus: 'shadow',
            },
          });
        if (tail === 'links/preview') {
          const body = request.postDataJSON();
          const targets = (body.text.match(/https?:\/\/[^\s]+/gu) ?? []).map((target) => ({
            kind: 'external_url',
            target,
          }));
          const result = evaluateLinkRulesPolicy(body.policy, targets);
          return route.fulfill({
            json: {
              allowed: result.allowed,
              reason: result.reason,
              targetsCount: targets.length,
              ...(!result.allowed
                ? {
                    target: result.target.target,
                    ...(result.matchedRule ? { ruleId: result.matchedRule.id } : {}),
                  }
                : {}),
            },
          });
        }
        if (tail === 'stop-words' && request.method() === 'PUT') {
          const body = request.postDataJSON();
          siteWrites.push(body);
          if (failNextSite) {
            failNextSite = false;
            return route.fulfill({
              status: 400,
              json: {
                issues: [{ path: ['policy', 'domains', 1], message: 'Проверьте сайт' }],
              },
            });
          }
          assert.equal(body.expectedRevision, saved.stopWordsRevision);
          saved = {
            ...saved,
            stopWordsPolicy: body.policy,
            stopWordsRevision: saved.stopWordsRevision + 1,
            settingsRevision: new Date(Date.parse(saved.settingsRevision) + 1).toISOString(),
          };
          return route.fulfill({
            json: {
              policy: saved.stopWordsPolicy,
              revision: saved.stopWordsRevision,
              settingsRevision: saved.settingsRevision,
              storageStatus: 'valid',
              imageScanStatus: 'shadow',
            },
          });
        }
        if ((tail === 'settings' && request.method() === 'PUT') || tail === 'settings/section') {
          const body = request.postDataJSON();
          writes.push(body);
          if (failNext) {
            failNext = false;
            return route.fulfill({ status: 503, json: { message: 'Не удалось сохранить' } });
          }
          assert.equal(body.expectedRevision ?? body.settingsRevision, saved.settingsRevision);
          const changes = body.changes ?? body;
          const policy = changes.linkRulesPolicy;
          assert.ok(policy);
          saved = {
            ...saved,
            ...changes,
            linkPolicy:
              policy.mode === 'ALLOW_ALL'
                ? 'ALERT_ONLY'
                : policy.mode === 'DENY_ALL'
                  ? 'BLOCKLIST_ONLY'
                  : 'ALLOWLIST_ONLY',
            linkRulesStorageStatus: 'valid',
            linkRulesLegacySnapshot: null,
            settingsRevision: new Date(Date.parse(saved.settingsRevision) + 1).toISOString(),
          };
          return route.fulfill({ json: saved });
        }
        throw new Error(`Unexpected fixture request ${request.method()} ${tail}`);
      });
      await page.goto(`${base}links-test`);
      const open = page.getByRole('button', { name: 'Ссылки', exact: true });
      await open.click();
      const panel = page.locator('.settings-drilldown__panel--links');
      await panel.waitFor({ state: 'visible' });
      await applyNativeVisualMode(page, {
        theme: colorScheme,
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
        backButtonVisible: true,
      });
      const modes = panel.getByRole('radiogroup', { name: 'Режим модерации ссылок' });
      assert.equal(await modes.getByRole('radio').count(), 4);
      assert.equal(await panel.getByText('МАЙОР', { exact: true }).count(), 0);
      await modes.getByRole('radio', { name: 'Запрещать по списку', exact: true }).click();
      const editor = () => panel.getByRole('region', { name: 'Добавление правила', exact: true });
      const add = async (value, exception = false) => {
        await panel
          .getByRole('button', {
            name: exception ? 'Добавить исключение' : 'Добавить',
            exact: true,
          })
          .click();
        await editor().getByRole('textbox', { name: 'Ссылка или сайт', exact: true }).fill(value);
        await editor().getByRole('button', { name: 'Добавить', exact: true }).click();
        await editor().waitFor({ state: 'detached' });
      };
      await panel.getByRole('button', { name: 'Добавить', exact: true }).click();
      await editor()
        .getByRole('textbox', { name: 'Ссылка или сайт', exact: true })
        .fill('mailto:admin@example.com');
      await editor().getByRole('button', { name: 'Добавить', exact: true }).click();
      await editor().getByRole('alert').waitFor();
      assert.equal(await editor().getByRole('textbox').inputValue(), 'mailto:admin@example.com');
      await editor().getByRole('button', { name: 'Отмена', exact: true }).click();
      await add('blocked.example');
      await panel.locator('summary').filter({ hasText: 'Исключения' }).click();
      await add('https://blocked.example/help', true);
      const exact = 'https://other.example/a%20b?literal=%2525#offer';
      await add(exact);
      assert.equal(writes.length, 0, 'Editing rules never writes before Save');
      const exactRow = panel
        .locator('.links-panel__rule')
        .filter({ has: page.getByText(exact, { exact: true }) });
      await exactRow
        .getByRole('button', { name: `Изменить правило ${exact}`, exact: true })
        .click();
      const edit = panel.getByRole('region', { name: 'Изменение правила', exact: true });
      await edit.locator('summary').click();
      await edit
        .getByLabel('Последний день действия правила', { exact: true })
        .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
      await edit.getByRole('button', { name: 'Применить', exact: true }).click();
      await edit.waitFor({ state: 'detached' });
      assert.match(await exactRow.textContent(), /до /iu);
      await panel.locator('summary').filter({ hasText: 'Проверить сообщение' }).click();
      const message = panel.getByRole('textbox', {
        name: 'Сообщение для проверки ссылок',
        exact: true,
      });
      await message.fill('https://blocked.example/help');
      await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
      await panel.getByText('Все ссылки разрешены', { exact: true }).waitFor();
      await message.fill('https://blocked.example/help https://blocked.example/ad');
      await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
      await panel.getByText('Есть запрещённая ссылка', { exact: true }).waitFor();
      assert.equal(writes.length, 0);
      const viewport = page.viewportSize();
      await message.focus();
      await page.setViewportSize({
        width: viewport.width,
        height: Math.max(320, viewport.height - 260),
      });
      await message.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await message.blur();
      await page.setViewportSize(viewport);
      failNext = true;
      const save = () =>
        panel.getByRole('button', { name: /^(?:Сохранить|Повторить)$/u, exact: true });
      await save().click();
      await waitFor(() => writes.length === 1, 'Failed save was not observed');
      await save().waitFor({ state: 'visible' });
      await exactRow.waitFor();
      await dismissToasts();
      await save().click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(writes.length, 2, 'Retry sends one additional atomic settings request');
      const changed = writes[1].changes ?? writes[1];
      assert.equal(changed.linkRulesPolicy.rules.length, 3);
      assert.equal(changed.linkRulesPolicy.mode, 'DENY_SELECTED');
      assert.equal(changed.linkRulesLegacySnapshot.revision, '3');
      assert.equal(changed.linkWarnEnabled, false);
      assert.equal(changed.linkMuteEnabled, false);
      assert.equal(changed.linkBanEnabled, false);
      assert.equal(
        changed.stopWordsPolicy,
        undefined,
        'New link save cannot overwrite independent site policy',
      );
      await dismissToasts();
      await open.click();
      await exactRow.waitFor();
      assert.equal(
        await modes
          .getByRole('radio', { name: 'Запрещать по списку', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      await panel.locator('summary').filter({ hasText: 'Сайты из стоп-слов' }).click();
      await panel
        .getByRole('textbox', { name: 'Добавить запрещённые сайты', exact: true })
        .fill('another-legacy.example');
      const legacy = panel
        .locator('details')
        .filter({ has: page.getByText('Сайты из стоп-слов', { exact: true }) })
        .first();
      await legacy.getByRole('button', { name: 'Добавить записи', exact: true }).click();
      failNextSite = true;
      await panel.getByRole('button', { name: 'Сохранить сайты', exact: true }).click();
      await waitFor(() => siteWrites.length === 1, 'Independent site CAS was not observed');
      await panel.getByText('Проверьте сайт', { exact: true }).first().waitFor();
      const siteInput = panel.getByRole('textbox', {
        name: 'Добавить запрещённые сайты',
        exact: true,
      });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'Добавить запрещённые сайты',
      );
      assert.equal(await siteInput.getAttribute('aria-invalid'), 'true');
      assert.equal(await panel.getByText('another-legacy.example', { exact: true }).count(), 1);
      await dismissToasts();
      await siteInput.fill('fixed-legacy.example');
      await legacy.getByRole('button', { name: 'Добавить записи', exact: true }).click();
      await panel.getByRole('button', { name: 'Сохранить сайты', exact: true }).click();
      await waitFor(() => siteWrites.length === 2, 'Corrected site CAS was not observed');
      assert.deepEqual(siteWrites[0].policy.domains, ['legacy.example', 'another-legacy.example']);
      assert.deepEqual(siteWrites[1].policy.domains, [
        'legacy.example',
        'another-legacy.example',
        'fixed-legacy.example',
      ]);
      assert.equal(siteWrites[1].policy.rules[0].value, 'казино');
      assert.equal(writes.length, 2);
      await page.getByText('Блок «Ссылки» сохранён', { exact: true }).waitFor();
      await page.locator('.toast--success').screenshot({
        path: path.join(screenshots, `${name}-save.png`),
        animations: 'disabled',
      });
      await dismissToasts();
      await modes.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(screenshots, `${name}.png`),
        animations: 'disabled',
      });
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: draft rules, exact URL, exception, expiry, preview, retry, atomic save, independent legacy sites`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
