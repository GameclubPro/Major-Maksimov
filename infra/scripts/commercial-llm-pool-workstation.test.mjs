import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import {
  POOL_NODE_IDS,
  POOL_MAX_REQUEST_MS,
  poolProfile,
  poolIdentityMatches,
  poolModelArgs,
  poolSshArgs,
  poolReconnectDelay,
} from './commercial-llm-pool-profile.mjs';
import {
  WORKSTATION_IDENTITY,
  workstationModelArgs,
} from './commercial-llm-workstation-profile.mjs';
import {
  PoolFrames,
  poolSession,
  validatePoolRequest,
  poolJson,
  poolModelIsIdle,
  attestPoolModel,
} from './commercial-llm-pool-worker.mjs';
import {
  createPoolController,
  readPoolProcess,
  poolResumeEnabled,
  connectPoolTransport,
  warmPoolCpuModel,
} from './commercial-llm-pool-workstation.mjs';

const root = new URL('../../', import.meta.url);
const importTs = async (path, transform = (source) => source) =>
  import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(transform(readFileSync(new URL(path, root), 'utf8')))).toString('base64')}`
  );
const protocol = await importTs('apps/api/src/moderation/commercial/commercial-llm.protocol.ts');
const api = await importTs(
  'apps/api/src/moderation/commercial/commercial-llm-pool.protocol.ts',
  (source) =>
    source
      .replace(
        /import \{([\s\S]*?)\} from '\.\/commercial-llm.protocol';/u,
        (_match, names) => `const {${names}} = ${JSON.stringify(protocol)};`,
      )
      .replace(
        "import { COMMERCIAL_LLM_WORKSTATION_IDENTITY } from './commercial-llm-workstation.protocol';",
        `const COMMERCIAL_LLM_WORKSTATION_IDENTITY = ${JSON.stringify(WORKSTATION_IDENTITY)};`,
      ),
);

function request(nodeId = 'pc-b-9b', timeoutMs = 100) {
  return {
    type: 'request',
    id: '00000000-0000-4000-8000-000000000000',
    timeoutMs,
    body: JSON.stringify({
      ...protocol.buildCommercialLlmRequest('synthetic'),
      model: poolProfile(nodeId).identity.modelAlias,
    }),
  };
}

function peer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {
    child.emit('close', 0);
    return true;
  };
  const sent = [],
    decoder = new PoolFrames();
  child.stdin.on('data', (chunk) => sent.push(...decoder.push(chunk)));
  return { child, sent, send: (value) => child.stdout.write(JSON.stringify(value) + '\n') };
}

async function eventually(condition, deadlineMs = 1000) {
  const deadline = Date.now() + deadlineMs;
  while (!condition() && Date.now() < deadline) await pause(5);
  assert.ok(condition(), 'observable state did not arrive before its deadline');
}

test('all PC identities match backend v2 and preserve exact model/runtime provenance', () => {
  for (const nodeId of POOL_NODE_IDS) {
    const profile = poolProfile(nodeId);
    assert.deepEqual(profile.identity, api.COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity);
    assert.equal(profile.artifacts[0].sha256, profile.identity.modelSha256);
    assert.equal(profile.artifacts[1].sha256, profile.identity.runtimeArtifactSha256);
    assert.equal(profile.artifacts[2].sha256, profile.identity.runtimeSupportSha256);
    assert.equal(
      poolIdentityMatches(nodeId, { ...profile.identity, modelAlias: 'foreign' }),
      false,
    );
  }
  assert.equal(POOL_MAX_REQUEST_MS, api.COMMERCIAL_LLM_POOL_TIMEOUT_MS);
  assert.notEqual(
    poolProfile('pc-a-4b').identity.modelSha256,
    poolProfile('pc-b-9b').identity.modelSha256,
  );
  assert.throws(() => poolProfile('server-9b'));
});

test('model profiles isolate the CPU slot and retain bounded private GPU slots', () => {
  for (const nodeId of POOL_NODE_IDS) {
    const args = poolModelArgs(nodeId, '/models', '/private/key');
    for (const [flag, value] of [
      ['--host', '127.0.0.1'],
      ['--parallel', '1'],
      ['--ctx-size', '4096'],
      ['--n-predict', '128'],
      ['--threads', nodeId === 'pc-a-cpu-9b' ? '6' : '4'],
      ['--api-key-file', '/private/key'],
      ['--n-gpu-layers', nodeId === 'pc-a-cpu-9b' ? '0' : '99'],
      ['--port', nodeId === 'pc-a-cpu-9b' ? '18085' : '18084'],
    ])
      assert.equal(args[args.indexOf(flag) + 1], value);
    assert.equal(args[args.indexOf('--alias') + 1], poolProfile(nodeId).identity.modelAlias);
    assert.ok(args.includes('--no-agent'));
    assert.ok(args.includes('--log-disable'));
    assert.equal(args.filter((value) => value === '--slots').length, 1);
    assert.equal(args.includes('--no-slots'), false);
  }
  const legacyArgs = workstationModelArgs('/models', '/private/key');
  assert.ok(legacyArgs.includes('--no-slots'));
  assert.equal(legacyArgs.includes('--slots'), false);
});

test('an exited model cannot reconnect or advertise another ready session', async () => {
  const model = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(model, 'exit');
  let probes = 0;
  let connections = 0;
  await assert.rejects(
    connectPoolTransport(model, {
      nodeId: 'pc-b-9b',
      key: 'synthetic',
      attest: async () => {
        probes++;
      },
      connect: () => {
        connections++;
      },
    }),
    /pool_model_exit/,
  );
  assert.equal(probes, 0);
  assert.equal(connections, 0);
});

test('a model exiting during the awaited readiness probe cannot reconnect', async () => {
  const model = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await once(model, 'spawn');
  let exitedDuringProbe = false;
  let connections = 0;
  try {
    await assert.rejects(
      connectPoolTransport(model, {
        nodeId: 'pc-b-9b',
        key: 'synthetic',
        attest: async () => {
          const exited = once(model, 'exit');
          model.kill('SIGTERM');
          await exited;
          exitedDuringProbe = true;
        },
        connect: () => {
          connections++;
        },
      }),
      /pool_model_exit/,
    );
    assert.equal(exitedDuringProbe, true);
    assert.equal(connections, 0);
  } finally {
    model.kill('SIGKILL');
  }
});

test('a proved idle reconnect retains its live model and does not connect on failed readiness', async () => {
  const model = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await once(model, 'spawn');
  const signal = new AbortController().signal;
  const transport = {};
  let connections = 0;
  try {
    const options = {
      nodeId: 'pc-b-9b',
      key: 'synthetic',
      signal,
      attest: async (nodeId, key, actualSignal) => {
        assert.equal(nodeId, 'pc-b-9b');
        assert.equal(key, 'synthetic');
        assert.equal(actualSignal, signal);
      },
      connect: () => {
        connections++;
        return transport;
      },
    };
    assert.equal(await connectPoolTransport(model, options), transport);
    assert.equal(connections, 1);
    assert.equal(model.exitCode, null);
    assert.equal(model.signalCode, null);
    assert.equal(model.killed, false);
    await assert.rejects(
      connectPoolTransport(model, {
        ...options,
        attest: async () => {
          throw new Error('pool_model_busy');
        },
      }),
      /pool_model_busy/,
    );
    assert.equal(connections, 1);
  } finally {
    const closed = once(model, 'close');
    model.kill('SIGTERM');
    await closed;
  }
});

test('a cancelled readiness probe cannot open a transport', async () => {
  const model = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await once(model, 'spawn');
  const controller = new AbortController();
  let connections = 0;
  try {
    await assert.rejects(
      connectPoolTransport(model, {
        nodeId: 'pc-b-9b',
        key: 'synthetic',
        signal: controller.signal,
        attest: async () => {
          controller.abort();
        },
        connect: () => {
          connections++;
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(connections, 0);
  } finally {
    const closed = once(model, 'close');
    model.kill('SIGTERM');
    await closed;
  }
});

test('pool occupancy uses authenticated bounded slots and returns only a boolean', async () => {
  const signal = new AbortController().signal;
  for (const isProcessing of [false, true]) {
    const value = await poolModelIsIdle('private-fixture-key', signal, {
      readJson: (path, key, options) =>
        poolJson(path, key, {
          ...options,
          fetchImpl: async (url, init) => {
            assert.equal(String(url), 'http://127.0.0.1:18084/slots');
            assert.equal(init.method, 'GET');
            assert.equal(init.headers.Authorization, 'Bearer private-fixture-key');
            assert.equal(init.signal, signal);
            assert.equal(init.redirect, 'error');
            assert.equal(options.maximumBytes, 65536);
            return Response.json([
              {
                id: 0,
                n_ctx: 4096,
                is_processing: isProcessing,
                prompt: 'private-marker'.repeat(2000),
                generated: 'private-output',
                params: {},
              },
            ]);
          },
        }),
    });
    assert.equal(value, !isProcessing);
  }
});

test('CPU readiness and inference HTTP stay on the independent authenticated loopback port', async () => {
  for (const nodeId of POOL_NODE_IDS) {
    for (const path of ['/props', '/v1/models', '/slots', '/v1/chat/completions']) {
      const body = path === '/v1/chat/completions' ? '{}' : undefined;
      await poolJson(path, 'private-fixture-key', {
        nodeId,
        body,
        fetchImpl: async (url, init) => {
          const port = nodeId === 'pc-a-cpu-9b' ? '18085' : '18084';
          assert.equal(String(url), `http://127.0.0.1:${port}${path}`);
          assert.equal(init.headers.Authorization, 'Bearer private-fixture-key');
          assert.equal(init.method, body ? 'POST' : 'GET');
          assert.equal(init.redirect, 'error');
          return Response.json({});
        },
      });
    }
  }
  const reads = [];
  await assert.rejects(
    attestPoolModel('pc-a-cpu-9b', 'synthetic', undefined, {
      readJson: async (path, _key, options) => {
        reads.push({ path, nodeId: options.nodeId });
        return { endpoint_slots: false };
      },
    }),
    /pool_model_slots_disabled/u,
  );
  assert.deepEqual(reads, [{ path: '/props', nodeId: 'pc-a-cpu-9b' }]);
  await assert.rejects(
    poolModelIsIdle('synthetic', undefined, {
      nodeId: 'pc-a-cpu-9b',
      readJson: async (path, _key, options) => {
        assert.equal(path, '/slots');
        assert.equal(options.nodeId, 'pc-a-cpu-9b');
        return [];
      },
    }),
    /pool_model_slots/u,
  );
});

