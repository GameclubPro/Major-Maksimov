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
const key=actor=>'karavan-binding:v1:'+actor+':-123';
const oldRequest={marketplaceId:market,commandId:'22222222-2222-4222-8222-222222222222',expectedBindingGeneration:1,action:'recover_chat'};
const nextRequest={...oldRequest,commandId:'33333333-3333-4333-8333-333333333333'};
if(scenario==='superseded') localStorage.setItem(key('777'),JSON.stringify(oldRequest));
if(scenario.startsWith('actor-')) localStorage.setItem(key('888'),JSON.stringify(nextRequest));
window.__bindingAttempts=[];
const marketplace={id:market,networkId:market,publicSlug:'binding-test',name:'Магазин',description:null,kind:'chat',status:'active',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1};
const api={requestKeepalive(){},async request(path,init){
  const input=JSON.parse(init.body);
  window.__bindingAttempts.push({path,input});
  if(window.__bindingAttempts.length===1){
    if(scenario==='conflict') throw new ApiRequestError(409,JSON.stringify({code:'MARKETPLACE_BINDING_CHANGED'}),'Изменилось подключение');
    if(scenario==='rejected') throw new ApiRequestError(403,JSON.stringify({code:'KARAVAN_COMMAND_REJECTED'}),'Отклонено');
    if(scenario==='recovery-disabled') throw new Error('Response lost');
    if(scenario.startsWith('actor-')) await new Promise((resolve,reject)=>{window.__releaseBinding=()=>scenario==='actor-error'?reject(new Error('Response lost')):resolve();});
  }
  return {marketplace,bindingId:market,generation:2};
}};
function Harness(){
  const [actor,setActor]=React.useState('777');
  const mounted=React.useRef(crypto.randomUUID());
  const binding=useKaravanMarketplaceBinding(api,'-123',actor,scenario==='superseded'?{chatId:'-123',generation:2}:undefined);
  window.__bindingHook=binding;
  window.__bindingState={actor,mounted:mounted.current,...binding};
  window.__switchBindingActor=()=>setActor('888');
  window.__disableBindingRecovery=()=>setActor(undefined);
  window.__enableBindingRecovery=()=>setActor('777');
  window.__startBinding=()=>binding.start({marketplaceId:market,expectedBindingGeneration:scenario==='superseded'?2:1,action:'unbind_chat'});
  return null;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}><Harness/></QueryClientProvider>);
`,
);

let server;
let browser;
try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch({ headless: true });
  for (const scenario of [
    'success',
    'conflict',
    'rejected',
    'superseded',
    'actor-success',
    'actor-error',
    'recovery-disabled',
  ]) {
    const context = await browser.newContext();
    const errors = [];
    try {
      await installMaxBridgeShimInitScript(context, { platform: 'web' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}?scenario=${scenario}`);
      await page.waitForFunction(() => window.__bindingState?.hydrated);
      const mounted = await page.evaluate(() => window.__bindingState.mounted);
      if (scenario === 'superseded') {
        await page.waitForFunction(() => window.__bindingState.request === null);
        assert.equal(await page.evaluate(() => window.__bindingAttempts.length), 0);
      } else {
        await page.evaluate(() => window.__startBinding());
        await page.waitForFunction(() => window.__bindingAttempts.length === 1);
        if (scenario.startsWith('actor-')) {
          await page.evaluate(() => window.__switchBindingActor());
          await page.waitForFunction(
            () =>
              window.__bindingState.request?.commandId === '33333333-3333-4333-8333-333333333333',
          );
          const original = await page.evaluate(() =>
            localStorage.getItem('karavan-binding:v1:888:-123'),
          );
          await page.evaluate(() => window.__releaseBinding());
          await page.waitForFunction(() => !window.__bindingState.isPending);
          assert.equal(
            await page.evaluate(() => localStorage.getItem('karavan-binding:v1:888:-123')),
            original,
            'A response cannot delete B recovery evidence',
          );
          assert.equal(
            await page.evaluate(() => window.__bindingState.request.commandId),
            '33333333-3333-4333-8333-333333333333',
          );
          assert.equal(
            await page.evaluate(() => window.__bindingState.error),
            null,
            'A response cannot change B recovery state',
          );
          assert.ok(
            await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            'Keep evidence outside the current scope',
          );
          await page.evaluate(() => window.__bindingHook.retry());
          await page.waitForFunction(
            () => window.__bindingAttempts.length === 2 && !window.__bindingState.isPending,
          );
          assert.equal(
            await page.evaluate(() => window.__bindingAttempts[1].input.commandId),
            '33333333-3333-4333-8333-333333333333',
          );
        } else if (scenario === 'recovery-disabled') {
          await page.waitForFunction(() => !window.__bindingState.isPending);
          assert.ok(await page.evaluate(() => window.__bindingState.error));
          const original = await page.evaluate(() =>
            localStorage.getItem('karavan-binding:v1:777:-123'),
          );
          const commandId = await page.evaluate(() => window.__bindingState.request.commandId);
          await page.evaluate(() => window.__disableBindingRecovery());
          await page.waitForFunction(
            () =>
              window.__bindingState.actor === undefined &&
              window.__bindingState.request === null &&
              window.__bindingState.error === null &&
              !window.__bindingState.isPending,
          );
          assert.equal(
            await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            original,
            'Daily management hides the recovery state while preserving its evidence',
          );
          await page.evaluate(() => window.__enableBindingRecovery());
          await page.waitForFunction(
            (id) =>
              window.__bindingState.hydrated && window.__bindingState.request?.commandId === id,
            commandId,
          );
          assert.equal(await page.evaluate(() => window.__bindingState.error), null);
          assert.equal(await page.evaluate(() => window.__bindingAttempts.length), 1);
          await page.evaluate(() => window.__bindingHook.retry());
          await page.waitForFunction(
            () => window.__bindingAttempts.length === 2 && !window.__bindingState.isPending,
          );
          assert.equal(
            await page.evaluate(() => window.__bindingAttempts[1].input.commandId),
            commandId,
            'Explicit continuation sends only the original unknown request',
          );
        } else {
          await page.waitForFunction(() => !window.__bindingState.isPending);
          if (scenario === 'rejected') {
            assert.equal(await page.evaluate(() => window.__bindingState.rejected), true);
            await page.evaluate(() => window.__bindingHook.resetRejected());
          }
          await page.waitForFunction(() => window.__bindingState.request === null);
        }
      }
      if (!scenario.startsWith('actor-') && scenario !== 'recovery-disabled') {
        const previous = await page.evaluate(() => window.__bindingAttempts.length);
        await page.evaluate(() => window.__startBinding());
        await page.waitForFunction(
          (count) =>
            window.__bindingAttempts.length === count + 1 && !window.__bindingState.isPending,
          previous,
        );
        const commands = await page.evaluate(() =>
          window.__bindingAttempts.map(({ input }) => input),
        );
        assert.equal(
          new Set(commands.map(({ commandId }) => commandId)).size,
          commands.length,
          'New actions get distinct identities',
        );
        assert.ok(
          commands.every(({ action }) => action === 'unbind_chat'),
          'An obsolete recovery request is never replayed',
        );
      }
      assert.equal(
        await page.evaluate(() => window.__bindingState.mounted),
        mounted,
        'Actions share the same mounted hook',
      );
      assert.deepEqual(errors, []);
      console.log(`Binding hook ${scenario}: passed`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
