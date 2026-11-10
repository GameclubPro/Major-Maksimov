import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  attestSupportModel,
  createSupportController,
  supportFileHash,
  supportMatchesProcess,
  supportPrivateFile,
  supportPreviousModelArgs,
  supportProcessIdentity,
  supportVerifyArtifact,
  supportVerifyBundle,
  warmSupportModel,
} from './support-llm-workstation.mjs';
import { SUPPORT_MODEL, supportModelArgs } from './support-llm-profile.mjs';
import { SUPPORT_CHAT_IDS } from './support-chat-worker.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-support-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function previousBundleFixture(
  t,
  { modelSha256 = 'c'.repeat(64), profileSha256 = modelSha256 } = {},
) {
  const root = fixture(t),
    state = join(root, 'service'),
    bundle = join(state, 'bundles', 'a'.repeat(64)),
    binary = join(bundle, 'runtime/llama-b11804/llama-server'),
    installation = join(state, 'installation.json');
  mkdirSync(join(bundle, 'runtime/llama-b11804'), { recursive: true });
  writeFileSync(
    join(bundle, 'support-llm-profile.mjs'),
    `export const SUPPORT_MODEL = { sha256: ${JSON.stringify(profileSha256)} };
export const supportModelArgs = () => ['60'];\n`,
  );
  for (const name of ['support-llm-workstation.mjs', 'support-chat-worker.mjs'])
    writeFileSync(join(bundle, name), 'setInterval(() => {}, 1000);\n');
  // A real harmless executable gives the orphan test an exact kernel-observed argv.
  copyFileSync('/bin/sleep', binary);
  chmodSync(binary, 0o700);
  const files = {};
  for (const name of [
    'support-llm-profile.mjs',
    'support-llm-workstation.mjs',
    'support-chat-worker.mjs',
    'runtime/llama-b11804/llama-server',
  ])
    files[name] = { sha256: digest(readFileSync(join(bundle, name))) };
  writeFileSync(join(bundle, 'files.json'), JSON.stringify(files));
  const installed = {
    version: 1,
    bundle,
    node: process.execPath,
    manifestSha256: digest(readFileSync(join(bundle, 'files.json'))),
    modelSha256,
  };
  writeFileSync(installation, JSON.stringify(installed) + '\n', { mode: 0o600 });
  return { root, state, bundle, binary, installation, installed };
}

async function fixtureProcess(t, executable, args) {
  const child = spawn(executable, args, { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  });
  return child;
}

test('stopped chat status preserves the last finite transport diagnostic', async (t) => {
  const previous = previousBundleFixture(t, { modelSha256: SUPPORT_MODEL.sha256 });
  const diagnostics = {
    lastFailureCode: 'support_clock_skew',
    lastFailureAt: '2026-10-28T12:00:00.000Z',
    lastDisconnectCode: 'support_session_closed',
    lastDisconnectAt: '2026-10-28T12:30:00.000Z',
  };
  writeFileSync(
    join(previous.state, 'chat-status.json'),
    JSON.stringify({
      phase: 'stopped',
      heartbeatAt: diagnostics.lastDisconnectAt,
      ...diagnostics,
    }),
    { mode: 0o600 },
  );
  const status = await createSupportController({ root: previous.root }).status(true);
  assert.equal(status.running, false);
  assert.equal(status.ready, false);
  for (const [key, value] of Object.entries(diagnostics)) assert.equal(status[key], value);
});