test('CPU primer uses the pinned production prompt and rejects incomplete warm-up before readiness', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const valid = {
    model: poolProfile('pc-a-cpu-9b').identity.modelAlias,
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['ORDINARY_DISCUSSION'],
          }),
        },
      },
    ],
  };
  const readJson = async (path, _key, options) => {
    calls.push({ path, options });
    return valid;
  };
  await warmPoolCpuModel('pc-a-cpu-9b', 'synthetic', signal, protocol, readJson);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].options.nodeId, 'pc-a-cpu-9b');
  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.messages[0].content, protocol.COMMERCIAL_LLM_SYSTEM_PROMPT);
  assert.deepEqual(
    requestBody.response_format,
    protocol.buildCommercialLlmRequest('synthetic').response_format,
  );
  for (const response of [
    { ...valid, model: 'foreign' },
    { ...valid, choices: [{ ...valid.choices[0], finish_reason: 'length' }] },
    { ...valid, choices: [] },
  ])
    await assert.rejects(
      warmPoolCpuModel('pc-a-cpu-9b', 'synthetic', signal, protocol, async () => response),
      /pool_primer_decision/u,
    );
  await assert.rejects(
    warmPoolCpuModel(
      'pc-a-cpu-9b',
      'synthetic',
      signal,
      {
        ...protocol,
        commercialLlmPromptSha256: () => 'foreign',
      },
      readJson,
    ),
    /pool_primer_identity/u,
  );
  assert.equal(calls.length, 1);
});

