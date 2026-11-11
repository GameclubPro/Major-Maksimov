import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

// The fake server lives in Node, so a cleared phone and a reopened WebView cannot
// erase the operation. The mounted panel, contract readers and native Back are real.
const scenarios = [
  'native-unavailable',
  'foreign-blocked',
  'missing-capability',
  'server-setup',
  'module-unavailable',
];
const selected = process.env.KARAVAN_RECOVERY_SCENARIOS?.split(',') ?? scenarios;
assert.ok(
  selected.length && selected.every((name) => scenarios.includes(name)),
  'Unknown server recovery scenario',
);
const engineNames = ['chromium', 'webkit'];
const selectedEngines = process.env.KARAVAN_RECOVERY_ENGINE?.split(',') ?? engineNames;
assert.ok(
  selectedEngines.length && selectedEngines.every((name) => engineNames.includes(name)),
  'Unknown recovery engine',
);
const themes = process.env.KARAVAN_RECOVERY_THEME
  ? [process.env.KARAVAN_RECOVERY_THEME]
  : ['light', 'dark'];
assert.ok(
  themes.every((theme) => ['light', 'dark'].includes(theme)),
  'Unknown recovery theme',
);
const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/server-recovery-`);
const output = await mkdtemp('/tmp/maxim-shop-server-recovery-');
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  `${fixture}/fixture.tsx`,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '../../../src/styles.css';
import '../../../src/pages/settings-page';
import '../../../src/styles/moderation-workspace.css';
import Panel from '../../../src/pages/settings/karavan-marketplace-panel';
import {StorefrontWorkspace} from '../../../src/pages/settings/storefront-workspace';
import {ApiRequestError} from '../../../src/lib/api-request-error';
const params=new URLSearchParams(location.search);
const scenario=params.get('scenario');
document.documentElement.dataset.maxTheme=params.get('theme');
document.documentElement.dataset.maxClient='native';
document.body.dataset.miniappProfile='moderation';
window.__nativeReads=[];window.__nativeWrites=[];
const bridge=window.MAX?.WebApp??window.WebApp;
bridge.DeviceStorage={getItem:async(key)=>{window.__nativeReads.push(key);if(scenario==='foreign-blocked')return new Promise(()=>{});throw {error:{code:'client.device_storage_get_key.not_found'}};},setItem:async(key)=>{window.__nativeWrites.push(key);return {};},removeItem:async(key)=>{window.__nativeWrites.push(key);return {};}};
// Deliberately broken old evidence must never replace the admitted server state.
if(!['server-setup','module-unavailable'].includes(scenario)){
  localStorage.setItem('karavan-setup:v1:777:-123','{broken old copy');
  localStorage.setItem('karavan-binding:v1:777:-123','{broken old copy');
}
const api={requestKeepalive(){},async request(path,init={}){
  const response=await fetch('/__shop_recovery'+path,{method:init.method??'GET',body:init.body,headers:init.body?{'Content-Type':'application/json'}:undefined});
  const text=await response.text();
  if(!response.ok)throw new ApiRequestError(response.status,text,'Проверка временно недоступна');
  return JSON.parse(text);
}};
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><StorefrontWorkspace open onClose={()=>{window.__workspaceClosed=true;}}><Panel api={api} chatId="-123" publications={<p>Настройки ответа бота</p>}/></StorefrontWorkspace></QueryClientProvider>);
`,
);