test('live chat status requires fresh observations for every authorized chat', async (t) => {
  const previous = previousBundleFixture(t, { modelSha256: SUPPORT_MODEL.sha256 });
  const child = await fixtureProcess(t, process.execPath, [
    join(previous.bundle, 'support-chat-worker.mjs'),
    'run',
  ]);
  const identity = supportProcessIdentity(child.pid);
  const now = Date.now(),
    stamp = new Date(now).toISOString();
  const record = {
    ...identity,
    bundle: previous.bundle,
    phase: 'connected',
    heartbeatAt: stamp,
    chats: Object.fromEntries(
      SUPPORT_CHAT_IDS.map((chatId) => [
        chatId,
        {
          phase: 'connected',
          lastSampleAt: stamp,
          remoteHeartbeatAt: stamp,
        },
      ]),
    ),
  };
  const statusPath = join(previous.state, 'chat-status.json');
  const controller = createSupportController({ root: previous.root });
  writeFileSync(statusPath, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await controller.status(true)).ready, true);
  record.chats[SUPPORT_CHAT_IDS[2]].lastSampleAt = new Date(now - 31_000).toISOString();
  writeFileSync(statusPath, JSON.stringify(record));
  assert.equal((await controller.status(true)).ready, false);
  delete record.chats[SUPPORT_CHAT_IDS[2]];
  writeFileSync(statusPath, JSON.stringify(record));
  assert.equal((await controller.status(true)).ready, false);
});

async function tinyController(source, root, gpuRoot, bin, modelText, filename) {
  mkdirSync(source);
  for (const name of [
    'support-llm-workstation.mjs',
    'support-llm-client.mjs',
    'support-llm-provider.mjs',
    'support-llm-routing.mjs',
    'support-llm-guides.mjs',
    'support-llm-knowledge.json',
    'support-chat-worker.mjs',
  ])
    copyFileSync(new URL(`./${name}`, import.meta.url), join(source, name));
  const model = {
    ...SUPPORT_MODEL,
    filename,
    alias: filename,
    bytes: Buffer.byteLength(modelText),
    sha256: digest(modelText),
  };
  writeFileSync(
    join(source, 'support-llm-profile.mjs'),
    `export const SUPPORT_MODEL = ${JSON.stringify(model)};
export const supportModelArgs = (root, key) => ['--model', root + '/' + SUPPORT_MODEL.filename, '--api-key-file', key];\n`,
  );
  // Keep the real artifact-array interface while omitting large runtime archives in this fixture.
  writeFileSync(
    join(source, 'commercial-llm-workstation-profile.mjs'),
    'export const WORKSTATION_ARTIFACTS = [{ name: "unchanged-gpu-fixture" }];\n',
  );
  const { createSupportController: factory } = await import(
    pathToFileURL(join(source, 'support-llm-workstation.mjs')).href
  );
  return { model, controller: factory({ root, gpuRoot, bin, source }) };
}

test('artifact checks refuse symlinks, partial downloads and equal-length corrupt weights', async (t) => {
  const root = fixture(t),
    path = join(root, 'weights.gguf');
  const expected = { bytes: 6, sha256: digest('pinned') };
  writeFileSync(path, 'pinned');
  await supportVerifyArtifact(path, expected);
  assert.equal(await supportFileHash(path), expected.sha256);
  writeFileSync(path, 'pin');
  await assert.rejects(supportVerifyArtifact(path, expected), /support_artifact_identity/u);
  writeFileSync(path, 'drift!');
  await assert.rejects(supportVerifyArtifact(path, expected), /support_artifact_identity/u);
  symlinkSync(path, join(root, 'link.gguf'));
  await assert.rejects(
    supportVerifyArtifact(join(root, 'link.gguf'), expected),
    /support_artifact_identity/u,
  );
});

test('immutable bundle verification binds the manifest, complete file set and link targets', async (t) => {
  const root = fixture(t),
    bundle = join(root, 'bundle');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = true;');
  const files = { 'client.mjs': { sha256: await supportFileHash(join(bundle, 'client.mjs')) } };
  writeFileSync(join(bundle, 'files.json'), JSON.stringify(files));
  const manifestHash = await supportFileHash(join(bundle, 'files.json'));
  await supportVerifyBundle(bundle, manifestHash);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = false;');
  await assert.rejects(supportVerifyBundle(bundle, manifestHash), /support_bundle_file_changed/u);
  writeFileSync(join(bundle, 'client.mjs'), 'export const safe = true;');
  writeFileSync(join(bundle, 'unrecorded'), 'x');
  await assert.rejects(supportVerifyBundle(bundle, manifestHash), /support_bundle_files_changed/u);
  rmSync(join(bundle, 'unrecorded'));
  symlinkSync('../outside', join(bundle, 'escape'));
  files.escape = { target: '../outside' };
  writeFileSync(join(bundle, 'files.json'), JSON.stringify(files));
  await assert.rejects(
    supportVerifyBundle(bundle, manifestHash),
    /support_bundle_manifest_changed/u,
  );
  await assert.rejects(supportVerifyBundle(bundle), /support_bundle_link_changed/u);
});