test('pool occupancy rejects missing, multiple, mismatched and untyped slot records', async () => {
  const slot = { id: 0, n_ctx: 4096, is_processing: false };
  const invalid = [
    undefined,
    null,
    {},
    { status: 'ok' },
    [],
    [null],
    [[]],
    [slot, slot],
    [{ ...slot, id: 1 }],
    [{ ...slot, id: '0' }],
    [{ ...slot, n_ctx: 2048 }],
    [{ ...slot, n_ctx: '4096' }],
    [{ id: 0, n_ctx: 4096 }],
    ...[0, 1, null, 'true', 'false', []].map((value) => [{ ...slot, is_processing: value }]),
  ];
  for (const value of invalid)
    await assert.rejects(poolModelIsIdle('synthetic', undefined, { readJson: async () => value }), {
      message: 'pool_model_slots',
    });
});

test('pool slot HTTP failures and oversized responses never become idle', async () => {
  const body = [{ id: 0, n_ctx: 4096, is_processing: false }];
  for (const response of [
    Response.json(body, { status: 401 }),
    Response.json(body, { status: 403 }),
    Response.json(body, { status: 404 }),
    Response.json(body, { status: 503 }),
    new Response(JSON.stringify(body), { headers: { 'content-type': 'text/plain' } }),
    Response.json([{ ...body[0], prompt: 'private-marker'.repeat(65536) }]),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
  ])
    await assert.rejects(
      poolModelIsIdle('synthetic', undefined, {
        readJson: (path, key, options) =>
          poolJson(path, key, { ...options, fetchImpl: async () => response }),
      }),
    );
  await assert.rejects(
    poolModelIsIdle('synthetic', undefined, {
      readJson: async () => {
        throw new Error('model_http');
      },
    }),
    /model_http/,
  );
});

