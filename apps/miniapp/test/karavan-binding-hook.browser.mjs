import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const scenarios = [
  'success',
  'server-unknown',
  'status-unavailable',
  'status-not-found',
  'superseded',
  'rejected',
  'actor-success',
  'actor-error',
  'lost-response',
  'missing-capability',
  'legacy-import',
];
const selected = process.env.KARAVAN_BINDING_SCENARIOS?.split(',') ?? scenarios;
assert.ok(
  selected.length && selected.every((name) => scenarios.includes(name)),
  'Unknown binding scenario',
);
const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/binding-hook-`);
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
await writeFile(
  `${fixture}/index.html`,
  '<html><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  `${fixture}/fixture.tsx`,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useKaravanMarketplaceBinding} from '../../../src/pages/settings/use-karavan-marketplace-binding';
import {ApiRequestError} from '../../../src/lib/api-request-error';
const scenario=new URLSearchParams(location.search).get('scenario');
const market='11111111-1111-4111-8111-111111111111';
const originalId='22222222-2222-4222-8222-222222222222';
const nextId='33333333-3333-4333-8333-333333333333';
const legacy={marketplaceId:market,commandId:originalId,expectedBindingGeneration:1,action:'recover_chat'};
const makeOperation=(id,state='unknown')=>({operationId:id,state,request:{...legacy,commandId:id,expectedConnectionRevision:4},result:state==='complete'?{bindingId:market,generation:2}:null,errorCode:state==='superseded'?'KARAVAN_CONNECTION_SUPERSEDED':null});
const snapshot=operation=>({version:2,revision:4,blocked:false,operation:operation?{kind:'binding',operation}:null});
const initialPending=['server-unknown','status-unavailable','status-not-found','superseded'].includes(scenario);
let server=snapshot(initialPending?makeOperation(originalId):null);
window.__bindingCalls=[];window.__nativeReads=[];window.__nativeWrites=[];
const bridge=window.MAX?.WebApp??window.WebApp;
bridge.initData='fixture-init-data';
bridge.DeviceStorage={getItem:async(key)=>{window.__nativeReads.push(key);return {value:scenario==='legacy-import'?JSON.stringify(legacy):null};},setItem:async(key)=>{window.__nativeWrites.push(key);return {};},removeItem:async(key)=>{window.__nativeWrites.push(key);return {};}};
if(scenario==='legacy-import')localStorage.setItem('karavan-binding:v1:777:-123',JSON.stringify(legacy));
const api={requestKeepalive(){},async request(path,init={}){
  const input=init.body?JSON.parse(init.body):null;
  window.__bindingCalls.push({path,input,method:init.method??'GET'});
  if(path.endsWith('/connection'))return server;
  if(path.endsWith('/resume')){
    const operation={...server.operation.operation,state:'complete',result:{bindingId:market,generation:2}};server=snapshot(operation);return operation;
  }
  if(path.includes('/connection/operations/')){
    if(scenario==='status-unavailable')throw new ApiRequestError(503,'','Проверка недоступна');
    if(scenario==='status-not-found')throw new ApiRequestError(404,'','Результат пока недоступен');
    if(scenario==='superseded'){const operation=makeOperation(originalId,'superseded');server=snapshot(operation);return operation;}
    return server.operation.operation;
  }
  if(path.endsWith('/import-binding')){const operation={...makeOperation(input.commandId),request:input};server=snapshot(operation);return operation;}
  if(!path.endsWith('/connection/binding'))throw new Error('Unexpected endpoint '+path);
  const operation={...makeOperation(input.commandId,scenario==='rejected'?'rejected':'complete'),request:input};
  if(scenario==='lost-response'){server=snapshot({...operation,state:'unknown',result:null});throw new Error('Ответ потерян');}
  if(scenario.startsWith('actor-'))await new Promise((resolve,reject)=>{window.__releaseBinding=()=>scenario==='actor-error'?reject(new Error('Ответ потерян')):resolve();});
  server=snapshot(operation);return operation;
}};
function Harness(){
  const[actor,setActor]=React.useState('777');
  const[connection,setConnection]=React.useState(scenario==='missing-capability'?undefined:server);
  const mounted=React.useRef(crypto.randomUUID());
  const binding=useKaravanMarketplaceBinding(api,'-123',actor,{chatId:'-123',generation:1},false,connection);
  window.__bindingHook=binding;window.__bindingState={actor,mounted:mounted.current,...binding};
  window.__switchBindingActor=()=>{server=snapshot(makeOperation(nextId));setConnection(server);setActor('888');};
  window.__startBinding=()=>binding.start({marketplaceId:market,expectedBindingGeneration:1,action:'unbind_chat'});
  return null;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><Harness/></QueryClientProvider>);
`,
);