test('private state refuses group-readable files and symbolic links', (t) => {
  const root = fixture(t),
    path = join(root, 'key');
  writeFileSync(path, 'not-a-real-key', { mode: 0o600 });
  supportPrivateFile(path);
  chmodSync(path, 0o640);
  assert.throws(() => supportPrivateFile(path), /support_private_file_required/u);
  chmodSync(path, 0o600);
  symlinkSync(path, join(root, 'key-link'));
  assert.throws(() => supportPrivateFile(join(root, 'key-link')), /support_private_file_required/u);
});

test('process ownership requires exact PID, start ticks and complete command line', () => {
  const observed = supportProcessIdentity(process.pid);
  assert.ok(observed);
  const record = { pid: process.pid, startTicks: observed.startTicks };
  assert.equal(supportMatchesProcess(record, observed.argv), true);
  assert.equal(
    supportMatchesProcess(
      { ...record, startTicks: String(BigInt(record.startTicks) + 1n) },
      observed.argv,
    ),
    false,
  );
  assert.equal(supportMatchesProcess(record, [...observed.argv, 'run']), false);
  assert.equal(supportMatchesProcess(record, observed.argv.slice(1)), false);
  assert.equal(supportMatchesProcess({ ...record, pid: 1 }, observed.argv, observed), false);
  assert.equal(supportProcessIdentity(-1), null);
});

function modelFetch(patches = {}, calls = []) {
  const bodies = {
    '/health': { status: 'ok' },
    '/v1/models': { data: [{ id: SUPPORT_MODEL.alias }] },
    '/props': {
      total_slots: 1,
      chat_template: 'embedded pinned template',
      default_generation_settings: { n_ctx: SUPPORT_MODEL.context },
    },
    ...patches,
  };
  return async (url, options) => {
    calls.push({ path: url.pathname, options });
    const value = bodies[url.pathname];
    return value instanceof Response ? value : Response.json(value);
  };
}

test('readiness needs loaded health, exact model alias and bounded single-slot context', async () => {
  const calls = [];
  await attestSupportModel('private-test-key', AbortSignal.timeout(1000), modelFetch({}, calls));
  assert.deepEqual(
    calls.map((item) => item.path),
    ['/health', '/v1/models', '/props'],
  );
  assert.ok(
    calls.every(
      (item) =>
        item.options.headers.Authorization === 'Bearer private-test-key' &&
        item.options.redirect === 'error',
    ),
  );
  for (const patch of [
    { '/health': { status: 'loading model' } },
    { '/health': new Response('{}', { status: 503 }) },
    { '/v1/models': { data: [{ id: 'foreign-model' }] } },
    { '/props': { total_slots: 2, chat_template: 'template' } },
    {
      '/props': {
        total_slots: 1,
        chat_template: 'template',
        default_generation_settings: { n_ctx: 65536 },
      },
    },
    { '/props': Response.json({ chat_template: 'x'.repeat(132000) }) },
  ])
    await assert.rejects(
      attestSupportModel('key', AbortSignal.timeout(1000), modelFetch(patch)),
      /support_model_/u,
    );
});

function warmupResponse(patch = {}) {
  return {
    model: SUPPORT_MODEL.alias,
    choices: [{ finish_reason: 'length', message: { content: 'discard this warmup text' } }],
    usage: { prompt_tokens: 1500, completion_tokens: 1 },
    ...patch,
  };
}