test('model attestation refuses disabled or untyped slot capability before other model reads', async () => {
  for (const props of [
    null,
    {},
    { endpoint_slots: false },
    { endpoint_slots: 'true' },
    { endpoint_slots: 1 },
  ]) {
    const reads = [];
    await assert.rejects(
      attestPoolModel('pc-b-9b', 'synthetic', undefined, {
        readJson: async (path) => {
          reads.push(path);
          return props;
        },
      }),
      { message: 'pool_model_slots_disabled' },
    );
    assert.deepEqual(reads, ['/props']);
  }
  await assert.rejects(
    attestPoolModel('pc-b-9b', 'synthetic', undefined, {
      readJson: async () => ({ endpoint_slots: true, total_slots: 1, chat_template: 'foreign' }),
    }),
    { message: 'pool_model_identity' },
  );
});

test('outbound SSH pins node argument and refuses shell syntax or relaxed host trust', () => {
  const args = poolSshArgs('pc-b-9b', 'maxim-vps');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.at(-1).endsWith('workstation-pool-bridge pc-b-9b'));
  for (const alias of ['-oProxyCommand=bad', 'host; bad', 'host\nother', 'host with space'])
    assert.throws(() => poolSshArgs('pc-a-4b', alias));
});

test('reconnect backoff is jittered, bounded, and does not create tight retry loops', () => {
  assert.equal(
    poolReconnectDelay(0, () => 0),
    1000,
  );
  assert.equal(
    poolReconnectDelay(1, () => 0),
    2000,
  );
  assert.equal(
    poolReconnectDelay(100, () => 0),
    15000,
  );
  assert.ok(poolReconnectDelay(100, () => 0.999) < 30000);
  assert.throws(() => poolReconnectDelay(-1));
});

test('9B accepts a measured budget above old 4B limit but rejects expanded compute or foreign model', () => {
  validatePoolRequest('pc-b-9b', request('pc-b-9b', 15000));
  for (const patch of [
    { max_tokens: 129 },
    { model: 'foreign' },
    { stream: true },
    { n: 2 },
    { tools: [{}] },
    { seed: 9 },
  ]) {
    const value = request();
    value.body = JSON.stringify({ ...JSON.parse(value.body), ...patch });
    assert.throws(() => validatePoolRequest('pc-b-9b', value));
  }
  assert.throws(() => validatePoolRequest('pc-b-9b', request('pc-b-9b', 20001)));
  assert.throws(() => validatePoolRequest('pc-a-4b', request('pc-b-9b')));
});

