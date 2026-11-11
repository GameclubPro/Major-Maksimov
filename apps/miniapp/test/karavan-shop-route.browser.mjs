import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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

// Keep the real route, shared fields, draft state and save handler together.
// Only the local preview transport supplies synthetic marketplace responses.
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const output = await mkdtemp('/tmp/maxim-shop-route-');
const server = await ensureMiniappDevServer(base);
try {
  for (const [engineName, engine, width, theme] of [
    ['chromium', chromium, 360, 'dark'],
    ['webkit', webkit, 390, 'light'],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      const context = await browser.newContext({
        viewport: { width, height: 780 },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        {
          platform: engineName === 'webkit' ? 'ios' : 'android',
        },
        { colorScheme: theme },
      );
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await context.route('**/src/lib/design-preview.ts', async (route) => {
        const response = await route.fetch();
        // The shop wire contract requires a real-shaped numeric chat identity.
        await route.fulfill({
          response,
          body: (await response.text()).replaceAll('preview-chat', '-123'),
        });
      });
      await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = 'for (const handler of handlers) {';
        assert.ok(source.includes(marker));
        await route.fulfill({
          response,
          body: source.replace(
            marker,
            `
          if (context.url.pathname.endsWith('/karavan-marketplace')) {
            const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
            const chatId = decodeURIComponent(context.url.pathname.split('/').at(-2));
            const binding = {id, chatId, chatTitle: 'Соседи',
              state: 'verified', generation: 1, revision: 1, verifiedAt: new Date().toISOString()};
            return {enabled: true, actorMaxUserId: '777', sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
              setupOperation: null, connection: {version: 2, revision: 0, blocked: false, operation: null},
              publicationChoices: [], currentChatTitle: 'Соседи',
              marketplace: {id, networkId: id, publicSlug: 'synthetic-shop', name: 'Магазин соседей',
                description: null, kind: 'chat', status: 'active', admissionPolicy: 'applications',
                logoImageUrl: null, coverImageUrl: null, editRevision: 1, policyRevision: 1,
                orderRevision: 1, visibilityRevision: 1}, binding, bindings: [binding],
              permissions: ['manage_marketplace','review_listing','arrange_listings','bind_chat'],
              counts: {listings: 2, readyListings: 2, pendingApplications: 1, chats: 1}, canManage: true,
              publicationPreview: {mode: 'chat_marketplace'}, buyerUrl: 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop', previewUrl: null};
          }
          ${marker}`,
          ),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        if (process.env.SHOP_ROUTE_SCOPE_ONLY === '1') {
          await runScopeChecks(context, engineName);
          continue;
        }
        await page.goto(`${base}?preview=1&profile=moderation&view=chat`);
        const settingsEntry = page.getByRole('link', { name: /^Открыть настройки:/u }).first();
        assert.doesNotMatch(await settingsEntry.getAttribute('href'), /focus=storefront/u);
        await settingsEntry.click();
        await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
        await applyNativeVisualMode(page, {
          safeTop: 0,
          safeBottom: engineName === 'webkit' ? 34 : 24,
        });
        const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
        await home.waitFor();
        await home.getByRole('button', { name: 'Открыть магазин', exact: true }).waitFor();
        await home.getByRole('button', { name: 'Управлять магазином', exact: true }).waitFor();
        assert.equal(await home.getByRole('button', { name: /^(?:Товары и услуги|Заявки|Настройки)$/u }).count(), 0);
        assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
        await settleVisualFrame(page);
        await page.screenshot({ path: `${output}/${engineName}-home.png` });
        const settings = home;
        await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
        const publications = page.getByRole('dialog', { name: 'Объявления в чате', exact: true });
        await publications.getByRole('checkbox', { name: 'Ответ бота на $' }).check();
        await publications
          .getByRole('group', { name: 'Кто может вызвать ответ на $', exact: true })
          .waitFor();
        await publications.locator('.settings-storefront-editor__preview').waitFor();
        await settleVisualFrame(page);
        await page.screenshot({ path: `${output}/${engineName}-publications-enabled.png` });
        await publications.getByText('Изменить текст', { exact: true }).click();
        const message = publications.getByRole('textbox', { name: /^Текст ответа бота/ });
        await message.fill('Объявления нашего чата');
        await message.evaluate((node) => {
          window.__retainedPublicationInput = node;
        });
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', {
            configurable: true,
            value: 360,
          });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await settleVisualFrame(page);
        await message.focus();
        const save = publications.getByRole('button', { name: 'Сохранить', exact: true });
        assert.ok(
          await save.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return rect.height >= 48 && rect.top >= 0 && rect.bottom <= 360;
          }),
          'save stays above keyboard with a 48px target',
        );
        assert.ok(
          await message.evaluate((node) => {
            const field = node.getBoundingClientRect();
            const body = node.closest('.settings-drilldown__body').getBoundingClientRect();
            return field.top >= body.top - 1 && field.bottom <= body.bottom + 1;
          }),
          'focused input stays inside visible scroll area',
        );
        await page.screenshot({ path: `${output}/${engineName}-keyboard.png` });
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await settleVisualFrame(page);
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await settings.waitFor();
        await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
        await message.waitFor();
        assert.equal(
          await message.inputValue(),
          'Объявления нашего чата',
          'Native Back retains the unsaved publication input',
        );
        assert.equal(
          await message.evaluate((node) => node === window.__retainedPublicationInput),
          true,
          'Native Back keeps the editor mounted',
        );
        await publications.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await page.getByText('Блок «Магазин чата» сохранен', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
        await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
        await publications.getByText('Изменить текст', { exact: true }).click();
        assert.equal(await message.inputValue(), 'Объявления нашего чата');
        await settleVisualFrame(page);
        assert.ok(await publications.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
        await page.screenshot({ path: `${output}/${engineName}-publications.png` });
        assert.deepEqual(errors, []);
        console.log(
          `Shop actual route: ${engineName}/${width}/${theme} passed. Screenshots: ${output}`,
        );
        await runScopeChecks(context, engineName);
      } catch (error) {
        await page.screenshot({ path: `${output}/${engineName}-failure.png` });
        console.error((await page.locator('body').innerText()).slice(-4000));
        throw error;
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}

async function runScopeChecks(context, engineName) {
  const directory = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
  await mkdir(directory, { recursive: true });
  const fixture = await mkdtemp(`${directory}/scope-`);
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
document.body.dataset.miniappProfile='moderation';
let recoveryDelay=0;
const bridge=window.MAX?.WebApp??window.WebApp;
bridge.DeviceStorage={getItem:async()=>{await new Promise(resolve=>setTimeout(resolve,recoveryDelay));return {value:null};}};
let actor='777', generation=1, connectionRevision=1, marketplaceId='a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
let permissions=['manage_marketplace','review_listing','bind_chat'];
const request={operationId:'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',chatIds:['-123','-456'],existingMarketplaceId:marketplaceId,expectedPolicyRevision:1};
let operation={operationId:request.operationId,state:'partial',request,checkpoints:{marketplaceId,bindings:[{chatId:'-123',state:'connected',bindingId:marketplaceId,generation:1},{chatId:'-456',state:'failed',bindingId:null,generation:null}]}};
window.__probeReads=0;window.__probeWrites=[];
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
const api={request:async(path,init={})=>{
  if(init.body){window.__probeWrites.push({path,body:JSON.parse(init.body)});throw new Error('Unexpected write');}
  if(path==='/chats') return [];
  if(!path.endsWith('/karavan-marketplace'))throw new Error('Unexpected read '+path);
  window.__probeReads++;
  const chatId=decodeURIComponent(path.split('/')[2]);
  const binding={id:marketplaceId,chatId,chatTitle:'Соседи',state:'verified',generation,revision:1,verifiedAt:new Date().toISOString()};
  return {enabled:true,actorMaxUserId:actor,sellerBotUrl:'https://max.ru/synthetic_seller_bot',setupOperation:operation,connection:{version:2,revision:connectionRevision,blocked:false,operation:operation?{kind:'setup',operation}:null},publicationChoices:[],currentChatTitle:'Соседи',marketplace:{id:marketplaceId,networkId:marketplaceId,publicSlug:'scope-shop',name:'Проверка области',description:null,kind:'chat',status:'active',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1},binding,bindings:[binding],permissions,counts:{listings:2,readyListings:2,approvedListings:2,pendingApplications:0,chats:1},canManage:permissions.includes('manage_marketplace'),buyerUrl:'https://max.ru/synthetic_buyer_bot?startapp=m_scope-shop',previewUrl:null,publicationPreview:{mode:'chat_marketplace'}};
},requestKeepalive:()=>{}};
function Harness(){const[chatId,setChatId]=React.useState('-123');window.__changeProbeScope=async(kind)=>{connectionRevision++;if(kind==='actor')actor='888';else if(kind==='generation')generation++;else if(kind==='marketplace')marketplaceId='c0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';else if(kind==='chat'){setChatId('-789');return;}else if(kind==='complete'){operation=null;recoveryDelay=80;}else if(kind==='arrange')permissions=['arrange_listings'];await queryClient.invalidateQueries({queryKey:['karavan-marketplace']});};return <StorefrontWorkspace open onClose={()=>{}}><Panel api={api} chatId={chatId} publications={<span>Объявления</span>}/></StorefrontWorkspace>;}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><Harness/></QueryClientProvider>);
`,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`);
    const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
    const management = home.getByRole('button', { name: 'Управлять магазином', exact: true });
    await management.waitFor();
    await page.evaluate(() => window.__changeProbeScope('complete'));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Управлять магазином' && !node.disabled));
    for (const scope of ['marketplace', 'generation', 'actor', 'chat']) {
      const reads = await page.evaluate(() => window.__probeReads);
      await page.evaluate(scope => window.__changeProbeScope(scope), scope);
      await page.waitForFunction(reads => window.__probeReads > reads, reads);
      await management.waitFor();
      assert.equal(await home.getByRole('button', { name: 'Заявки', exact: true }).count(), 0);
    }
    assert.deepEqual(await page.evaluate(() => window.__probeWrites), []);
    assert.deepEqual(errors, []);
    console.log(
      `Shop scopes ${engineName}: partial recovery + actor/chat/marketplace/generation changes without commerce writes passed`,
    );
  } catch (error) {
    console.error(
      `${engineName} scope probe: ${(await page.locator('body').innerText()).slice(-4000)}`,
    );
    console.error(errors);
    throw error;
  } finally {
    await page.close();
    await rm(fixture, { recursive: true, force: true });
  }
}