test('warmup posts the shared producer payload once and discards generated content', async () => {
  const { knowledge, supportWarmupPayload, SUPPORT_BASELINE_FACTS, SUPPORT_SYSTEM_PROMPT } =
    await import('./support-llm-client.mjs');
  const signal = AbortSignal.timeout(1000),
    calls = [];
  const result = await warmSupportModel('private-test-key', signal, async (url, options) => {
    calls.push({ url, options });
    return Response.json(warmupResponse());
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url.href, `${SUPPORT_MODEL.endpoint}/v1/chat/completions`);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer private-test-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal, signal);
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload, supportWarmupPayload());
  assert.equal(payload.model, SUPPORT_MODEL.alias);
  assert.equal(payload.messages[0].content, SUPPORT_SYSTEM_PROMPT);
  const baseline = JSON.parse(payload.messages[0].content.split('\n').at(-1));
  assert.deepEqual(Object.keys(baseline), ['baselineFacts']);
  assert.deepEqual(baseline.baselineFacts, SUPPORT_BASELINE_FACTS);
  assert.deepEqual(
    baseline.baselineFacts.map((fact) => fact.id),
    ['support-room', 'operator'],
  );
  for (const fact of baseline.baselineFacts) {
    const entry = knowledge.entries.find((item) => item.id === fact.id);
    assert.equal(fact.answer, entry.answer);
    assert.deepEqual(
      fact.links,
      entry.sources.filter((source) =>
        knowledge.officialSources.some((page) => page.url === source),
      ),
    );
  }
  assert.deepEqual(JSON.parse(payload.messages[1].content), {
    verifiedKnowledge: [],
    answerRequirements: [],
    history: [],
    question: '',
    role: 'unknown',
  });
  assert.equal(payload.temperature, 0);
  assert.equal(payload.max_tokens, 1);
  assert.equal(payload.stream, false);
  assert.equal(payload.cache_prompt, true);
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);
  assert.equal('response_format' in payload, false);
  await warmSupportModel('key', signal, async () =>
    Response.json(
      warmupResponse({
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 1500, completion_tokens: 0 },
      }),
    ),
  );
});

test('warmup rejects a foreign model, incomplete finish and invalid token counts without retries', async () => {
  for (const patch of [
    { model: 'foreign-model' },
    { choices: [] },
    { choices: [{ finish_reason: 'length' }, { finish_reason: 'length' }] },
    { choices: [{ finish_reason: null }] },
    { choices: [{ finish_reason: 'tool_calls' }] },
    { usage: undefined },
    { usage: { prompt_tokens: 0, completion_tokens: 1 } },
    { usage: { prompt_tokens: 1.5, completion_tokens: 1 } },
    { usage: { prompt_tokens: 1500, completion_tokens: -1 } },
    { usage: { prompt_tokens: 1500, completion_tokens: 2 } },
    { usage: { prompt_tokens: 1500, completion_tokens: 0.5 } },
  ]) {
    let calls = 0;
    await assert.rejects(
      warmSupportModel('key', AbortSignal.timeout(1000), async () => {
        calls++;
        return Response.json(warmupResponse(patch));
      }),
      /support_model_warmup/u,
    );
    assert.equal(calls, 1);
  }
});