test('node swap or altered identity is refused before accepting work', async () => {
  const server = peer();
  let calls = 0;
  const running = poolSession(server.child, 'pc-b-9b', 'key', {
    infer: async () => {
      calls++;
      return {};
    },
  });
  const rejected = assert.rejects(running, /pool_bridge_identity/);
  server.send({ type: 'hello', nodeId: 'pc-a-4b', identity: poolProfile('pc-a-4b').identity });
  await rejected;
  assert.equal(calls, 0);
});

for (const nodeId of ['pc-b-9b', 'pc-a-cpu-9b'])
  test(`a successful ${nodeId} inference withdraws readiness then publishes one result and restores readiness`, async () => {
    const server = peer(),
      controller = new AbortController();
    let finish;
    const running = poolSession(server.child, nodeId, 'key', {
      signal: controller.signal,
      infer: async (_path, _key, options) => {
        assert.equal(options.nodeId, nodeId);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    server.send({ type: 'hello', nodeId, identity: poolProfile(nodeId).identity });
    await eventually(() => server.sent.some((frame) => frame.type === 'ready' && frame.ready));
    server.send(request(nodeId));
    await eventually(() => typeof finish === 'function');
    assert.equal(server.sent.at(-1).ready, false);
    finish({ model: poolProfile(nodeId).identity.modelAlias });
    await eventually(() => server.sent.filter((frame) => frame.type === 'response').length === 1);
    assert.equal(server.sent.at(-1).ready, true);
    controller.abort();
    await running.catch(() => undefined);
  });

test('a concurrent request closes the session without adding local queued work', async () => {
  const server = peer();
  let calls = 0;
  const running = poolSession(server.child, 'pc-b-9b', 'key', {
    infer: async (_path, _key, { signal }) => {
      calls++;
      await pause(2000, undefined, { signal });
      return {};
    },
  });
  const rejected = assert.rejects(running, /pool_concurrent_request/);
  server.send({ type: 'hello', nodeId: 'pc-b-9b', identity: poolProfile('pc-b-9b').identity });
  server.send(request());
  await eventually(() => calls === 1);
  server.send({ ...request(), id: '00000000-0000-4000-8000-000000000001' });
  await rejected;
  assert.equal(calls, 1);
  assert.equal(server.sent.filter((frame) => frame.type === 'response').length, 0);
});

test('disconnect during inference aborts compute and requires model recycle before rejoin', async () => {
  const server = peer();
  let inferSignal;
  const running = poolSession(server.child, 'pc-b-9b', 'key', {
    infer: async (_path, _key, { signal }) => {
      inferSignal = signal;
      await pause(2000, undefined, { signal });
      return {};
    },
  });
  const rejected = assert.rejects(running, /pool_model_recycle_required/);
  server.send({ type: 'hello', nodeId: 'pc-b-9b', identity: poolProfile('pc-b-9b').identity });
  server.send(request('pc-b-9b', 1000));
  await eventually(() => Boolean(inferSignal));
  server.child.stdout.end();
  await rejected;
  assert.equal(inferSignal.aborted, true);
  assert.equal(server.sent.filter((frame) => frame.type === 'response').length, 0);
});

test('an idle transport failure does not require reloading a healthy model', async () => {
  const server = peer();
  const running = poolSession(server.child, 'pc-b-9b', 'key');
  const rejected = assert.rejects(running, (error) => error.recycleModel === false);
  server.send({ type: 'hello', nodeId: 'pc-b-9b', identity: poolProfile('pc-b-9b').identity });
  await eventually(() => server.sent.some((frame) => frame.type === 'ready' && frame.ready));
  server.child.stdout.destroy(new Error('synthetic network disconnect'));
  await rejected;
});

test('deadline expiry cannot publish a late response or advertise readiness', async () => {
  const server = peer();
  const running = poolSession(server.child, 'pc-b-9b', 'key', {
    infer: async () => {
      await pause(80);
      return {};
    },
  });
  const rejected = assert.rejects(running, /pool_model_recycle_required/);
  server.send({ type: 'hello', nodeId: 'pc-b-9b', identity: poolProfile('pc-b-9b').identity });
  server.send(request('pc-b-9b', 30));
  await rejected;
  assert.equal(server.sent.filter((frame) => frame.type === 'response').length, 0);
  assert.equal(server.sent.filter((frame) => frame.type === 'ready').at(-1).ready, false);
});

test('manual stop persists and resume/watch cannot reenable or require installation', async () => {
  const taskHome = mkdtempSync(join(tmpdir(), 'maxim-pool-stop-'));
  try {
    const controller = createPoolController('pc-b-9b', { taskHome });
    mkdirSync(controller.state, { recursive: true });
    writeFileSync(join(controller.state, 'enabled'), '1\n');
    assert.equal(poolResumeEnabled(controller.state), true);
    await controller.stop();
    assert.equal(poolResumeEnabled(controller.state), false);
    assert.deepEqual(await controller.start({ resume: true }), {
      started: false,
      disabled: true,
      nodeId: 'pc-b-9b',
    });
    assert.deepEqual(await controller.watch(), {
      started: false,
      disabled: true,
      nodeId: 'pc-b-9b',
    });
  } finally {
    rmSync(taskHome, { recursive: true, force: true });
  }
});

test('stale PID, foreign node, and foreign executable arguments do not confer stop authority', () => {
  const state = join(tmpdir(), 'maxim-pool-identity', 'service');
  const record = {
    pid: 123,
    startTicks: '321',
    nodeId: 'pc-b-9b',
    bundle: join(state, 'bundles', 'a'.repeat(64)),
  };
  const files = new Map([
    [join(state, 'status.json'), JSON.stringify(record)],
    [
      '/proc/123/stat',
      '123 (node) ' + Array.from({ length: 20 }, (_v, i) => (i === 19 ? '321' : '0')).join(' '),
    ],
    [
      '/proc/123/cmdline',
      [
        '/usr/bin/node',
        join(record.bundle, 'commercial-llm-pool-workstation.mjs'),
        'run',
        'pc-b-9b',
        '',
      ].join('\0'),
    ],
  ]);
  const read = (path) => files.get(path);
  assert.equal(readPoolProcess(state, 'pc-b-9b', read)?.pid, 123);
  assert.equal(readPoolProcess(state, 'pc-a-4b', read), null);
  files.set('/proc/123/stat', files.get('/proc/123/stat').replace(/321$/u, '322'));
  assert.equal(readPoolProcess(state, 'pc-b-9b', read), null);
  files.set('/proc/123/stat', files.get('/proc/123/stat').replace(/322$/u, '321'));
  files.set('/proc/123/cmdline', '/usr/bin/node\0/foreign/source.mjs\0run\0pc-b-9b\0');
  assert.equal(readPoolProcess(state, 'pc-b-9b', read), null);
});

test(
  'Linux parent-death guard terminates an owned process after abrupt supervisor death',
  { skip: process.platform !== 'linux' },
  async () => {
    const moduleUrl = new URL('./commercial-llm-pool-workstation.mjs', import.meta.url).href;
    const source = `import { guardedPoolChild } from ${JSON.stringify(moduleUrl)}; const child = guardedPoolChild('/bin/sleep', ['60'], { stdio: 'ignore' }); child.on('spawn', () => console.log(child.pid)); setInterval(() => {}, 1000);`;
    const supervisor = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childPid;
    try {
      const [chunk] = await once(supervisor.stdout, 'data');
      childPid = Number(String(chunk).trim());
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
      await pause(100);
      supervisor.kill('SIGKILL');
      await once(supervisor, 'close');
      await eventually(() => {
        try {
          return readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1].startsWith('Z ');
        } catch {
          return true;
        }
      }, 5000);
    } finally {
      supervisor.kill('SIGKILL');
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // FLAG: The owned child may already have exited after the parent-death signal.
        }
      }
    }
  },
);