const marketId = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const operationId = 'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const marketplace = {
  id: marketId,
  networkId: marketId,
  publicSlug: 'server-shop',
  name: 'Магазин соседей',
  description: null,
  kind: 'chat',
  status: 'active',
  admissionPolicy: 'applications',
  logoImageUrl: null,
  coverImageUrl: null,
  editRevision: 1,
  policyRevision: 1,
  orderRevision: 1,
  visibilityRevision: 1,
};
const binding = {
  id: marketId,
  chatId: '-123',
  chatTitle: 'Соседи',
  state: 'verified',
  generation: 1,
  revision: 1,
  verifiedAt: '2026-11-04T10:00:00.000Z',
};
const setupRequest = {
  operationId,
  chatIds: ['-123'],
  existingMarketplaceId: marketId,
  expectedPolicyRevision: 1,
  expectedConnectionRevision: 6,
};
function setupOperation(state) {
  return {
    operationId,
    state,
    request: setupRequest,
    checkpoints: {
      marketplaceId: marketId,
      bindings: [
        {
          chatId: '-123',
          state: state === 'complete' ? 'connected' : 'unknown',
          bindingId: state === 'complete' ? marketId : null,
          generation: state === 'complete' ? 1 : null,
        },
      ],
    },
  };
}
let server;
try {
  server = await ensureMiniappDevServer(base);
  for (const engineName of selectedEngines) {
    const engine = engineName === 'webkit' ? webkit : chromium;
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const theme of themes)
        for (const scenario of selected) {
          const width = engineName === 'webkit' ? 390 : 360;
          const context = await browser.newContext({
            viewport: { width, height: 780 },
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          const calls = [];
          let operation = ['server-setup', 'module-unavailable'].includes(scenario)
            ? setupOperation('unknown')
            : null;
          let revision = 7;
          const connection = () => ({
            version: 2,
            revision,
            blocked: scenario === 'foreign-blocked',
            operation: operation ? { kind: 'setup', operation } : null,
          });
          try {
            await installNativeVisualModeInitScript(context);
            await installMaxBridgeShimInitScript(
              context,
              { platform: engineName === 'webkit' ? 'ios' : 'android' },
              { colorScheme: theme },
            );
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            await context.route('**/__shop_recovery/**', async (route) => {
              const request = route.request();
              const path = new URL(request.url()).pathname.replace('/__shop_recovery', '');
              const body = request.postDataJSON();
              calls.push({ path, method: request.method(), body });
              const reply = (value, status = 200) =>
                route.fulfill({
                  status,
                  contentType: 'application/json',
                  body: JSON.stringify(value),
                });
              if (path.endsWith('/connection')) return reply(connection());
              if (path.endsWith(`/operations/${operationId}`)) return reply(operation);
              if (path.endsWith('/setup')) {
                assert.equal(
                  body.operationId,
                  operationId,
                  'Continuation keeps the admitted operation identity',
                );
                assert.deepEqual(body, setupRequest, 'Continuation keeps the admitted payload');
                operation = setupOperation('complete');
                revision++;
                return reply(operation);
              }
              if (path === '/chats')
                return reply([{ id: '-123', title: 'Соседи', createdAt: binding.verifiedAt }]);
              if (path.endsWith('/manage')) {
                if (body.command.operation === 'detail')
                  return reply({
                    operation: 'detail',
                    data: {
                      marketplace,
                      rules: {
                        id: marketId,
                        text: 'Правила магазина',
                        allowedCategoryIds: ['services'],
                        allowedSubcategoryIds: [],
                        categoryOrder: ['services'],
                        version: 1,
                        effectiveAt: binding.verifiedAt,
                        createdAt: binding.verifiedAt,
                        requiresAcceptance: true,
                      },
                      scheduledRules: null,
                      permissions: ['manage_marketplace', 'bind_chat', 'review_listing'],
                      counts: { listings: 2, readyListings: 2, pendingApplications: 0, chats: 1 },
                      bindings: [binding],
                    },
                  });
                if (body.command.operation === 'catalog')
                  return reply({ operation: 'catalog', data: { items: [], nextCursor: null } });
                if (body.command.operation === 'appearance') {
                  const draft = {
                    name: marketplace.name,
                    description: null,
                    logoImageUrl: null,
                    coverImageUrl: null,
                    accent: 'blue',
                    blocks: [
                      { id: 'categories', visible: true },
                      { id: 'pinned', visible: true },
                      { id: 'sellers', visible: true },
                    ],
                  };
                  return reply({
                    operation: 'appearance',
                    data: { draft, published: draft, revision: 1, hasChanges: false },
                  });
                }
              }
              if (!path.endsWith('/karavan-marketplace'))
                return reply({ code: 'UNEXPECTED_FIXTURE_REQUEST' }, 500);
              if (scenario === 'module-unavailable')
                return reply({ code: 'KARAVAN_COMMAND_RESULT_UNAVAILABLE' }, 503);
              const connected = !operation || operation.state === 'complete';
              return reply({
                enabled: true,
                actorMaxUserId: '777',
                sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
                setupOperation: operation,
                ...(scenario === 'missing-capability' ? {} : { connection: connection() }),
                currentChatTitle: 'Соседи',
                marketplace: connected ? marketplace : null,
                binding: connected ? binding : null,
                bindings: connected ? [binding] : [],
                permissions: [
                  'manage_network',
                  'bind_chat',
                  'manage_marketplace',
                  'review_listing',
                ],
                counts: {
                  listings: connected ? 2 : 0,
                  readyListings: connected ? 2 : 0,
                  pendingApplications: 0,
                  chats: connected ? 1 : 0,
                },
                canManage: true,
                publicationChoices: [],
                buyerUrl: connected
                  ? 'https://max.ru/synthetic_buyer_bot?startapp=m_server-shop'
                  : null,
                previewUrl: null,
                access: { reason: connected ? 'allowed' : 'unbound', canRecover: false },
              });
            });
            const page = await context.newPage();
            page.setDefaultTimeout(15_000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`${url}?scenario=${scenario}&theme=${theme}`);
            await applyNativeVisualMode(page, {
              safeTop: 0,
              safeBottom: engineName === 'webkit' ? 34 : 24,
            });
            const writes = () =>
              calls.filter(
                (call) =>
                  call.method !== 'GET' &&
                  !['detail', 'catalog', 'appearance'].includes(call.body?.command?.operation),
              );
            if (['server-setup', 'module-unavailable'].includes(scenario)) {
              const resume = page.getByRole('button', {
                name: 'Продолжить подключение',
                exact: true,
              });
              await resume.waitFor();
              assert.deepEqual(writes(), [], 'Opening persisted uncertainty never resumes it');
              await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
              });
              await page.reload();
              await resume.waitFor();
              assert.deepEqual(
                writes(),
                [],
                'A new WebView finds server state without a phone journal',
              );
              const check = page.getByRole('button', { name: 'Проверить результат', exact: true });
              await check.click();
              await page.waitForFunction(
                () =>
                  ![...document.querySelectorAll('button')].find(
                    (button) => button.textContent.trim() === 'Проверить результат',
                  )?.disabled,
              );
              assert.deepEqual(writes(), [], 'Explicit result check has no provider effect');
              if (scenario === 'server-setup') {
                await resume.click();
                await page.getByRole('heading', { name: marketplace.name, exact: true }).waitFor();
                assert.equal(writes().length, 1);
                await page.reload();
                await page.getByRole('heading', { name: marketplace.name, exact: true }).waitFor();
                assert.equal(
                  writes().length,
                  1,
                  'Reopening the completed operation does not create another shop',
                );
              }
            } else {
              await page.getByRole('heading', { name: marketplace.name, exact: true }).waitFor();
              await page
                .getByRole('button', { name: 'Открыть магазин', exact: true })
                .click();
              assert.ok(
                await page.evaluate(() =>
                  window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some(
                    (event) => event.type === 'openMaxLink',
                  ),
                ),
              );
              await page.getByRole('button', { name: 'Подключение', exact: true }).click();
              await page.getByText('Соседи', { exact: true }).first().waitFor();
              if (['missing-capability', 'foreign-blocked'].includes(scenario)) {
                assert.equal(
                  await page
                    .getByRole('button', { name: 'Подключить чаты', exact: true })
                    .isEnabled(),
                  false,
                );
              } else {
                await page
                  .getByRole('button', { name: 'Подключить чаты', exact: true })
                  .waitFor({ state: 'visible' });
              }
              assert.deepEqual(
                writes(),
                [],
                'Reading the verified shop and connected list has no mutation',
              );
            }
            assert.deepEqual(
              await page.evaluate(() => window.__nativeReads),
              [],
              'Native storage failure never gates open/list/status/resume',
            );
            assert.deepEqual(
              await page.evaluate(() => window.__nativeWrites),
              [],
              'Server recovery leaves old native evidence untouched',
            );
            await settleVisualFrame(page);
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
              'No horizontal overflow',
            );
            assert.deepEqual(errors, []);
            await page.screenshot({
              path: `${output}/${engineName}-${theme}-${scenario}.png`,
              fullPage: true,
            });
            console.log(`Server recovery ${engineName}/${theme}/${scenario}: passed`);
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
  console.log(`Server recovery screenshots: ${output}`);
} finally {
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
