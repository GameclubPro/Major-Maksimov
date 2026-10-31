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
  'setup_actor_switch',
  'legacy_multichat',
  'draft_wrong_intent',
  'draft_invitation',
  'draft_mirror_conflict',
  'draft_native_stall',
  'journal_corrupt',
  'journal_server_conflict',
  'journal_native_stall',
  'journal_not_registered',
  'journal_fenced_not_registered',
  'pending_reload',
  'draft',
  'draft_empty',
  'paused',
  'preview_missing',
  'public_view',
  'switch_chat',
  'bridge_error',
  'active',
  'binding_storage_error',
  'setup_storage_error',
  'setup_storage_error_after_publications',
  'setup_storage_error_after_publications_stall',
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
  'recovery_conflict_unknown',
  'recovery_conflict_superseded',
  'recovery_restored_superseded',
  'recovery_restored_current',
  'recovery_restored_unavailable',
  'recovery_restored_cached',
  'recovery_restored_actor_switch',
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
import {loadShopCommandJournal,reserveShopCommand,settleShopCommand} from '../../../src/pages/settings/karavan-shop/command-journal';
import {prepareShopRequest} from '../../../src/lib/api/karavan-shop-client';
const scenario = new URLSearchParams(location.search).get('scenario');
document.documentElement.dataset.maxTheme = new URLSearchParams(location.search).get('theme') || 'light';
document.body.dataset.miniappProfile = 'moderation';
Object.assign(document.body.style,{margin:'0',padding:'20px 16px',background:'var(--color-surface)',fontFamily:'var(--font-body)'});
const uuid='a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const marketplace={id:uuid,networkId:'c41eba17-407e-4e51-b23c-1dd3edca4e63',publicSlug:'synthetic-shop',name:'Магазин соседей — длинное название для проверки переноса',description:null,kind:'chat',status:scenario==='paused'?'paused':['active','existing','existing_unknown','existing_rules_changed','existing_binding_changed','existing_options_error','choice','public_view','switch_chat','bridge_error'].includes(scenario)?'active':'draft',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1};
const binding={id:'9c9e1a8e-533f-49f8-9d5e-2bbad494bb74',chatId:'-123',chatTitle:'Соседи',state:scenario==='recovery'?'revoked':'verified',generation:1,revision:1,verifiedAt:new Date().toISOString()};
let connected=['active','draft','draft_empty','paused','preview_missing','public_view','switch_chat','bridge_error','recovery','recovery_conflict','recovery_conflict_unknown','recovery_restored_superseded','recovery_restored_current','access_changed','disconnect','reviewer','choice','replace'].includes(scenario); let reads=0; let setups=Number(sessionStorage.getItem('setups')||0); let operation=JSON.parse(sessionStorage.getItem('operation')||'null'); let chosen=false; let optionReads=0; let previewReads=0; let recovered=false;
let moduleActor='777';
if(scenario.startsWith('recovery_restored_')) {
  connected=true; marketplace.status='active'; binding.generation=['recovery_restored_current','recovery_restored_actor_switch'].includes(scenario)?1:2;
  if(!sessionStorage.getItem('restored-seeded')) {
    localStorage.setItem('karavan-binding:v1:777:-123',JSON.stringify({marketplaceId:uuid,commandId:'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedBindingGeneration:1,action:'recover_chat'}));
    sessionStorage.setItem('restored-seeded','yes');
    if(scenario==='recovery_restored_actor_switch') localStorage.setItem('karavan-binding:v1:888:-123',JSON.stringify({marketplaceId:uuid,commandId:'c0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedBindingGeneration:2,action:'recover_chat'}));
  }
}
if(scenario==='recovery_conflict_superseded') connected=true;
if(scenario==='server_restore') { const request={operationId:uuid,chatIds:['-123','-456'],create:{name:'Сохранённый магазин',rules:{text:'Rules',allowedCategoryIds:['services'],allowedSubcategoryIds:[]}}}; operation={operationId:uuid,state:'partial',request,checkpoints:{marketplaceId:uuid,bindings:request.chatIds.map(chatId=>({chatId,state:'failed',bindingId:null,generation:null}))}}; }
window.__karavanRequests=[]; window.__karavanOpened=[]; window.__karavanClosed=0; window.WebApp={openMaxLink:(url)=>{if(scenario==='bridge_error'&&!window.__bridgeRetry) throw new Error('Bridge unavailable');window.__karavanOpened.push(url)},close:()=>{window.__karavanClosed++}};
if(scenario.includes('_storage_error')) {
  connected=true;marketplace.status='active';marketplace.name='Нет';
  window.__storageReady=scenario.includes('_after_publications');
  const affectedKey=scenario==='binding_storage_error'?'karavan-binding:v1:777:-123':'karavan-setup:v1:777:-123';
  window.__nativeWrites=[];window.__nativeReads=[];
  window.__nativeCopies={[affectedKey]:JSON.stringify(affectedKey.startsWith('karavan-binding:')?{marketplaceId:uuid,commandId:'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedBindingGeneration:1,action:'recover_chat'}:{operationId:uuid,chatIds:['-123'],existingMarketplaceId:uuid,expectedPolicyRevision:1})};
  document.documentElement.dataset.maxClient='native';window.WebApp.initData='fixture-init-data';
  window.WebApp.DeviceStorage={
    getItem:async(key)=>{window.__nativeReads.push(key);if(key===affectedKey&&!window.__storageReady){if(scenario.endsWith('_stall'))return new Promise(()=>{});throw {error:{code:'client.device_storage_get_key.not_found'}};}return {value:window.__nativeCopies[key]??null};},
    setItem:async(key)=>{window.__nativeWrites.push(key);return {};},
    removeItem:async(key)=>{window.__nativeWrites.push(key);return {};},
  };
}
const draftKey='karavan-setup-draft:v2:777:-123:create';
const savedDraft={mode:'new',existingId:null,name:'Сохранённый ввод',rules:'Правила',categories:['services'],subcategories:['services.repair'],initialized:true,admissionPolicy:'applications',chatIds:['-123']};
const journalKey='karavan-setup:v1:777:-123';
const journalRequest={operationId:uuid,chatIds:['-123'],existingMarketplaceId:uuid,expectedPolicyRevision:1};
if(scenario==='pending_reload') {
  operation={operationId:uuid,state:'pending',request:journalRequest,checkpoints:{marketplaceId:uuid,bindings:[{chatId:'-123',state:'pending',bindingId:null,generation:null}]}};
  localStorage.setItem(journalKey,JSON.stringify(journalRequest));
}
if(scenario.startsWith('journal_')) {
  operation={operationId:uuid,state:'partial',request:journalRequest,checkpoints:{marketplaceId:uuid,bindings:[{chatId:'-123',state:'failed',bindingId:null,generation:null}]}};
  localStorage.setItem(journalKey,scenario==='journal_corrupt'?'{broken':JSON.stringify(scenario==='journal_server_conflict'?{...journalRequest,operationId:'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10'}:journalRequest));
  window.__repairJournal=()=>localStorage.setItem(journalKey,JSON.stringify(journalRequest));
}
if(scenario==='journal_fenced_not_registered') {
  const scope={actorMaxUserId:'777',chatId:'-123',marketplaceId:uuid,expectedBindingGeneration:1};
  const request=prepareShopRequest(scope,{operation:'status',input:{commandId:'d0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedRevision:1,status:'active',allowEmpty:false}});
  await reserveShopCommand(scope,request,{owner:'prepared-daily-action',page:'home'});
  window.__readPreparedDaily=()=>loadShopCommandJournal(scope);
  window.__clearPreparedDaily=async()=>settleShopCommand(await loadShopCommandJournal(scope),null);
}
if(scenario==='legacy_multichat') localStorage.setItem('karavan-setup-draft:v1:777:-123',JSON.stringify({...savedDraft,chatIds:['-123','-456']}));
if(scenario==='draft_wrong_intent') localStorage.setItem(draftKey,JSON.stringify({...savedDraft,mode:'existing',existingId:uuid}));
if(scenario==='draft_invitation') localStorage.setItem(draftKey,JSON.stringify({...savedDraft,admissionPolicy:'invitation'}));
if(['draft_mirror_conflict','draft_native_stall'].includes(scenario)) localStorage.setItem(draftKey,JSON.stringify(savedDraft));
if(['draft_mirror_conflict','draft_native_stall','journal_native_stall'].includes(scenario)) {
  const affectedKey=scenario==='journal_native_stall'?journalKey:draftKey;
  const initialNative=JSON.stringify(scenario==='journal_native_stall'?journalRequest:{...savedDraft,name:'Вторая копия ввода'});
  window.__nativeCopies={[affectedKey]:initialNative}; window.__nativeWrites=[];
  document.documentElement.dataset.maxClient='native';
  window.WebApp.initData='fixture-init-data';
  window.WebApp.DeviceStorage={
    getItem:(key)=>{const value=window.__nativeCopies[key]??null;if(scenario.endsWith('_native_stall')&&key===affectedKey&&!window.__storageReady)return new Promise(resolve=>{window.__finishNative=()=>{window.__storageReady=true;resolve({value});}});return Promise.resolve({value});},
    setItem:async(key,value)=>{window.__nativeWrites.push(key);window.__nativeCopies[key]=value;return {};},
    removeItem:async(key)=>{window.__nativeWrites.push(key);delete window.__nativeCopies[key];return {};},
  };
}
const api={request:async(path,init={})=>{
  window.__karavanRequests.push({path,body:init.body?JSON.parse(init.body):null});
  if(path.endsWith('/manage')) {
    const {command}=JSON.parse(init.body);
    if(command.operation==='status'&&scenario.includes('_storage_error')) throw new Error('Ответ потерян');
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
  if(path.includes('/bindings/')) {
    if(scenario==='existing_unknown'&&!sessionStorage.getItem('bind-attempted')) {sessionStorage.setItem('bind-attempted','yes'); throw new Error('Ответ потерян');}
    if(['recovery_conflict_unknown','recovery_conflict_superseded'].includes(scenario)&&!sessionStorage.getItem('bind-attempted')) {sessionStorage.setItem('bind-attempted','yes');throw new Error('Ответ потерян');}
    if(scenario.startsWith('recovery_conflict')) {recovered=true;binding.generation=scenario==='recovery_conflict_unknown'?1:2;marketplace.status='active';throw new ApiRequestError(409,JSON.stringify({code:'MARKETPLACE_BINDING_CHANGED'}),'Подключение изменилось');}
    const input=JSON.parse(init.body); recovered=input.action==='recover_chat'; connected=true; marketplace.status=input.action==='unbind_chat'?'paused':'active'; binding.state=input.action==='unbind_chat'?'disconnected':'verified';
    return {marketplace,bindingId:binding.id,generation:1};
  }
  if(path.endsWith('/setup')) {
    const input=JSON.parse(init.body); setups++;sessionStorage.setItem('setups',String(setups));
    const complete=scenario==='setup_simple'||setups>1;
    operation={operationId:input.operationId,state:complete?'complete':'pending',request:input,checkpoints:{marketplaceId:uuid,bindings:input.chatIds.map(chatId=>({chatId,state:complete?'connected':'pending',bindingId:binding.id,generation:1}))}};
    if(['partial','partial_bound'].includes(scenario)) { operation.state='partial'; connected=scenario==='partial_bound'; operation.checkpoints.bindings.forEach(item=>item.state=connected&&item.chatId==='-123'?'connected':'failed'); return operation; }
    sessionStorage.setItem('operation',JSON.stringify(operation));
    if(['unknown','existing_unknown'].includes(scenario)&&setups===1) throw new Error('Сеть недоступна');
    if(complete) { connected=true;if(scenario==='replace') Object.assign(marketplace,{id:input.existingMarketplaceId,name:'Другой магазин'}); }
    if(scenario==='setup_actor_switch') await new Promise(resolve=>{window.__releaseSetup=resolve;});
    return operation;
  }
  if(path.includes('/operations/')&&path.endsWith('/cancel')) {operation.state='cancelled';sessionStorage.setItem('operation',JSON.stringify(operation));return operation;}
  if(path.includes('/operations/')&&['journal_not_registered','journal_fenced_not_registered'].includes(scenario)) throw new ApiRequestError(403,'','Подключение недоступно.');
  if(path.includes('/operations/')) return operation;
  if(scenario==='error' && reads++===0) throw new Error('Сеть недоступна');
  if(scenario==='loading') await new Promise(resolve=>setTimeout(resolve,800));
  if(scenario==='recovery_restored_unavailable'&&!sessionStorage.getItem('restored-allow-read')) throw new Error('Проверка временно недоступна');
  return {enabled:true,actorMaxUserId:moduleActor,sellerBotUrl:'https://max.ru/synthetic_seller_bot',setupOperation:scenario.includes('_after_publications')&&!window.__storageReady?{operationId:uuid,state:'partial',request:journalRequest,checkpoints:{marketplaceId:uuid,bindings:[]}}:['server_restore','journal_server_conflict','journal_native_stall'].includes(scenario)?operation:null,currentChatTitle:'Соседи',buyerUrl:connected?'https://max.ru/synthetic_buyer_bot?startapp=m_'+(path.includes('/-456/')?'other-shop':'synthetic-shop'):null,previewUrl:connected&&scenario!=='preview_missing'&&['draft','paused'].includes(marketplace.status)?'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop':null,bindings:connected?[binding]:[],publicationChoices:scenario==='choice'&&!chosen?[{id:uuid,marketplaceId:uuid,marketplaceName:marketplace.name,chatId:'-123',expiresAt:new Date(Date.now()+900000).toISOString(),stores:[{id:uuid,name:'Первая витрина'},{id:'bb669048-0279-4a35-987c-60f94593163e',name:'Вторая витрина'}]}]:[],marketplace:connected?(path.includes('/-456/')?{...marketplace,name:'Другой магазин'}:marketplace):null,binding:connected?binding:null,access:{reason:!recovered&&(scenario==='access_changed'||scenario==='recovery'||scenario.startsWith('recovery_conflict'))?'binding_changed':scenario==='public_view'?'forbidden':'allowed',canRecover:!recovered&&(scenario==='recovery'||scenario==='access_changed'||scenario.startsWith('recovery_conflict'))},permissions:scenario==='public_view'||(!recovered&&scenario==='access_changed')?[]:scenario==='reviewer'?['review_listing']:['manage_network','bind_chat','manage_marketplace','review_listing'],counts:{listings:connected&&scenario!=='draft_empty'?12:0,pendingApplications:connected&&scenario!=='draft_empty'?3:0,chats:connected?2:0},canManage:scenario!=='reviewer'};
},requestKeepalive:()=>{}};
function Harness(){window.__pendingMutations=useIsMutating();const [chatId,setChatId]=React.useState('-123');window.__switchKaravanChat=()=>setChatId('-456');return <StorefrontWorkspace key={chatId} open onClose={()=>{}} dirty={scenario.includes('_after_publications')} footer={<button onClick={()=>{window.__publicationSaves=(window.__publicationSaves??0)+1;}}>Сохранить ответ бота</button>}><Panel api={api} chatId={chatId} publications={<p>Настройки ответа бота</p>}/></StorefrontWorkspace>;}
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.__readPreparedDaily=()=>loadShopCommandJournal({actorMaxUserId:'777',chatId:'-123',marketplaceId:uuid,expectedBindingGeneration:binding.generation});
window.__failStorage=()=>{window.__storageReady=false;return queryClient.invalidateQueries({queryKey:['karavan-marketplace','-123']});};
window.__switchKaravanActor=()=>{moduleActor='888';binding.generation=2;if(scenario==='setup_actor_switch')connected=true;return queryClient.invalidateQueries({queryKey:['karavan-marketplace','-123']});};
if(scenario==='recovery_restored_cached') {
  const snapshot=await api.request('/chats/-123/karavan-marketplace');
  queryClient.setQueryData(['karavan-marketplace','-123'],{...snapshot,binding:{...binding,generation:1}});
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
          if (scenario.includes('_storage_error')) {
            await page
              .getByRole('heading', { name: 'Нет', exact: true })
              .waitFor({ timeout: 3000 });
            assert.deepEqual(
              await page.evaluate(() => window.__nativeReads),
              [],
              'Opening a verified shop does not read connection recovery',
            );
            assert.equal(await page.getByText(/сохранённое подключение/).count(), 0);
            const originalCopies = await page.evaluate(() => window.__nativeCopies);
            await page
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.__karavanOpened.length), 1);
            await page.getByRole('button', { name: 'Настройки', exact: true }).click();
            assert.equal(
              await page.getByRole('radio', { name: 'По приглашению', exact: true }).isDisabled(),
              false,
            );
            await page.getByRole('button', { name: 'Объявления в чате', exact: true }).click();
            const publicationSave = page.getByRole('button', {
              name: 'Сохранить ответ бота',
              exact: true,
            });
            if (scenario.includes('_after_publications')) {
              await publicationSave.waitFor();
              await page.evaluate(() => window.__failStorage());
              assert.equal(
                await publicationSave.isVisible(),
                true,
                'Connection recovery does not close the independent publication editor',
              );
              await publicationSave.click();
              assert.equal(await page.evaluate(() => window.__publicationSaves), 1);
            }
            assert.deepEqual(await page.evaluate(() => window.__nativeReads), []);
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Оформление', exact: true }).click();
            const appearanceName = page.getByRole('textbox', { name: 'Название', exact: true });
            await appearanceName.fill('Несохранённое оформление');
            await appearanceName.evaluate((node) => {
              window.__appearanceInput = node;
            });
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            const pause = page.getByRole('button', { name: 'Приостановить магазин', exact: true });
            await page.waitForFunction(
              () =>
                ![...document.querySelectorAll('button')].find(
                  (el) => el.textContent.trim() === 'Приостановить магазин',
                )?.disabled,
            );
            await pause.click();
            await pause.click();
            await page.waitForFunction(() =>
              window.__karavanRequests.some((item) => item.body?.command?.operation === 'status'),
            );
            const daily = await page.evaluate(() => window.__readPreparedDaily());
            assert.ok(daily?.pending, 'A lost daily response keeps the durable command');
            assert.equal(daily.pending.dispatchCount, 1);
            assert.deepEqual(await page.evaluate(() => window.__nativeReads), []);
            await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
            await page
              .getByRole('button', { name: 'Повторить проверку подключения', exact: true })
              .waitFor();
            assert.equal(
              await page.getByRole('button', { name: 'Подключить чаты', exact: true }).count(),
              0,
            );
            assert.deepEqual(await page.evaluate(() => window.__nativeCopies), originalCopies);
            assert.deepEqual(await page.evaluate(() => window.__nativeWrites), []);
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Оформление', exact: true }).click();
            assert.equal(await appearanceName.inputValue(), 'Несохранённое оформление');
            assert.equal(
              await appearanceName.evaluate((node) => node === window.__appearanceInput),
              true,
              'Connection recovery keeps the visited editor mounted with its unsaved draft',
            );
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
            await page.evaluate(() => {
              window.__storageReady = true;
            });
            await page
              .getByRole('button', { name: 'Повторить проверку подключения', exact: true })
              .click();
            const retry = page.getByRole('button', {
              name: scenario.startsWith('binding_')
                ? 'Повторить проверку'
                : 'Продолжить подключение',
              exact: true,
            });
            await retry.waitFor();
            await retry.click();
            await page
              .getByText('Сначала продолжите сохранённое действие в магазине чата.', {
                exact: true,
              })
              .waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
              'Recovery never dispatches an entry command while a daily command is pending',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body?.command?.operation === 'status',
                  ).length,
              ),
              1,
            );
            assert.deepEqual(await page.evaluate(() => window.__nativeCopies), originalCopies);
            assert.deepEqual(await page.evaluate(() => window.__nativeWrites), []);
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            assert.equal(
              await pause.isDisabled(),
              true,
              'Independent daily uncertainty remains blocked',
            );
            assert.equal(
              (await page.evaluate(() => window.__readPreparedDaily())).pending.id,
              daily.pending.id,
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
            await page
              .getByRole('button', { name: 'Повторить проверку настроек', exact: true })
              .waitFor();
            const original = await page.evaluate(() =>
              localStorage.getItem('karavan-setup-draft:v2:777:-123:create'),
            );
            assert.ok(original);
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
            if (scenario !== 'draft_wrong_intent')
              assert.deepEqual(await page.evaluate(() => window.__nativeWrites), []);
            await page.getByRole('button', { name: 'Начать без черновика', exact: true }).click();
            await page.getByRole('textbox', { name: 'Название магазина', exact: true }).waitFor();
            assert.equal(
              await page
                .getByRole('textbox', { name: 'Название магазина', exact: true })
                .inputValue(),
              'Соседи',
            );
            await page.waitForFunction(
              () =>
                JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create') || 'null')
                  ?.name === 'Соседи',
            );
            if (scenario === 'draft_native_stall') {
              await page.evaluate(() => window.__finishNative());
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              assert.equal(
                await page
                  .getByRole('textbox', { name: 'Название магазина', exact: true })
                  .inputValue(),
                'Соседи',
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    JSON.parse(localStorage.getItem('karavan-setup-draft:v2:777:-123:create')).name,
                ),
                'Соседи',
                'A late native read cannot replace the explicitly restarted draft',
              );
            }
          }
          if (scenario.startsWith('journal_')) {
            await page
              .getByRole('button', { name: 'Повторить проверку подключения', exact: true })
              .waitFor();
            const original = await page.evaluate(() =>
              localStorage.getItem('karavan-setup:v1:777:-123'),
            );
            assert.ok(original);
            assert.equal(
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).count(),
              0,
            );
            assert.equal(
              await page.getByRole('button', { name: 'Начать без черновика', exact: true }).count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
            if (scenario === 'journal_native_stall') {
              assert.deepEqual(await page.evaluate(() => window.__nativeWrites), []);
              await page.evaluate(() => window.__finishNative());
              await page.evaluate(
                () =>
                  new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  ),
              );
              await page
                .getByRole('button', { name: 'Повторить проверку подключения', exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(() => localStorage.getItem('karavan-setup:v1:777:-123')),
                original,
              );
              assert.equal(
                await page
                  .getByRole('button', { name: 'Продолжить подключение', exact: true })
                  .count(),
                0,
              );
            }
            if (['journal_not_registered', 'journal_fenced_not_registered'].includes(scenario)) {
              if (scenario === 'journal_fenced_not_registered') {
                const pending = await page.evaluate(() => window.__readPreparedDaily());
                await page
                  .getByRole('button', { name: 'Продолжить подключение', exact: true })
                  .click();
                await page.waitForFunction(
                  () =>
                    window.__karavanRequests.some((item) => item.path.endsWith('/setup')) ||
                    [...document.querySelectorAll('[role="alert"]')].some((element) =>
                      element.textContent.includes('Сначала продолжите сохранённое действие'),
                    ),
                );
                assert.equal(
                  await page.evaluate(
                    () =>
                      window.__karavanRequests.filter((item) => item.path.endsWith('/setup'))
                        .length,
                  ),
                  0,
                  'recovery continuation cannot bypass an unresolved daily command',
                );
                assert.equal(
                  (await page.evaluate(() => window.__readPreparedDaily())).pending.id,
                  pending.pending.id,
                );
                assert.equal(
                  await page.evaluate(() => localStorage.getItem('karavan-setup:v1:777:-123')),
                  original,
                );
                await page.evaluate(() => window.__clearPreparedDaily());
              }
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
              await page.waitForFunction(() =>
                window.__karavanRequests.some((item) => item.path.endsWith('/setup')),
              );
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .click();
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
                .waitFor();
              const commands = await page.evaluate(() =>
                window.__karavanRequests
                  .filter((item) => item.path.endsWith('/setup'))
                  .map((item) => item.body),
              );
              assert.ok(commands.length >= 1);
              assert.ok(
                commands.every(
                  (command) =>
                    command.operationId === 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10' &&
                    !command.create,
                ),
              );
            } else {
              if (scenario !== 'journal_native_stall')
                await page.evaluate(() => window.__repairJournal());
              await page
                .getByRole('button', { name: 'Повторить проверку подключения', exact: true })
                .click();
              await page
                .getByRole('button', { name: 'Продолжить подключение', exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
                'Recovery reads never replay a submitted setup',
              );
            }
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
            await page.getByText('Не удалось проверить магазин.').waitFor();
            await page.getByRole('button', { name: 'Повторить', exact: true }).click();
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
              assert.ok(original);
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
              await page.getByRole('button', { name: 'Настройки', exact: true }).click();
              assert.equal(
                await page.getByRole('radio', { name: 'Все желающие', exact: true }).isDisabled(),
                false,
              );
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
                .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
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
                await panel.getByRole('button', { name: 'Товары и услуги', exact: true }).waitFor();
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
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^(Черновик|Закрыт для покупателей)/u })
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
              await page.getByRole('button', { name: 'Настройки', exact: true }).click();
              await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
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
            await page.getByRole('button', { name: 'Настройки', exact: true }).click();
            await page.getByRole('button', { name: 'Объявления в чате', exact: true }).click();
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
            await page.getByRole('button', { name: 'Настройки', exact: true }).click();
            await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
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
              () => window.__karavanRequests.find((item) => item.path.includes('/bindings/')).body,
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
                  window.__karavanRequests.filter((item) => item.path.includes('/bindings/'))
                    .length,
              ),
              1,
              'A conflict refresh must not replay recovery',
            );
            assert.equal(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              null,
            );
          }
          if (['recovery_conflict_unknown', 'recovery_conflict_superseded'].includes(scenario)) {
            await page.getByRole('button', { name: 'Восстановить подключение' }).click();
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
            if (scenario === 'recovery_conflict_unknown') {
              await page.getByText('Подключение изменилось', { exact: true }).waitFor();
              assert.equal(
                await page.getByRole('button', { name: 'Обновить состояние', exact: true }).count(),
                0,
                'An earlier unknown result at the same generation remains fenced',
              );
              assert.ok(
                await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              );
            } else {
              await page
                .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                .waitFor();
              assert.equal(
                await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
                null,
              );
            }
            const writes = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.includes('/bindings/')),
            );
            assert.equal(writes.length, 2);
            assert.equal(writes[0].body.commandId, writes[1].body.commandId);
          }
          if (scenario === 'recovery_restored_unavailable') {
            await page
              .getByRole('alert')
              .filter({ hasText: 'Не удалось проверить магазин.' })
              .waitFor();
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
            );
            await page.evaluate(() => {
              sessionStorage.setItem('restored-allow-read', 'yes');
            });
            await page.getByRole('button', { name: 'Повторить', exact: true }).click();
          }
          if (scenario.startsWith('recovery_restored_')) {
            await page
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .waitFor();
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              'Opening daily management leaves connection evidence untouched',
            );
            await page.getByRole('button', { name: 'Настройки', exact: true }).click();
            await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
          }
          if (
            [
              'recovery_restored_superseded',
              'recovery_restored_cached',
              'recovery_restored_unavailable',
            ].includes(scenario)
          ) {
            await page.waitForFunction(
              () => localStorage.getItem('karavan-binding:v1:777:-123') === null,
            );
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Назад', exact: true }).click();
            await page
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
              'Restored obsolete request must not send a mutation',
            );
            await page.reload();
            await page
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
            );
          }
          if (scenario === 'recovery_restored_current') {
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
              'A current uncertain request must not be replayed or discarded',
            );
          }
          if (scenario === 'recovery_restored_actor_switch') {
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            await page.evaluate(() => window.__switchKaravanActor());
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              'Keep the previous actor request',
            );
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:888:-123')),
              'Never clear the next actor request using a previous actor state',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter(
                    (item) => item.body && !item.path.endsWith('/manage'),
                  ).length,
              ),
              0,
            );
          }
          if (scenario === 'disconnect') {
            await page.getByRole('button', { name: 'Настройки', exact: true }).click();
            await page.getByRole('button', { name: 'Подключённые чаты', exact: true }).click();
            await page.getByRole('button', { name: 'Отключить этот чат' }).click();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.includes('/bindings/'))
                    .length,
              ),
              0,
            );
            await page.getByRole('button', { name: 'Подтвердить отключение' }).click();
            await page.getByText('Чат отключён от магазина.').waitFor();
          }
          if (scenario === 'reviewer') {
            await page.getByRole('button', { name: 'Заявки', exact: true }).waitFor();
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
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
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
                .getByRole('button', { name: /^(Посмотреть магазин чата|Предпросмотр)$/u })
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
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
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
