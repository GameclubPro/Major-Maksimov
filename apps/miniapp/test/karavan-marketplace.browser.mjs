import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const scenarios = [
  'setup',
  'setup_simple',
  'first_native_unavailable',
  'first_native_stall',
  'first_server_pending',
  'first_lost_response',
  'first_cached_error',
  'setup_actor_switch',
  'cancel_actor_switch',
  'legacy_multichat',
  'draft_wrong_intent',
  'draft_invitation',
  'draft_mirror_conflict',
  'draft_native_stall',
  'pending_reload',
  'draft',
  'draft_empty',
  'paused',
  'preview_missing',
  'public_view',
  'switch_chat',
  'bridge_error',
  'active',
  'error',
  'unknown',
  'existing',
  'existing_unknown',
  'existing_rules_changed',
  'existing_binding_changed',
  'existing_options_error',
  'replace',
  'recovery',
  'recovery_conflict',
  'access_changed',
  'disconnect',
  'reviewer',
  'partial',
  'partial_bound',
  'server_restore',
  'choice',
];
const selectedScenarios = process.env.KARAVAN_BROWSER_SCENARIOS?.split(',') ?? scenarios;
assert.ok(
  selectedScenarios.length > 0 && selectedScenarios.every((item) => scenarios.includes(item)),
  'Unknown Karavan browser scenario',
);
const root = resolve(import.meta.dirname, '..');
const fixtures = resolve(root, 'build/karavan-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/karavan-test-`);
const output = await mkdtemp('/tmp/maxim-karavan-browser-');
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const path = `${base}build/karavan-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test-root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  `${fixture}/fixture.tsx`,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider,useIsMutating} from '@tanstack/react-query';
import '../../../src/styles.css';
import '../../../src/pages/settings-page';
import '../../../src/styles/moderation-workspace.css';
import Panel from '../../../src/pages/settings/karavan-marketplace-panel';
import {ApiRequestError} from '../../../src/lib/api-request-error';
import {StorefrontWorkspace} from '../../../src/pages/settings/storefront-workspace';
import {marketplaceManagementResponseSchema} from '@maxim/contracts/karavan-marketplace-management';
const scenario = new URLSearchParams(location.search).get('scenario');
document.documentElement.dataset.maxTheme = new URLSearchParams(location.search).get('theme') || 'light';
document.body.dataset.miniappProfile = 'moderation';
Object.assign(document.body.style,{margin:'0',padding:'20px 16px',background:'var(--color-surface)',fontFamily:'var(--font-body)'});
const uuid='a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const marketplace={id:uuid,networkId:'c41eba17-407e-4e51-b23c-1dd3edca4e63',publicSlug:'synthetic-shop',name:'Магазин соседей — длинное название для проверки переноса',description:null,kind:'chat',status:scenario==='paused'?'paused':['active','existing','existing_unknown','existing_rules_changed','existing_binding_changed','existing_options_error','choice','public_view','switch_chat','bridge_error'].includes(scenario)?'active':'draft',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1};
const binding={id:'9c9e1a8e-533f-49f8-9d5e-2bbad494bb74',chatId:'-123',chatTitle:'Соседи',state:scenario==='recovery'?'revoked':'verified',generation:1,revision:1,verifiedAt:new Date().toISOString()};
let connected=['active','draft','draft_empty','paused','preview_missing','public_view','switch_chat','bridge_error','recovery','recovery_conflict','access_changed','disconnect','reviewer','choice','replace'].includes(scenario); let reads=0; let setups=Number(sessionStorage.getItem('setups')||0); let operation=JSON.parse(sessionStorage.getItem('operation')||'null'); let chosen=false; let optionReads=0; let previewReads=0; let recovered=false;
let moduleActor='777', connectionRevision=0, bindingOperation=null;
const connection=()=>{const item=bindingOperation?{kind:'binding',operation:bindingOperation}:operation?{kind:'setup',operation}:null;return {version:2,revision:connectionRevision,blocked:false,operation:item};};
if(scenario==='server_restore') {const request={operationId:uuid,chatIds:['-123','-456'],create:{name:'Сохранённый магазин',rules:{text:'Rules',allowedCategoryIds:['services'],allowedSubcategoryIds:[]}}};operation={operationId:uuid,state:'partial',request,checkpoints:{marketplaceId:uuid,bindings:request.chatIds.map(chatId=>({chatId,state:'failed',bindingId:null,generation:null}))}};}
if(scenario==='cancel_actor_switch') {const request={operationId:uuid,chatIds:['-123'],existingMarketplaceId:uuid,expectedPolicyRevision:1};operation={operationId:uuid,state:'partial',request,checkpoints:{marketplaceId:uuid,bindings:[{chatId:'-123',state:'failed',bindingId:null,generation:null}]}};}
window.__karavanRequests=[]; window.__karavanOpened=[]; window.__karavanClosed=0; window.WebApp={openMaxLink:(url)=>{if(scenario==='bridge_error'&&!window.__bridgeRetry) throw new Error('Bridge unavailable');window.__karavanOpened.push(url)},close:()=>{window.__karavanClosed++}};
const draftKey='karavan-setup-draft:v2:777:-123:create';
const savedDraft={mode:'new',existingId:null,name:'Сохранённый ввод',rules:'Правила',categories:['services'],subcategories:['services.repair'],initialized:true,admissionPolicy:'applications',chatIds:['-123']};
const journalKey='karavan-setup:v1:777:-123';
const journalRequest={operationId:uuid,chatIds:['-123'],existingMarketplaceId:uuid,expectedPolicyRevision:1};
if(scenario.startsWith('first_')) {
  document.documentElement.dataset.maxClient='native';
  window.WebApp.initData='fixture-init-data';window.WebApp.platform='android';
  window.__nativeReads=[];window.__nativeWrites=[];
  window.WebApp.DeviceStorage={
    getItem:async(key)=>{window.__nativeReads.push(key);if(scenario==='first_native_stall')return new Promise(()=>{});throw {error:{code:'client.device_storage_get_key.not_found'}};},
    setItem:async(key)=>{window.__nativeWrites.push(key);return {};},
    removeItem:async(key)=>{window.__nativeWrites.push(key);return {};},
  };
  if(scenario==='first_server_pending'&&!operation) operation={operationId:uuid,state:'unknown',request:journalRequest,checkpoints:{marketplaceId:uuid,bindings:[{chatId:'-123',state:'unknown',bindingId:null,generation:null}]}};
  connected=operation?.state==='complete';
}
if(scenario==='pending_reload') {
  operation={operationId:uuid,state:'pending',request:journalRequest,checkpoints:{marketplaceId:uuid,bindings:[{chatId:'-123',state:'pending',bindingId:null,generation:null}]}};
}
if(scenario==='legacy_multichat') localStorage.setItem('karavan-setup-draft:v1:777:-123',JSON.stringify({...savedDraft,chatIds:['-123','-456']}));
if(scenario==='draft_wrong_intent') localStorage.setItem(draftKey,JSON.stringify({...savedDraft,mode:'existing',existingId:uuid}));
if(scenario==='draft_invitation') localStorage.setItem(draftKey,JSON.stringify({...savedDraft,admissionPolicy:'invitation'}));
if(['draft_mirror_conflict','draft_native_stall'].includes(scenario)) localStorage.setItem(draftKey,JSON.stringify(savedDraft));
if(['draft_mirror_conflict','draft_native_stall'].includes(scenario)) {
  const affectedKey=draftKey;
  const initialNative=JSON.stringify({...savedDraft,name:'Вторая копия ввода'});
  window.__nativeCopies={[affectedKey]:initialNative}; window.__nativeReads=[]; window.__nativeWrites=[];
  document.documentElement.dataset.maxClient='native';
  window.WebApp.initData='fixture-init-data';
  window.WebApp.DeviceStorage={
    getItem:(key)=>{window.__nativeReads.push(key);const value=window.__nativeCopies[key]??null;if(scenario.endsWith('_native_stall')&&key===affectedKey&&!window.__storageReady)return new Promise(resolve=>{window.__finishNative=()=>{window.__storageReady=true;resolve({value});}});return Promise.resolve({value});},
    setItem:async(key,value)=>{window.__nativeWrites.push(key);window.__nativeCopies[key]=value;return {};},
    removeItem:async(key)=>{window.__nativeWrites.push(key);delete window.__nativeCopies[key];return {};},
  };
}
const api={request:async(path,init={})=>{
  window.__karavanRequests.push({path,body:init.body?JSON.parse(init.body):null});
  if(path.endsWith('/manage')) {
    const {command}=JSON.parse(init.body);
    if(command.operation==='appearance') { const draft={name:marketplace.name,description:null,logoImageUrl:null,coverImageUrl:null,accent:'blue',blocks:[{id:'categories',visible:true},{id:'pinned',visible:true},{id:'sellers',visible:true}]}; return {operation:'appearance',data:{draft,published:draft,revision:1,hasChanges:false}}; }
    if(command.operation==='catalog') return {operation:'catalog',data:{items:[],nextCursor:null}};
    if(command.operation!=='detail') throw new Error('Unexpected management operation '+command.operation);
    const detail = {operation:'detail',data:{marketplace,rules:{id:uuid,text:'Правила магазина',allowedCategoryIds:['services'],allowedSubcategoryIds:['services.repair'],categoryOrder:['services'],version:1,effectiveAt:new Date().toISOString(),createdAt:new Date().toISOString(),requiresAcceptance:true},scheduledRules:null,permissions:['manage_marketplace','bind_chat','review_listing'],counts:{listings:scenario==='draft_empty'?0:12,readyListings:scenario==='draft_empty'?0:12,pendingApplications:scenario==='draft_empty'?0:3,chats:2},bindings:[binding]}};
    return marketplaceManagementResponseSchema.parse(detail);
  }
  if(path.endsWith('/handoffs')) { const input=JSON.parse(init.body); const result={url:['view','preview'].includes(input.destination)?'https://max.ru/synthetic_buyer_bot?startapp=mh_'+('x'.repeat(43)):'https://max.ru/synthetic_seller_bot?startapp=community_h_'+('x'.repeat(43)),expiresAt:new Date(Date.now()+120000).toISOString()}; if(scenario==='switch_chat') return new Promise(resolve=>{window.__resolveKaravanHandoff=()=>resolve(result)}); return result; }
  if(path==='/chats') return [{id:'-123',title:'Соседи',createdAt:new Date().toISOString()},{id:'-456',title:'Ещё один очень длинный заголовок чата наших соседей',createdAt:new Date().toISOString()}];
  if(path.endsWith('/setup-options')&&scenario==='existing_options_error'&&optionReads++<2) throw new Error('Категории недоступны');
  if(path.endsWith('/setup-options')) return {chatTitle:'Соседи',categories:[{id:'services',label:'Услуги',subcategories:[{id:'services.repair',label:'Ремонт'},{id:'services.cleaning',label:'Уборка'}]},{id:'grocery',label:'Продукты',subcategories:[{id:'grocery.fruit',label:'Фрукты'}]}]};
  if(path.endsWith('/preview')) { const input=JSON.parse(init.body); if(input.marketplaceId) previewReads++; const changed=scenario==='existing_rules_changed'&&previewReads>1; const changedBinding=scenario==='existing_binding_changed'; const targetMarketplace=input.marketplaceId==='bb669048-0279-4a35-987c-60f94593163e'?{...marketplace,id:input.marketplaceId,name:'Другой магазин'}:marketplace; return {target:input.marketplaceId?{marketplace:{...targetMarketplace,policyRevision:changed?2:1},rules:{text:changed?'Обновлённые правила существующего магазина':'Проверенные правила существующего магазина',allowedCategoryIds:['services'],allowedSubcategoryIds:['services.repair'],categoryOrder:['services'],version:changed?2:1},permissions:['bind_chat','manage_network'],counts:{listings:12,pendingApplications:0,chats:2},bindings:[binding]}:null,chats:input.chatIds.map(chatId=>({chatId,title:chatId==='-123'?'Соседи':'Второй чат',binding:changedBinding?{...binding,generation:previewReads>1?2:1}:scenario==='replace'?binding:null,marketplace:changedBinding||scenario==='replace'?marketplace:null}))}; }
  if(path.endsWith('/publication-choice')) {chosen=true;return {saved:true,storeId:JSON.parse(init.body).storeId};}
  if(path.endsWith('/available')) return {marketplaces:scenario==='setup_simple'?[]:[{marketplace,permissions:['manage_network','bind_chat']},...(scenario==='replace'?[{marketplace:{...marketplace,id:'bb669048-0279-4a35-987c-60f94593163e',name:'Другой магазин'},permissions:['manage_network','bind_chat']}]:[])],nextCursor:null};
  if(path.endsWith('/connection')) return connection();
  if(path.includes('/connection/operations/')) return bindingOperation;
  if(path.endsWith('/connection/binding')||path.includes('/bindings/')) {
    const input=JSON.parse(init.body);connectionRevision++;
    recovered=input.action==='recover_chat';connected=true;marketplace.status=input.action==='unbind_chat'?'paused':'active';binding.state=input.action==='unbind_chat'?'disconnected':'verified';
    const superseded=scenario==='recovery_conflict';if(superseded)binding.generation=2;
    bindingOperation={operationId:input.commandId,state:superseded?'superseded':'complete',request:{...input,marketplaceId:input.marketplaceId??uuid},result:superseded?null:{bindingId:binding.id,generation:binding.generation},errorCode:superseded?'KARAVAN_CONNECTION_SUPERSEDED':null};
    return bindingOperation;
  }
  if(path.endsWith('/setup')) {
    const input=JSON.parse(init.body); connectionRevision++; setups++;sessionStorage.setItem('setups',String(setups));
    const complete=scenario==='setup_simple'||(scenario.startsWith('first_')&&scenario!=='first_lost_response')||setups>1;
    operation={operationId:input.operationId,state:complete?'complete':'pending',request:input,checkpoints:{marketplaceId:uuid,bindings:input.chatIds.map(chatId=>({chatId,state:complete?'connected':'pending',bindingId:binding.id,generation:1}))}};
    if(['partial','partial_bound'].includes(scenario)) { operation.state='partial'; connected=scenario==='partial_bound'; operation.checkpoints.bindings.forEach(item=>item.state=connected&&item.chatId==='-123'?'connected':'failed'); return operation; }
    if(scenario==='first_lost_response'&&setups===1)operation.state='unknown';
    sessionStorage.setItem('operation',JSON.stringify(operation));
    if(scenario==='first_lost_response'&&setups===1)throw new Error('Ответ потерян');
    if(['unknown','existing_unknown'].includes(scenario)&&setups===1) throw new Error('Сеть недоступна');
    if(complete) { connected=true;if(scenario==='replace') Object.assign(marketplace,{id:input.existingMarketplaceId,name:'Другой магазин'}); }
    const response=operation;
    if(scenario==='setup_actor_switch') await new Promise(resolve=>{window.__releaseSetup=resolve;});
    return response;
  }
  if(path.includes('/operations/')&&path.endsWith('/cancel')) {if(scenario==='cancel_actor_switch')return new Promise((resolve,reject)=>{window.__rejectCancellation=()=>reject(new Error('Запоздавшая ошибка отмены'));});operation.state='cancelled';connectionRevision++;sessionStorage.setItem('operation',JSON.stringify(operation));return operation;}
  if(path.includes('/operations/')) return operation;
  if(scenario==='error' && reads++===0) throw new Error('Сеть недоступна');
  if(scenario==='loading') await new Promise(resolve=>setTimeout(resolve,800));
  if(scenario==='first_cached_error'&&window.__cachedFirstSeeded)throw new Error('Проверка недоступна');
  return {enabled:true,actorMaxUserId:moduleActor,sellerBotUrl:'https://max.ru/synthetic_seller_bot',setupOperation:operation,connection:connection(),currentChatTitle:'Соседи',buyerUrl:connected?'https://max.ru/synthetic_buyer_bot?startapp=m_'+(path.includes('/-456/')?'other-shop':'synthetic-shop'):null,previewUrl:connected&&scenario!=='preview_missing'&&['draft','paused'].includes(marketplace.status)?'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop':null,bindings:connected?[binding]:[],publicationChoices:scenario==='choice'&&!chosen?[{id:uuid,marketplaceId:uuid,marketplaceName:marketplace.name,chatId:'-123',expiresAt:new Date(Date.now()+900000).toISOString(),stores:[{id:uuid,name:'Первая витрина'},{id:'bb669048-0279-4a35-987c-60f94593163e',name:'Вторая витрина'}]}]:[],marketplace:connected?(path.includes('/-456/')?{...marketplace,name:'Другой магазин'}:marketplace):null,binding:connected?binding:null,access:{reason:scenario.startsWith('first_')&&!connected?'unbound':!recovered&&(scenario==='access_changed'||scenario==='recovery'||scenario.startsWith('recovery_conflict'))?'binding_changed':scenario==='public_view'?'forbidden':'allowed',canRecover:!recovered&&(scenario==='recovery'||scenario==='access_changed'||scenario.startsWith('recovery_conflict'))},permissions:scenario==='public_view'||(!recovered&&scenario==='access_changed')?[]:scenario==='reviewer'?['review_listing']:['manage_network','bind_chat','manage_marketplace','review_listing'],counts:{listings:connected&&scenario!=='draft_empty'?12:0,pendingApplications:connected&&scenario!=='draft_empty'?3:0,chats:connected?2:0},canManage:scenario!=='reviewer'};
},requestKeepalive:()=>{}};
function Harness(){window.__pendingMutations=useIsMutating();const [chatId,setChatId]=React.useState('-123');window.__switchKaravanChat=()=>setChatId('-456');return <StorefrontWorkspace key={chatId} open onClose={()=>{}} dirty={scenario.includes('_after_publications')} footer={<button onClick={()=>{window.__publicationSaves=(window.__publicationSaves??0)+1;}}>Сохранить ответ бота</button>}><Panel api={api} chatId={chatId} publications={<p>Настройки ответа бота</p>}/></StorefrontWorkspace>;}
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.__switchKaravanActor=()=>{moduleActor='888';binding.generation=2;if(['setup_actor_switch','cancel_actor_switch'].includes(scenario)){connected=true;operation=null;connectionRevision++;}return queryClient.invalidateQueries({queryKey:['karavan-marketplace','-123']});};
if(scenario==='first_cached_error') {
  const snapshot=await api.request('/chats/-123/karavan-marketplace');
  queryClient.setQueryData(['karavan-marketplace','-123'],snapshot);
  window.__cachedFirstSeeded=true;
}
createRoot(document.getElementById('test-root')).render(<QueryClientProvider client={queryClient}><Harness/></QueryClientProvider>);
`,
);
let server;
let browser;
async function geometry(page, name) {
  const bounds = await page.evaluate(() => ({
    primaryColors: [...document.querySelectorAll('.karavan-module__primary')].map(
      (el) => getComputedStyle(el).color,
    ),
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    controls: [
      ...document.querySelectorAll(
        '.karavan-module button,.karavan-module input:not([type=checkbox]):not([type=radio]),.karavan-module summary',
      ),
    ].map((el) => ({
      text: el.textContent?.trim(),
      ...Object.fromEntries(
        ['width', 'height', 'left', 'right'].map((key) => [key, el.getBoundingClientRect()[key]]),
      ),
    })),
  }));
  for (const color of bounds.primaryColors)
    assert.equal(color, 'rgb(255, 255, 255)', `${name}: primary contrast`);
  assert.ok(bounds.scroll <= bounds.width + 1, `${name}: horizontal overflow`);
  for (const control of bounds.controls)
    if (control.width > 0) {
      assert.ok(control.height >= 43.5, `${name}: small control ${control.text}`);
      assert.ok(
        control.left >= -1 && control.right <= bounds.width + 1,
        `${name}: clipped control ${control.text} (${control.left}..${control.right} / ${bounds.width})`,
      );
    }
}
try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch();
  for (const width of process.env.KARAVAN_BROWSER_WIDTH
    ? [Number(process.env.KARAVAN_BROWSER_WIDTH)]
    : [320, 360, 390, 430])
    for (const theme of process.env.KARAVAN_BROWSER_THEME
      ? [process.env.KARAVAN_BROWSER_THEME]
      : ['light', 'dark']) {
      for (const scenario of selectedScenarios) {
        const context = await browser.newContext({
          viewport: { width, height: 740 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        let page;
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(path + '?scenario=' + scenario + '&theme=' + theme);
          if (
            [
              'setup',
              'setup_simple',
              'setup_actor_switch',
              'legacy_multichat',
              'unknown',
              'partial',
              'partial_bound',
            ].includes(scenario)
          )
            await page.getByRole('button', { name: /^Магазин участников/ }).click();
          if (scenario.startsWith('first_')) {
            if (scenario === 'first_cached_error') {
              await page
                .getByRole('alert')
                .filter({ hasText: 'Не удалось обновить магазин.' })
                .waitFor({ timeout: 3000 });
              assert.equal(
                await page.getByRole('button', { name: /^Магазин участников/ }).count(),
                0,
              );
              assert.equal(
                await page.getByRole('button', { name: 'Создать магазин', exact: true }).count(),
                0,
                'Cached authority never exposes a write action after a failed fresh check',
              );
              await page.getByRole('button', { name: 'Повторить', exact: true }).click();
              await page
                .getByRole('alert')
                .filter({ hasText: 'Не удалось обновить магазин.' })
                .waitFor();
              assert.deepEqual(await page.evaluate(() => window.__nativeReads), []);
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
              );
              console.log(`${width}/${theme}/${scenario}: passed`);
              continue;
            }
            if (scenario === 'first_server_pending') {
              await page
                .getByText('Результат создания ещё не подтверждён.', { exact: true })
                .waitFor({ timeout: 3000 });
              assert.equal(
                await page.getByRole('button', { name: /^Магазин участников/ }).count(),
                0,
              );
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
            } else {
              await page
                .getByRole('button', { name: /^Магазин участников/ })
                .click({ timeout: 3000 });
              await page
                .getByRole('textbox', { name: 'Название магазина', exact: true })
                .waitFor({ timeout: 3000 });
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
              );
              await page
                .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
                .check();
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).click();
            }
            if (scenario === 'first_lost_response') {
              await page
                .getByText('Ответ потерян', {
                  exact: true,
                })
                .waitFor();
              await page.reload();
              await page
                .getByText('Результат создания ещё не подтверждён.', { exact: true })
                .waitFor({ timeout: 3000 });
              assert.equal(
                await page.getByRole('button', { name: /^Магазин участников/ }).count(),
                0,
              );
              const originalId = await page.evaluate(
                () => JSON.parse(sessionStorage.getItem('operation')).operationId,
              );
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
              await page.waitForFunction(() =>
                window.__karavanRequests.some((item) => item.path.endsWith('/setup')),
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body
                      .operationId,
                ),
                originalId,
              );
            }
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
              .waitFor();
            const requests = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.endsWith('/setup')),
            );
            assert.equal(requests.length, 1, 'Only the explicit setup action dispatches');
            if (scenario === 'first_server_pending')
              assert.equal(requests[0].body.operationId, 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10');
            assert.deepEqual(
              await page.evaluate(() => window.__nativeReads),
              [],
              'First setup uses server recovery without native storage',
            );
            assert.deepEqual(
              await page.evaluate(() => window.__nativeWrites),
              [],
              'Unread native evidence is never overwritten',
            );
            await page.reload();
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
              .waitFor();
            assert.equal(
              await page.evaluate(() => Number(sessionStorage.getItem('setups'))),
              scenario === 'first_lost_response' ? 2 : 1,
              'Reopening never creates another shop',
            );
            assert.deepEqual(errors, []);
            await geometry(page, scenario);
            await page.screenshot({
              path: output + '/' + width + '-' + theme + '-' + scenario + '.png',
              fullPage: true,
            });
            console.log(`${width}/${theme}/${scenario}: passed`);
            continue;
          }
          if (scenario === 'legacy_multichat') {
            await page.getByRole('textbox', { name: 'Название магазина', exact: true }).waitFor();
            assert.equal(
              await page
                .getByRole('textbox', { name: 'Название магазина', exact: true })
                .inputValue(),
              'Соседи',
            );
            assert.equal(await page.getByText('Другие чаты', { exact: true }).count(), 0);
            assert.deepEqual(
              await page.evaluate(
                () => JSON.parse(localStorage.getItem('karavan-setup-draft:v1:777:-123')).chatIds,
              ),
              ['-123', '-456'],
            );
            await page.waitForFunction(
              () =>
                JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create') || 'null')
                  ?.chatIds.length === 1,
            );
          }
          if (scenario === 'draft_invitation') {
            await page.getByText('Продавцы: по приглашению', { exact: true }).waitFor();
            assert.equal(
              await page.getByRole('radio', { name: 'По приглашению', exact: true }).count(),
              0,
            );
            await page.getByText('Продавцы: по приглашению', { exact: true }).click();
            assert.equal(
              await page.getByRole('radio', { name: 'По приглашению', exact: true }).isChecked(),
              true,
            );
            await page.getByText('Продавцы: по приглашению', { exact: true }).click();
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await page.getByRole('button', { name: 'Создать магазин', exact: true }).click();
            await page.waitForFunction(() =>
              window.__karavanRequests.some((item) => item.path.endsWith('/setup')),
            );
            const create = await page.evaluate(
              () =>
                window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body.create,
            );
            assert.equal(
              create.admissionPolicy,
              'invitation',
              'A saved invitation draft remains invitation-based without requiring another choice',
            );
          }
          if (
            ['draft_wrong_intent', 'draft_mirror_conflict', 'draft_native_stall'].includes(scenario)
          ) {
            if (scenario === 'draft_wrong_intent')
              await page.getByRole('button', { name: /^Магазин участников/ }).click();
            const name = page.getByRole('textbox', { name: 'Название магазина', exact: true });
            await name.waitFor();
            assert.equal(
              await name.inputValue(),
              scenario === 'draft_wrong_intent' ? 'Соседи' : 'Сохранённый ввод',
            );
            await name.fill('Мой актуальный ввод');
            assert.equal(
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).count(),
              1,
            );
            assert.equal(
              await page
                .getByRole('button', { name: 'Повторить проверку настроек', exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
            if (scenario !== 'draft_wrong_intent') {
              assert.deepEqual(
                await page.evaluate(() => window.__nativeReads),
                [],
                'Optional native drafts do not veto current browser input',
              );
              assert.deepEqual(await page.evaluate(() => window.__nativeWrites), []);
            }
            assert.equal(await name.inputValue(), 'Мой актуальный ввод');
          }
          if (scenario === 'pending_reload') {
            await page
              .getByRole('button', { name: 'Продолжить подключение', exact: true })
              .waitFor();
            await page.waitForTimeout(1500);
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
              'restoring pending setup only reads status until explicit continuation',
            );
            await page.reload();
            await page
              .getByRole('button', { name: 'Продолжить подключение', exact: true })
              .waitFor();
            await page.waitForTimeout(1500);
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
              'reload never automatically posts a pending setup',
            );
            await page.getByRole('button', { name: 'Продолжить подключение', exact: true }).click();
            await page.waitForFunction(
              () =>
                window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length ===
                1,
            );
            await page.getByRole('button', { name: 'Продолжить подключение', exact: true }).click();
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
              .waitFor();
            const commands = await page.evaluate(() =>
              window.__karavanRequests
                .filter((item) => item.path.endsWith('/setup'))
                .map((item) => item.body),
            );
            assert.equal(commands.length, 2);
            assert.deepEqual(commands[0], commands[1]);
            assert.equal(commands[0].operationId, 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10');
          }
          if (scenario === 'server_restore') {
            await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Настроить черновик' }).count(), 0);
            assert.equal(
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
          }
          if (scenario === 'error') {
            await page
              .getByRole('alert')
              .filter({ hasText: 'Не удалось обновить магазин.' })
              .waitFor();
            await page.getByRole('button', { name: 'Повторить', exact: true }).click();
          }
          if (scenario === 'cancel_actor_switch') {
            const cancel = page.getByRole('button', {
              name: 'Остановить оставшиеся подключения',
              exact: true,
            });
            await cancel.waitFor();
            page.once('dialog', (dialog) => dialog.accept());
            await cancel.click();
            await page.waitForFunction(
              () => window.__rejectCancellation && window.__pendingMutations === 1,
            );
            await page.evaluate(() => window.__switchKaravanActor());
            await page.getByRole('heading', { name: marketplaceName(), exact: true }).waitFor();
            await page.evaluate(() => window.__rejectCancellation());
            await page.waitForFunction(() => window.__pendingMutations === 0);
            assert.equal(
              await page.getByText('Запоздавшая ошибка отмены', { exact: true }).count(),
              0,
              'A failed cancellation cannot add an error to another actor',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/cancel')).length,
              ),
              1,
            );
            assert.equal(await page.getByRole('button', { name: 'Управлять магазином', exact: true }).isDisabled(), false);
            assert.deepEqual(errors, []);
            await geometry(page, scenario);
            await page.screenshot({
              path: output + '/' + width + '-' + theme + '-' + scenario + '.png',
              fullPage: true,
            });
            console.log(`${width}/${theme}/${scenario}: passed`);
            continue;
          }
          if (['setup_simple', 'setup_actor_switch'].includes(scenario)) {
            await page.getByRole('textbox', { name: 'Название магазина', exact: true }).waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/available'))
                    .length,
              ),
              0,
              'Ordinary creation does not load an existing shop selector',
            );
            assert.equal(
              await page.getByRole('button', { name: 'Подключить магазин', exact: true }).count(),
              0,
            );
            assert.equal(
              await page
                .getByRole('button', { name: 'Подключить существующий магазин', exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page
                .getByRole('textbox', { name: 'Название магазина', exact: true })
                .inputValue(),
              'Соседи',
            );
            await page.getByText('Продавцы: все желающие', { exact: true }).waitFor();
            assert.equal(
              await page.getByRole('radio', { name: 'Все желающие', exact: true }).count(),
              0,
            );
            await page
              .getByText('Витрины появляются после вашего одобрения.', { exact: true })
              .waitFor();
            assert.equal(
              await page
                .getByRole('textbox', { name: 'Правила для продавцов', exact: true })
                .isVisible(),
              false,
            );
            assert.equal(
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).isDisabled(),
              true,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await geometry(page, `${width}-${theme}-simple-setup`);
            await page.screenshot({
              path: output + '/' + width + '-' + theme + '-simple-setup.png',
              fullPage: true,
            });
            await page.getByRole('button', { name: 'Создать магазин', exact: true }).click();
            if (scenario === 'setup_actor_switch') {
              await page.waitForFunction(
                () => window.__releaseSetup && window.__pendingMutations === 1,
              );
              const original = await page.evaluate(() =>
                localStorage.getItem('karavan-setup:v1:777:-123'),
              );
              assert.equal(original, null, 'New setup authority lives on the server');
              await page.evaluate(() => window.__switchKaravanActor());
              await page.getByRole('heading', { name: marketplaceName(), exact: true }).waitFor();
              await page.evaluate(() => window.__releaseSetup());
              await page.waitForFunction(() => window.__pendingMutations === 0);
              assert.equal(
                await page.evaluate(() => localStorage.getItem('karavan-setup:v1:777:-123')),
                original,
              );
              assert.equal(
                await page.evaluate(() => localStorage.getItem('karavan-setup:v1:888:-123')),
                null,
                'A late setup response cannot write another actor recovery journal',
              );
              assert.equal(await page.getByRole('button', { name: 'Управлять магазином', exact: true }).isDisabled(), false);
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                1,
              );
              assert.deepEqual(errors, []);
              console.log(`${width}/${theme}/${scenario}: passed`);
              continue;
            }
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
              .waitFor();
            const requests = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.endsWith('/setup')),
            );
            assert.equal(requests.length, 1, 'Immediate setup completion dispatches once');
            assert.equal(new Set(requests.map((item) => item.body.operationId)).size, 1);
            assert.deepEqual(requests[0].body.chatIds, ['-123']);
            assert.equal(requests[0].body.create.name, 'Соседи');
            assert.equal(requests[0].body.create.admissionPolicy, 'applications');
            assert.deepEqual(requests[0].body.create.rules.allowedCategoryIds, [
              'services',
              'grocery',
            ]);
            assert.equal(await page.evaluate(() => window.__karavanOpened.length), 0);
            assert.equal(
              await page
                .getByRole('button', { name: 'Открыть магазин', exact: true })
                .count(),
              0,
            );
          }
          if (['setup', 'unknown', 'partial', 'partial_bound'].includes(scenario)) {
            assert.equal(await page.getByText('Другие чаты', { exact: true }).count(), 0);
            assert.equal(
              await page.getByLabel('Название магазина', { exact: true }).inputValue(),
              'Соседи',
            );
            await page
              .getByLabel('Название магазина', { exact: true })
              .fill('Общий магазин соседей и друзей нашего большого района');
            await page.getByText('Продавцы: все желающие', { exact: true }).click();
            assert.equal(
              await page.getByRole('radio', { name: 'Все желающие', exact: true }).isChecked(),
              true,
            );
            assert.equal(
              await page.getByRole('button', { name: 'Продолжить', exact: true }).count(),
              0,
            );
            assert.equal(await page.getByText(/Шаг \d+ из \d+/u).count(), 0);
            await page.getByText('Категории и правила', { exact: true }).click();
            await page.getByRole('checkbox', { name: 'Продукты', exact: true }).uncheck();
            await page.getByText('Направления · 2 из 2', { exact: true }).click();
            await page.getByRole('checkbox', { name: 'Уборка', exact: true }).uncheck();
            await geometry(page, `${width}-${theme}-rules`);
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await page
              .getByLabel('Название магазина', { exact: true })
              .fill('Общий магазин соседей');
            assert.equal(
              await page
                .getByRole('checkbox', {
                  name: 'Подтверждаю выбранные чаты и правила магазина',
                })
                .isChecked(),
              true,
              'A rename preserves reviewed rules consent',
            );
            await geometry(page, `${width}-${theme}-confirm`);
            await page.screenshot({
              path: output + '/' + width + '-' + theme + '-' + scenario + '-confirm.png',
              fullPage: true,
            });
            await page.getByRole('button', { name: 'Создать магазин', exact: true }).click();
            if (['setup', 'unknown'].includes(scenario))
              await page.getByRole('button', { name: 'Продолжить подключение' }).click();
            if (['partial', 'partial_bound'].includes(scenario)) {
              if (scenario === 'partial_bound') {
                await page.getByRole('button', { name: 'Настроить черновик' }).click();
                const panel = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
                await panel.getByRole('button', { name: 'Управлять магазином', exact: true }).waitFor();
                assert.equal(await page.evaluate(() => window.__karavanOpened.length), 0);
                await panel.getByRole('button', { name: 'Назад' }).waitFor();
                await page.keyboard.press('Escape');
              } else {
                assert.equal(
                  await page.getByRole('button', { name: 'Настроить черновик' }).count(),
                  0,
                );
              }
              await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
              page.once('dialog', (dialog) => dialog.accept());
              await page
                .getByRole('button', { name: 'Остановить оставшиеся подключения', exact: true })
                .click();
              await page
                .getByText('Подключение остановлено. Магазин и подключённые чаты сохранены.', {
                  exact: true,
                })
                .waitFor();
            } else
              await page
                .getByText('Магазин выключен', { exact: true })
                .waitFor();
            const requests = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.endsWith('/setup')),
            );
            assert.ok(requests.length >= (['partial', 'partial_bound'].includes(scenario) ? 1 : 2));
            assert.equal(new Set(requests.map((item) => item.body.operationId)).size, 1);
            assert.deepEqual(requests[0].body.chatIds, ['-123']);
            assert.deepEqual(requests[0].body.create.rules.allowedSubcategoryIds, [
              'services.repair',
            ]);
            assert.equal(requests[0].body.bindingExpectations.length, 1);
            if (['setup', 'unknown'].includes(scenario)) {
              await page.getByRole('button', { name: 'Подключение', exact: true }).click();
              await page.getByRole('button', { name: 'Подключить чаты', exact: true }).click();
              assert.equal(
                await page.getByRole('textbox', { name: 'Название магазина', exact: true }).count(),
                0,
              );
              assert.equal(
                await page
                  .getByRole('button', { name: 'Создать новый магазин', exact: true })
                  .count(),
                0,
              );
              assert.equal(
                await page.getByRole('group', { name: 'Доступные магазины', exact: true }).count(),
                0,
              );
              await page.getByLabel('Ещё один очень длинный заголовок чата наших соседей').check();
              await page
                .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
                .check();
              await page.getByRole('button', { name: 'Подключить чаты', exact: true }).click();
              await page.waitForFunction(() =>
                window.__karavanRequests
                  .filter((item) => item.path.endsWith('/setup'))
                  .some((item) => !!item.body.existingMarketplaceId),
              );
              const add = await page.evaluate(
                () =>
                  window.__karavanRequests
                    .filter((item) => item.path.endsWith('/setup'))
                    .find((item) => !!item.body.existingMarketplaceId).body,
              );
              assert.equal(add.create, undefined);
              assert.equal(add.existingMarketplaceId, 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10');
              assert.deepEqual(add.chatIds, ['-123', '-456']);
              assert.notEqual(add.operationId, requests[0].body.operationId);
            }
          }
          if (
            [
              'existing',
              'existing_unknown',
              'existing_rules_changed',
              'existing_binding_changed',
              'existing_options_error',
            ].includes(scenario)
          ) {
            await page.getByText('Другие варианты', { exact: true }).click();
            await page
              .getByRole('button', { name: 'Подключить существующий магазин', exact: true })
              .click();
            await page.getByRole('radio', { name: marketplaceName(), exact: true }).check();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
            await page
              .getByText('Проверенные правила существующего магазина', { exact: true })
              .waitFor();
            if (scenario === 'existing_options_error') {
              assert.equal(await page.getByText('services', { exact: true }).count(), 0);
              await page.getByText('Услуги', { exact: true }).waitFor();
              await page.getByRole('button', { name: 'Повторить загрузку категорий' }).click();
              await page.waitForFunction(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup-options'))
                    .length === 3,
              );
              await page
                .getByRole('checkbox', {
                  name: 'Подтверждаю выбранные чаты и правила магазина',
                })
                .waitFor();
            }
            if (['existing_rules_changed', 'existing_binding_changed'].includes(scenario)) {
              await page
                .getByRole('checkbox', {
                  name: 'Подтверждаю выбранные чаты и правила магазина',
                })
                .check();
              await page.getByRole('button', { name: 'Подключить', exact: true }).click();
              await page
                .getByText(
                  scenario === 'existing_rules_changed'
                    ? 'Правила изменились. Проверьте их ещё раз.'
                    : 'Подключения изменились. Проверьте выбранные чаты ещё раз.',
                  { exact: true },
                )
                .waitFor();
              if (scenario === 'existing_rules_changed')
                await page
                  .getByText('Обновлённые правила существующего магазина', { exact: true })
                  .waitFor();
              assert.equal(
                await page
                  .getByRole('checkbox', {
                    name: 'Подтверждаю выбранные чаты и правила магазина',
                  })
                  .isChecked(),
                false,
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
              );
              await geometry(page, `${width}-${theme}-updated-rules`);
              await page.screenshot({
                path: output + '/' + width + '-' + theme + '-updated-rules.png',
                fullPage: true,
              });
            }
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await page.getByRole('button', { name: 'Подключить', exact: true }).click();
            if (scenario === 'existing_unknown') {
              await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
              const initial = await page.evaluate(
                () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
              );
              await page.reload();
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
                'reload only reads the submitted existing-shop operation',
              );
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^Открыт/u })
                .waitFor();
              const retried = await page.evaluate(
                () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
              );
              assert.deepEqual(retried, initial, 'reload must preserve immutable existing setup');
            } else {
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^Открыт/u })
                .waitFor();
            }
            const request = await page.evaluate(
              () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
            );
            assert.equal(request.create, undefined);
            if (scenario === 'existing_binding_changed')
              assert.equal(request.bindingExpectations[0].generation, 2);
            assert.equal(
              request.expectedPolicyRevision,
              scenario === 'existing_rules_changed' ? 2 : 1,
            );
          }
          if (scenario === 'choice') {
            await page.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            await page.getByRole('button', { name: 'Вторая витрина', exact: true }).click();
            await page
              .getByText(
                'Выбор сохранён. Повторите $ в чате, когда захотите опубликовать ссылку.',
                { exact: true },
              )
              .waitFor();
            const writes = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.body),
            );
            assert.equal(writes.length, 1);
            assert.ok(writes[0].path.endsWith('/publication-choice'));
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
          }
          if (scenario === 'replace') {
            await page.getByRole('button', { name: 'Подключение', exact: true }).click();
            await page.getByRole('button', { name: 'Выбрать другой магазин', exact: true }).click();
            await page.getByRole('radio', { name: 'Другой магазин', exact: true }).check();
            assert.equal(
              await page.getByRole('radio', { name: marketplaceName(), exact: true }).count(),
              0,
              'Replacement cannot target the current shop',
            );
            assert.equal(
              await page.getByRole('textbox', { name: 'Название магазина', exact: true }).count(),
              0,
            );
            assert.equal(await page.getByText('Другие чаты', { exact: true }).count(), 0);
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await page.getByRole('button', { name: 'Заменить магазин', exact: true }).click();
            await page.getByRole('button', { name: 'Продолжить подключение', exact: true }).click();
            await page.waitForFunction(
              () =>
                window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length >= 2,
            );
            const commands = await page.evaluate(() =>
              window.__karavanRequests
                .filter((item) => item.path.endsWith('/setup'))
                .map((item) => item.body),
            );
            assert.equal(new Set(commands.map((command) => command.operationId)).size, 1);
            assert.ok(
              commands.every(
                (command) =>
                  !command.create &&
                  command.existingMarketplaceId === 'bb669048-0279-4a35-987c-60f94593163e',
              ),
            );
            assert.deepEqual(commands[0].chatIds, ['-123']);
            assert.equal(commands[0].bindingExpectations[0].action, 'transfer_chat');
            assert.equal(commands[0].bindingExpectations[0].generation, 1);
          }
          if (['recovery', 'access_changed', 'recovery_conflict'].includes(scenario)) {
            await page.getByRole('button', { name: 'Восстановить подключение' }).click();
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^Открыт/u })
              .waitFor();
            const body = await page.evaluate(
              () =>
                window.__karavanRequests.find((item) => item.path.endsWith('/connection/binding'))
                  .body,
            );
            assert.equal(body.action, 'recover_chat');
            assert.equal(body.expectedBindingGeneration, 1);
          }
          if (scenario === 'recovery_conflict') {
            assert.equal(
              await page.getByRole('button', { name: 'Восстановить подключение' }).count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) =>
                    item.path.endsWith('/connection/binding'),
                  ).length,
              ),
              1,
              'A conflict refresh must not replay recovery',
            );
            assert.equal(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              null,
            );
          }
          if (scenario === 'disconnect') {
            await page.getByRole('button', { name: 'Подключение', exact: true }).click();
            await page.getByRole('button', { name: 'Отключить этот чат' }).click();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) =>
                    item.path.endsWith('/connection/binding'),
                  ).length,
              ),
              0,
            );
            await page.getByRole('button', { name: 'Подтвердить отключение' }).click();
            await page.getByText('Чат отключён от магазина.').waitFor();
          }
          if (scenario === 'reviewer') {
            await page.getByRole('button', { name: 'Управлять магазином', exact: true }).waitFor();
            assert.equal(
              await page.getByRole('button', { name: 'Категории и правила', exact: true }).count(),
              0,
            );
          }
          await page
            .locator(
              '.karavan-module h3:visible, .karavan-module__wizard:visible, .karavan-module [data-storefront-screen="chats"]:visible',
            )
            .first()
            .waitFor();
          await geometry(page, `${width}-${theme}-${scenario}`);
          if (['active', 'public_view', 'bridge_error'].includes(scenario)) {
            await page
              .getByRole('button', { name: 'Открыть магазин', exact: true })
              .click();
            if (scenario === 'bridge_error') {
              await page
                .getByRole('alert')
                .filter({ hasText: 'Не удалось открыть магазин' })
                .waitFor();
              assert.equal(await page.evaluate(() => window.__karavanClosed), 0);
              await page.evaluate(() => {
                window.__bridgeRetry = true;
              });
              await page.getByRole('button', { name: 'Повторить переход', exact: true }).click();
            }
            await page.waitForFunction(() => window.__karavanOpened.length === 1);
            assert.equal(
              await page.evaluate(() => window.__karavanOpened[0]),
              'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/handoffs')).length,
              ),
              0,
            );
            assert.equal(
              await page.getByRole('button', { name: 'Повторить переход', exact: true }).count(),
              0,
            );
            const beforeReturn = await page.evaluate(() => window.__karavanRequests.length);
            await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
            await page.waitForFunction(
              (before) => window.__karavanRequests.length > before,
              beforeReturn,
            );
          }
          if (['draft', 'draft_empty', 'paused', 'preview_missing'].includes(scenario)) {
            assert.equal(
              await page
                .getByRole('button', { name: /^(Открыть магазин|Управлять магазином)$/u })
                .count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) =>
                      item.body &&
                      !(item.path.endsWith('/manage') && item.body.command?.operation === 'detail'),
                  ).length,
              ),
              0,
              'reading a closed shop must neither activate it nor create a private preview',
            );
          }
          if (scenario === 'switch_chat') {
            await page.evaluate(() => window.__switchKaravanChat());
            await page.getByRole('heading', { name: 'Другой магазин' }).waitFor();
            await page
              .getByRole('button', { name: 'Открыть магазин', exact: true })
              .click();
            assert.deepEqual(await page.evaluate(() => window.__karavanOpened), [
              'https://max.ru/synthetic_buyer_bot?startapp=m_other-shop',
            ]);
          }
          assert.equal(
            await page.locator('.karavan-module__metrics,.karavan-module__eyebrow').count(),
            0,
          );
          assert.equal(
            await page.evaluate(() => window.__karavanClosed),
            0,
            'storefront navigation must not close Major',
          );
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: output + '/' + width + '-' + theme + '-' + scenario + '.png',
            fullPage: true,
          });
          console.log(`${width}/${theme}/${scenario}: passed`);
        } catch (error) {
          console.error(
            `${width}/${theme}/${scenario}: ${page ? (await page.locator('body').innerText()).slice(-2500) : 'Page unavailable'}`,
          );
          throw error;
        } finally {
          await context.close();
        }
      }
    }
  console.log(
    'Karavan browser: ' +
      selectedScenarios.length *
        (process.env.KARAVAN_BROWSER_WIDTH ? 1 : 4) *
        (process.env.KARAVAN_BROWSER_THEME ? 1 : 2) +
      ' scenarios passed. Screenshots: ' +
      output,
  );
} finally {
  await browser?.close();
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
function marketplaceName() {
  return 'Магазин соседей — длинное название для проверки переноса';
}