test('warmup keeps HTTP, JSON media type and bounded response guards', async () => {
  for (const response of [
    Response.json({}, { status: 503 }),
    new Response('', { status: 302, headers: { Location: 'https://example.org/' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/plain' } }),
    new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  ])
    await assert.rejects(
      warmSupportModel('key', AbortSignal.timeout(1000), async () => response),
      /support_model_http/u,
    );
  await assert.rejects(
    warmSupportModel('key', AbortSignal.timeout(1000), async () =>
      Response.json(warmupResponse({ extra: 'x'.repeat(132000) })),
    ),
    /support_model_output_limit/u,
  );
});

test('startup cancellation aborts a pending warmup body and never resolves as ready', async () => {
  const controller = new AbortController(),
    reason = new Error('startup budget expired');
  let entered,
    cancelled = false,
    calls = 0,
    completed = false;
  const requested = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = warmSupportModel('key', controller.signal, async (_url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    entered();
    return new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"model":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }).then(() => {
    completed = true;
  });
  await requested;
  assert.equal(completed, false);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(cancelled, true);
  assert.equal(completed, false);
  assert.equal(calls, 1);
  await assert.rejects(
    warmSupportModel('key', controller.signal, async () => {
      calls++;
    }),
    (error) => error === reason,
  );
  assert.equal(calls, 1);
});

test('CPU-only profile isolates GPU and caps context, concurrency, threads and output', () => {
  const args = supportModelArgs('/model-root', '/private/key');
  for (const [flag, value] of [
    ['--device', 'none'],
    ['--n-gpu-layers', '0'],
    ['--host', '127.0.0.1'],
    ['--port', '18085'],
    ['--threads', '8'],
    ['--threads-batch', '8'],
    ['--cache-ram', '1024'],
    ['--checkpoint-min-step', '512'],
    ['--parallel', '1'],
    ['--ctx-size', '4096'],
    ['--n-predict', '384'],
    ['--api-key-file', '/private/key'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--log-disable'));
  assert.ok(args.includes('--no-context-shift'));
  assert.ok(!args.includes('18084'));
});

test('status and stop are inert for a fresh independent support directory', async (t) => {
  const root = fixture(t),
    gpuRoot = join(root, 'existing-gpu');
  mkdirSync(gpuRoot);
  writeFileSync(join(gpuRoot, 'sentinel'), 'existing GPU state');
  const controller = createSupportController({
    root: join(root, 'support'),
    gpuRoot,
    bin: join(root, 'bin'),
  });
  assert.deepEqual(await controller.status(), { installed: false, running: false, ready: false });
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.equal(readFileSync(join(gpuRoot, 'sentinel'), 'utf8'), 'existing GPU state');
});

test('stop refuses a live unrelated process even with its correct PID and start ticks in state', async (t) => {
  const root = fixture(t),
    state = join(root, 'service'),
    bundle = join(state, 'bundles', 'a'.repeat(64));
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(state, 'installation.json'),
    JSON.stringify({
      version: 1,
      bundle,
      node: process.execPath,
      manifestSha256: 'b'.repeat(64),
      modelSha256: SUPPORT_MODEL.sha256,
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    child.kill('SIGTERM');
    await once(child, 'close');
  });
  const identity = supportProcessIdentity(child.pid);
  assert.ok(identity);
  const record = {
    pid: child.pid,
    startTicks: identity.startTicks,
    bundle,
    phase: 'ready',
    heartbeatAt: new Date().toISOString(),
  };
  for (const name of ['status.json', 'chat-status.json'])
    writeFileSync(join(state, name), JSON.stringify(record), { mode: 0o600 });
  const controller = createSupportController({ root });
  assert.equal((await controller.status()).running, false);
  assert.equal((await controller.status(true)).running, false);
  await controller.stop();
  await controller.stop(true);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(supportProcessIdentity(child.pid)?.startTicks, identity.startTicks);
});

test('only installation can read a different verified model; ordinary operations stay strict', async (t) => {
  const previous = previousBundleFixture(t),
    controller = createSupportController({ root: previous.root });
  assert.notEqual(previous.installed.modelSha256, SUPPORT_MODEL.sha256);
  assert.deepEqual(
    await supportPreviousModelArgs(
      previous.installed,
      previous.root,
      join(previous.state, 'api-key'),
    ),
    [previous.binary, '60'],
  );
  for (const operation of [
    () => controller.status(),
    () => controller.start(),
    () => controller.stop(),
    () => controller.run(),
    () => controller.ask('Как подключить бота?'),
  ])
    await assert.rejects(operation(), /support_installation_identity/u);
  // The stopped old installation passes prior-identity checks and reaches candidate validation.
  await assert.rejects(controller.install(), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(readFileSync(previous.installation, 'utf8')), previous.installed);
});

test('previous profile imports require the recorded bundle hash and matching model hash', async (t) => {
  const previous = previousBundleFixture(t),
    wrongProfile = previousBundleFixture(t, { profileSha256: 'd'.repeat(64) });
  await assert.rejects(
    supportPreviousModelArgs(
      { ...previous.installed, manifestSha256: 'e'.repeat(64) },
      previous.root,
      '/key',
    ),
    /support_bundle_manifest_changed/u,
  );
  await assert.rejects(
    supportPreviousModelArgs(wrongProfile.installed, wrongProfile.root, '/key'),
    /support_previous_model_profile/u,
  );
  const marker = join(previous.root, 'unverified-profile-executed');
  writeFileSync(
    join(previous.bundle, 'support-llm-profile.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');\n`,
  );
  await assert.rejects(
    supportPreviousModelArgs(previous.installed, previous.root, '/key'),
    /support_bundle_file_changed/u,
  );
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});

test('install-only prior identity still refuses malformed records and nonprivate state', async (t) => {
  const previous = previousBundleFixture(t),
    controller = createSupportController({ root: previous.root });
  for (const patch of [
    { version: 2 },
    { node: '/foreign/node' },
    { bundle: join(previous.root, 'foreign', 'a'.repeat(64)) },
    { manifestSha256: 'not-a-digest' },
    { modelSha256: 'not-a-digest' },
  ]) {
    writeFileSync(previous.installation, JSON.stringify({ ...previous.installed, ...patch }));
    await assert.rejects(controller.install(), /support_installation_identity/u);
  }
  writeFileSync(previous.installation, JSON.stringify(previous.installed));
  chmodSync(previous.installation, 0o640);
  await assert.rejects(controller.install(), /support_private_file_required/u);
});

test('a live old supervisor or worker blocks installation without being signalled', async (t) => {
  for (const chat of [false, true]) {
    const previous = previousBundleFixture(t),
      script = join(
        previous.bundle,
        chat ? 'support-chat-worker.mjs' : 'support-llm-workstation.mjs',
      ),
      child = await fixtureProcess(t, process.execPath, [script, 'run']),
      identity = supportProcessIdentity(child.pid);
    assert.ok(identity);
    writeFileSync(
      join(previous.state, chat ? 'chat-status.json' : 'status.json'),
      JSON.stringify({ ...identity, bundle: previous.bundle }),
      { mode: 0o600 },
    );
    const controller = createSupportController({ root: previous.root });
    await assert.rejects(controller.install(), /support_stop_before_install/u);
    assert.equal(supportProcessIdentity(child.pid)?.startTicks, identity.startTicks);
    assert.equal(child.signalCode, null);
  }
});

test('an orphan model is checked against its verified old argv and exact process identity', async (t) => {
  const previous = previousBundleFixture(t),
    child = await fixtureProcess(t, previous.binary, ['60']),
    identity = supportProcessIdentity(child.pid),
    controller = createSupportController({ root: previous.root });
  assert.ok(identity);
  const record = {
    pid: 1,
    startTicks: '1',
    bundle: previous.bundle,
    modelPid: child.pid,
    modelStartTicks: identity.startTicks,
  };
  const status = join(previous.state, 'status.json');
  writeFileSync(status, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(controller.install(), /support_stop_before_install/u);
  assert.equal(child.signalCode, null);
  assert.equal(supportProcessIdentity(child.pid)?.startTicks, identity.startTicks);
  // PID reuse must not turn a stale model record into ownership of an unrelated process.
  writeFileSync(
    status,
    JSON.stringify({ ...record, modelStartTicks: String(BigInt(identity.startTicks) + 1n) }),
  );
  await assert.rejects(controller.install(), { code: 'ENOENT' });
  assert.equal(child.signalCode, null);
  assert.deepEqual(JSON.parse(readFileSync(previous.installation, 'utf8')), previous.installed);
});

test('the current installer upgrades and rolls back tiny verified models without changing GPU state', async (t) => {
  const base = fixture(t),
    root = join(base, 'support'),
    gpuRoot = join(base, 'gpu'),
    bin = join(base, 'bin');
  mkdirSync(root);
  mkdirSync(gpuRoot);
  writeFileSync(join(gpuRoot, 'sentinel'), 'existing GPU state');
  const first = await tinyController(
      join(base, 'source-a'),
      root,
      gpuRoot,
      bin,
      'model-a',
      'a.gguf',
    ),
    second = await tinyController(join(base, 'source-b'), root, gpuRoot, bin, 'model-b', 'b.gguf');
  writeFileSync(join(root, first.model.filename), 'model-a');
  await first.controller.install();
  const state = join(root, 'service'),
    installation = join(state, 'installation.json'),
    launcher = join(bin, 'maxim-support'),
    original = readFileSync(installation, 'utf8'),
    originalLauncher = readFileSync(launcher, 'utf8'),
    originalKey = readFileSync(join(state, 'api-key'), 'utf8');
  for (const lock of ['supervisor.lock', 'chat.lock'])
    writeFileSync(join(state, lock), 'preserved lock', { mode: 0o600 });
  writeFileSync(join(root, second.model.filename), 'corrupt');
  await assert.rejects(second.controller.install(), /support_artifact_identity/u);
  assert.equal(readFileSync(installation, 'utf8'), original);
  assert.equal(readFileSync(launcher, 'utf8'), originalLauncher);
  assert.equal((await first.controller.status()).installed, true);
  writeFileSync(join(root, second.model.filename), 'model-b');
  await second.controller.install();
  assert.equal(JSON.parse(readFileSync(installation)).modelSha256, second.model.sha256);
  assert.equal((await second.controller.status()).installed, true);
  await assert.rejects(first.controller.status(), /support_installation_identity/u);
  await first.controller.install();
  assert.equal(readFileSync(installation, 'utf8'), original);
  assert.equal(readFileSync(launcher, 'utf8'), originalLauncher);
  assert.equal((await first.controller.status()).installed, true);
  await assert.rejects(second.controller.status(), /support_installation_identity/u);
  assert.equal(readFileSync(join(state, 'api-key'), 'utf8'), originalKey);
  for (const lock of ['supervisor.lock', 'chat.lock'])
    assert.equal(readFileSync(join(state, lock), 'utf8'), 'preserved lock');
  assert.equal(readFileSync(join(gpuRoot, 'sentinel'), 'utf8'), 'existing GPU state');
});

test('installed API inference works with the CPU stopped and still rejects bundle drift', async (t) => {
  const base = fixture(t),
    root = join(base, 'support'),
    gpuRoot = join(base, 'gpu');
  mkdirSync(root);
  mkdirSync(gpuRoot);
  const { controller, model } = await tinyController(
    join(base, 'source'),
    root,
    gpuRoot,
    join(base, 'bin'),
    'model',
    'tiny.gguf',
  );
  writeFileSync(join(root, model.filename), 'model');
  await controller.install();
  const question = 'Я администратор. Как создать пост через Публик и добавить фото?';
  await assert.rejects(controller.ask(question), /support_model_not_ready/u);
  const state = join(root, 'service');
  writeFileSync(join(state, 'provider.json'), '{"version":1,"backend":"api"}', { mode: 0o600 });
  writeFileSync(join(state, 'provider-api-key'), 'sk-private-fixture-key-123456789', {
    mode: 0o600,
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url.href, 'https://5x2.gptclaudegemini.xyz/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer sk-private-fixture-key-123456789');
    assert.equal(JSON.parse(options.body).reasoning_effort, 'max');
    return Response.json({
      model: 'gpt-6.1-terra',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              action: 'reply',
              text: 'Выберите получателей.\n\nПроверьте пост перед публикацией.',
              sourceIds: ['publisher-post-create'],
            }),
          },
        },
      ],
    });
  });
  assert.equal((await controller.ask(question)).responseRoute, 'model-inference');
  assert.equal(calls, 1);
  assert.equal((await controller.status()).running, false);
  const installed = JSON.parse(readFileSync(join(state, 'installation.json'), 'utf8'));
  writeFileSync(join(installed.bundle, 'support-llm-client.mjs'), '// changed');
  await assert.rejects(controller.ask(question), /support_bundle_file_changed/u);
  assert.equal(calls, 1);
});
