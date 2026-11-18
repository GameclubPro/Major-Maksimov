import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeOnlineClientCiCompose } from './multibot-online-client-ci-fixture.mjs';
import {
  createOutcomeCohortOnlineClientLauncher,
  createRoutingIndexOnlineClientLauncher,
  multibotOnlineClientCreateArgs,
  verifyMultibotOnlineClientConfiguration,
  verifyMultibotOnlineClientImage,
  verifyMultibotOnlineClientNetwork,
} from './multibot-online-client.mjs';
import {
  readOutcomeCohortState,
  runOutcomeCohortCommand as run,
} from './outcome-cohort-online-state.mjs';
import { OUTCOME_COHORT_TARGETS } from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import { ROUTING_INDEX_TARGET } from '../../scripts/agent/routing-index-online-target.mjs';
import { readRoutingIndexState } from './routing-index-online-state.mjs';

async function drive(
  directory,
  project,
  sourceRoot,
  imageId,
  bootstrapTag,
  deleteTag,
  recipientTag,
  routingBootstrapTag,
  routingTag,
) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.match(project, /^multibot_ci_[a-f0-9]{32}$/u);
  const compose = [
    '--env-file',
    resolve(directory, 'ci.env'),
    '-p',
    project,
    '-f',
    resolve(directory, 'compose.json'),
    '-f',
    resolve(directory, 'overlay.json'),
  ];
  const json = async (args) => JSON.parse((await run('docker', args)).stdout);
  const config = verifyMultibotOnlineClientConfiguration(
    await json(['compose', ...compose, 'config', '--format', 'json']),
    compose,
    process.env.MAXIM_EXPECTED_DEPLOY_SHA,
  );
  const actualImage = verifyMultibotOnlineClientImage(
    (await json(['image', 'inspect', config.imageRef]))[0],
    process.env.MAXIM_EXPECTED_DEPLOY_SHA,
  );
  assert.equal(actualImage, imageId);
  const networkId = verifyMultibotOnlineClientNetwork(
    (await json(['network', 'inspect', config.networkName]))[0],
    config,
  );
  const args = multibotOnlineClientCreateArgs(bootstrapTag, {
    imageId,
    networkId,
    networkName: config.networkName,
  });
  // FLAG: CI-only disposable bootstrap runs genuine prerequisite migrations. This fixed
  // source snippet never reaches the production launcher or fabricates receipt history.
  const bootstrap = `const fs=require('node:fs');const cp=require('node:child_process');
(async()=>{const {createOutcomeCohortMigrationPrefix}=await import('./scripts/agent/outcome-cohort-online-prepare.mjs');
const p=createOutcomeCohortMigrationPrefix('/app','delete');try{
fs.rmSync(p.tempRoot+'/migrations/${OUTCOME_COHORT_TARGETS[0].migration}',{recursive:true});
const r=cp.spawnSync(process.execPath,['/app/node_modules/prisma/build/index.js','migrate','deploy','--config',p.configPath],{stdio:'ignore',timeout:120000});
if(r.status!==0)process.exitCode=1;
}finally{fs.rmSync(p.tempRoot,{recursive:true,force:true});}})().catch(()=>{process.exitCode=1});`;
  await run('docker', [...args.slice(0, -1), '-e', bootstrap], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  });
  await run('docker', ['start', '--attach', bootstrapTag], { timeout: 130_000 });
  assert.deepEqual((await readOutcomeCohortState(compose, { root: sourceRoot })).pending, [
    'delete',
    'recipient',
  ]);
  const start = (command, args, options) => spawn(command, args, { ...options, stdio: 'ignore' });
  const assertIsolation = (container, command) => {
    assert.equal(container.State.Status, 'created');
    assert.equal(container.Image, imageId);
    assert.equal(container.Config.User, '1000:1000');
    assert.deepEqual(container.Config.Cmd, command);
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 500_000_000);
    assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
    assert.equal(
      container.Mounts.some((mount) => mount.Type === 'bind'),
      false,
    );
    assert.equal(
      container.Config.Env.some((value) => value.startsWith('MAX_BOT_TOKEN=')),
      false,
    );
    assert.equal(Object.keys(container.HostConfig.Tmpfs).length, 2);
  };
  for (const [selector, tag] of [
    ['delete', deleteTag],
    ['recipient', recipientTag],
  ]) {
    const launcher = await createOutcomeCohortOnlineClientLauncher(compose, selector, { start });
    await launcher.prepare(tag);
    const container = (await json(['container', 'inspect', tag]))[0];
    assertIsolation(container, ['scripts/agent/outcome-cohort-online-prepare.mjs', selector]);
    const child = launcher.start(tag);
    const exit = await new Promise((done) => {
      child.once('error', () => done(1));
      child.once('exit', (code) => done(code));
    });
    assert.equal(exit, 0, `Fixed ${selector} image runner failed`);
    assert.equal(
      (await readOutcomeCohortState(compose, { root: sourceRoot })).pending.includes(selector),
      false,
    );
  }
  assert.equal(
    (await readOutcomeCohortState(compose, { root: sourceRoot })).state,
    'already_applied',
  );
  console.log(
    'OUTCOME_COHORT_CLIENT_CI_PASSED; real image, immutable migrations, receipts and isolation; admission timing is covered separately.',
  );

  // FLAG: This second CI-only prefix applies genuine prerequisites, leaving only
  // the fixed routing migration for its production image entrypoint.
  const routingBootstrap = `const fs=require('node:fs');const cp=require('node:child_process');
(async()=>{const {createRoutingIndexMigrationPrefix}=await import('./scripts/agent/routing-index-online-prepare.mjs');
const p=createRoutingIndexMigrationPrefix('/app');try{
fs.rmSync(p.tempRoot+'/migrations/${ROUTING_INDEX_TARGET.migration}',{recursive:true});
const r=cp.spawnSync(process.execPath,['/app/node_modules/prisma/build/index.js','migrate','deploy','--config',p.configPath],{stdio:'ignore',timeout:120000});
if(r.status!==0)process.exitCode=1;
}finally{fs.rmSync(p.tempRoot,{recursive:true,force:true});}})().catch(()=>{process.exitCode=1});`;
  const routingArgs = multibotOnlineClientCreateArgs(routingBootstrapTag, {
    imageId,
    networkId,
    networkName: config.networkName,
  });
  await run('docker', [...routingArgs.slice(0, -1), '-e', routingBootstrap], {
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  });
  await run('docker', ['start', '--attach', routingBootstrapTag], { timeout: 130_000 });
  const beforeRouting = await readRoutingIndexState(compose, { root: sourceRoot });
  assert.equal(beforeRouting.state, 'prepare_routing');
  assert.deepEqual(beforeRouting.pending, ['routing']);
  const routingLauncher = await createRoutingIndexOnlineClientLauncher(compose, 'routing', {
    start,
  });
  await routingLauncher.prepare(routingTag);
  assertIsolation((await json(['container', 'inspect', routingTag]))[0], [
    'scripts/agent/routing-index-online-prepare.mjs',
  ]);
  const routingExit = await new Promise((done) => {
    const child = routingLauncher.start(routingTag);
    child.once('error', () => done(1));
    child.once('exit', (code) => done(code));
  });
  assert.equal(routingExit, 0, 'Fixed routing image runner failed');
  const afterRouting = await readRoutingIndexState(compose, { root: sourceRoot });
  assert.equal(afterRouting.state, 'already_applied');
  assert.deepEqual(afterRouting.pending, []);
  console.log(
    'ROUTING_INDEX_CLIENT_CI_PASSED; real image, immutable migration, receipt and isolation.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'compose' && args.length === 4) writeOnlineClientCiCompose(...args);
    else if (mode === 'run' && args.length === 10) await drive(...args);
    else throw Error('invalid fixture arguments');
  } catch {
    console.error('OUTCOME_COHORT_CLIENT_CI_FAILED');
    process.exitCode = 1;
  }
}