let server;
let browser;
try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch({ headless: true });
  for (const scenario of selected) {
    const context = await browser.newContext();
    const errors = [];
    try {
      await installMaxBridgeShimInitScript(context, { platform: 'android' });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}?scenario=${scenario}`);
      await page.waitForFunction(() => window.__bindingState?.hydrated);
      const mounted = await page.evaluate(() => window.__bindingState.mounted);
      assert.deepEqual(
        await page.evaluate(() => window.__nativeReads),
        [],
        'Mount never consults native recovery',
      );
      assert.deepEqual(
        await page.evaluate(() => window.__bindingCalls),
        [],
        'Mount never dispatches or resumes',
      );
      const posts = () =>
        page.evaluate(() => window.__bindingCalls.filter((call) => call.method === 'POST'));
      if (scenario === 'missing-capability') {
        assert.equal(await page.evaluate(() => window.__bindingState.supported), false);
        await page.evaluate(() => window.__startBinding());
        assert.deepEqual(
          await posts(),
          [],
          'Unknown server capability cannot authorize a new write',
        );
      } else if (scenario === 'legacy-import') {
        assert.equal(await page.evaluate(() => window.__bindingState.request), null);
        await page.evaluate(() => window.__bindingHook.inspectLegacy());
        await page.waitForFunction(() => window.__bindingState.legacyRecovery?.status === 'ready');
        assert.deepEqual(await posts(), [], 'Inspecting evidence has no provider effect');
        await page.evaluate(() => window.__bindingHook.importLegacy());
        await page.waitForFunction(() =>
          window.__bindingCalls.some((call) => call.path.endsWith('/import-binding')),
        );
        const imported = await posts();
        assert.equal(imported.length, 1);
        assert.equal(imported[0].input.commandId, '22222222-2222-4222-8222-222222222222');
        assert.ok(
          await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
          'Import preserves historical evidence',
        );
      } else if (
        ['server-unknown', 'status-unavailable', 'status-not-found', 'superseded'].includes(
          scenario,
        )
      ) {
        assert.equal(
          await page.evaluate(() => window.__bindingState.request.commandId),
          '22222222-2222-4222-8222-222222222222',
        );
        await page.evaluate(() => window.__bindingHook.refresh());
        await page.waitForFunction(() =>
          window.__bindingCalls.some((call) => call.path.includes('/operations/')),
        );
        assert.deepEqual(await posts(), [], 'Checking status is read-only');
        if (scenario === 'server-unknown') {
          await page.evaluate(() => window.__bindingHook.resume());
          await page.waitForFunction(() => window.__bindingState.request === null);
          const resumed = await posts();
          assert.equal(resumed.length, 1);
          assert.ok(resumed[0].path.endsWith('/22222222-2222-4222-8222-222222222222/resume'));
          assert.equal(
            resumed[0].input,
            null,
            'Resume refers to the stored request without a replacement payload',
          );
        } else if (scenario === 'superseded') {
          await page.waitForFunction(() => window.__bindingState.operation?.state === 'superseded');
          assert.equal(await page.evaluate(() => window.__bindingState.request), null);
          assert.ok(await page.evaluate(() => window.__bindingState.notice));
        } else {
          await page.waitForFunction(() => !!window.__bindingState.error);
          assert.equal(
            await page.evaluate(() => window.__bindingState.request.commandId),
            '22222222-2222-4222-8222-222222222222',
          );
          assert.equal(
            await page.evaluate(() => window.__bindingState.blocked),
            true,
            'Missing or unavailable receipt does not release uncertainty',
          );
        }
      } else {
        if (scenario.startsWith('actor-')) {
          await page.evaluate(() => {
            void window.__startBinding();
          });
        } else {
          await page.evaluate(() => window.__startBinding());
        }
        await page.waitForFunction(() => window.__bindingCalls.length > 0);
        if (scenario.startsWith('actor-')) {
          await page.waitForFunction(() => !!window.__releaseBinding);
          await page.evaluate(() => window.__switchBindingActor());
          await page.waitForFunction(
            () =>
              window.__bindingState.request?.commandId === '33333333-3333-4333-8333-333333333333',
          );
          await page.evaluate(() => window.__releaseBinding());
          await page.waitForFunction(() => !window.__bindingState.isPending);
          assert.equal(
            await page.evaluate(() => window.__bindingState.request.commandId),
            '33333333-3333-4333-8333-333333333333',
          );
          assert.equal(
            await page.evaluate(() => window.__bindingState.error),
            null,
            'Late actor A result cannot overwrite actor B',
          );
          assert.equal((await posts()).length, 1);
        } else if (scenario === 'lost-response') {
          await page.waitForFunction(
            () => !!window.__bindingState.error && !window.__bindingState.isPending,
          );
          const original = (await posts())[0].input;
          assert.equal(original.expectedConnectionRevision, 4);
          await page.evaluate(() => window.__bindingHook.retry());
          assert.deepEqual(
            (await posts())[1].input,
            original,
            'A lost admission response retains the exact original payload and revision',
          );
          await page.evaluate(() => window.__bindingHook.refresh());
          assert.equal(
            await page.evaluate(() => window.__bindingState.request.commandId),
            original.commandId,
          );
          await page.evaluate(() => window.__bindingHook.resume());
          await page.waitForFunction(() => window.__bindingState.request === null);
          const writes = await posts();
          assert.equal(writes.length, 3);
          assert.ok(writes[2].path.endsWith(`/${original.commandId}/resume`));
          assert.equal(
            writes[2].input,
            null,
            'The original operation supplies its admitted revision',
          );
        } else {
          if (scenario === 'rejected') {
            await page.waitForFunction(() => window.__bindingState.rejected);
            await page.evaluate(() => window.__bindingHook.resetRejected());
          }
          await page.waitForFunction(
            () => !window.__bindingState.isPending && window.__bindingState.request === null,
          );
          assert.equal(await page.evaluate(() => window.__bindingState.rejected), false);
          assert.equal((await posts()).length, 1);
          if (scenario === 'success') {
            const first = (await posts())[0].input;
            await page.evaluate(() => window.__startBinding());
            await page.waitForFunction(
              () => !window.__bindingState.isPending && window.__bindingCalls.length === 2,
            );
            assert.notEqual(
              (await posts())[1].input.commandId,
              first.commandId,
              'A new action receives a new identity',
            );
          }
        }
      }
      assert.equal(
        await page.evaluate(() => window.__bindingState.mounted),
        mounted,
        'Scope fencing works in one mounted hook',
      );
      assert.deepEqual(
        await page.evaluate(() => window.__nativeWrites),
        [],
        'Server recovery never rewrites native evidence',
      );
      assert.deepEqual(errors, []);
      console.log(`Binding server recovery ${scenario}: passed`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
