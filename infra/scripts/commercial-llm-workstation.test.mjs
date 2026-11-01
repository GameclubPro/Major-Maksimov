import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import {
  validateWorkstationSmokeResponse,
  COMMERCIAL_LLM_RUNTIME as pin,
} from './commercial-llm-runtime.mjs';
import {
  WORKSTATION_IDENTITY as identity,
  WORKSTATION_SSH_ARGS,
  workstationModelArgs,
} from './commercial-llm-workstation-profile.mjs';
import {
  WorkstationFrames,
  workstationJson,
  workstationSession,
  validateWorkstationRequest,
} from './commercial-llm-workstation-worker.mjs';
const root = new URL('../../', import.meta.url);
const importTs = async (path, transform = (s) => s) =>
  import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(transform(readFileSync(new URL(path, root), 'utf8')))).toString('base64')}`
  );
const protocol = await importTs('apps/api/src/moderation/commercial/commercial-llm.protocol.ts');
const api = await importTs(
  'apps/api/src/moderation/commercial/commercial-llm-workstation.protocol.ts',
  (source) =>
    source.replace(
      "import { commercialLlmPromptSha256 } from './commercial-llm.protocol';",
      `const commercialLlmPromptSha256 = () => '${protocol.COMMERCIAL_LLM_PROMPT_SHA256}';`,
    ),
);
const request = () => ({
  type: 'request',
  id: '00000000-0000-4000-8000-000000000000',
  timeoutMs: 100,
  body: JSON.stringify({
    ...protocol.buildCommercialLlmRequest('synthetic'),
    model: identity.modelAlias,
  }),
});
test('local installed profile and API protocol pin the same model/runtime/prompt and limits', () => {
  assert.deepEqual(identity, api.COMMERCIAL_LLM_WORKSTATION_IDENTITY);
  const args = workstationModelArgs('/models', '/private/key');
  for (const [flag, value] of [
    ['--host', '127.0.0.1'],
    ['--parallel', '1'],
    ['--threads', '4'],
    ['--n-predict', '128'],
    ['--api-key-file', '/private/key'],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--log-disable'));
  assert.ok(WORKSTATION_SSH_ARGS.includes('StrictHostKeyChecking=yes'));
  assert.ok(WORKSTATION_SSH_ARGS.includes('ClearAllForwardings=yes'));
});
test('frame decoder bounds fragmented, malformed, oversized and truncated input', () => {
  const frames = new WorkstationFrames();
  assert.deepEqual(frames.push(Buffer.from('{"a":')), []);
  assert.deepEqual(frames.push(Buffer.from('1}\n{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => new WorkstationFrames().push(Buffer.alloc(65537)));
  assert.throws(() => new WorkstationFrames().push(Buffer.from([0xff, 10])));
  assert.throws(() => new WorkstationFrames().push(Buffer.from('[]\n')));
  frames.push(Buffer.from('{}'));
  assert.throws(() => frames.finish());
});
test('HTTP reader rejects oversized and invalid responses without returning raw text', async () => {
  const fetchImpl = async () =>
    new Response('x'.repeat(20000), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    workstationJson('/v1/chat/completions', 'secret', { fetchImpl }),
    /model_output_limit/,
  );
  await assert.rejects(
    workstationJson('/health', 'secret', {
      fetchImpl: async () => new Response('{}', { status: 503 }),
    }),
    /model_http/,
  );
});
test('request parser refuses expanded generation budgets, foreign models and tools', () => {
  validateWorkstationRequest(request());
  for (const patch of [
    { max_tokens: 129 },
    { model: 'foreign' },
    { stream: true },
    { tools: [{}] },
  ]) {
    const value = request();
    value.body = JSON.stringify({ ...JSON.parse(value.body), ...patch });
    assert.throws(() => validateWorkstationRequest(value));
  }
});
function peer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {
    child.emit('close', 0);
    return true;
  };
  const sent = [],
    decoder = new WorkstationFrames();
  child.stdin.on('data', (chunk) => sent.push(...decoder.push(chunk)));
  return { child, sent, send: (value) => child.stdout.write(JSON.stringify(value) + '\n') };
}
test('session classifies exactly one response and returns ready without retaining a queue', async () => {
  const server = peer(),
    abort = new AbortController();
  let calls = 0;
  const run = workstationSession(server.child, 'key', {
    signal: abort.signal,
    infer: async () => {
      calls++;
      return { model: identity.modelAlias };
    },
  });
  server.send({ type: 'hello', identity });
  await pause(5);
  server.send(request());
  await pause(20);
  assert.equal(calls, 1);
  assert.equal(server.sent.filter((x) => x.type === 'response').length, 1);
  abort.abort();
  await run.catch(() => undefined);
});
test('concurrent requests end the session instead of queuing another inference', async () => {
  const server = peer();
  let calls = 0;
  const run = workstationSession(server.child, 'key', {
    infer: async (_path, _key, { signal }) => {
      calls++;
      await once(signal, 'abort');
      throw new Error('cancelled');
    },
  });
  const rejected = assert.rejects(run, /concurrent_request/);
  server.send({ type: 'hello', identity });
  await pause(5);
  server.send(request());
  await pause(5);
  server.send(request());
  await rejected;
  assert.equal(calls, 1);
});
test('timeout requires model recycle and cannot produce a success response', async () => {
  const server = peer();
  const run = workstationSession(server.child, 'key', {
    infer: async (_path, _key, { signal }) => {
      await pause(1000, undefined, { signal });
      return {};
    },
  });
  const rejected = assert.rejects(run);
  server.send({ type: 'hello', identity });
  await pause(5);
  server.send(request());
  await rejected;
  assert.equal(server.sent.filter((x) => x.type === 'response').length, 0);
});

test('closed cascade readback refuses model/route drift and unknown content fields', () => {
  for (const expectPrimary of [true, false]) {
    const value = {
      ok: true,
      casesPassed: 2,
      casesTotal: 2,
      expectPrimary,
      cascadeVersion: 'commercial-qwen4b9b-shadow-v1',
      cases: ['personal-used-item', 'commercial-service'].map((name, index) => ({
        name,
        classification: index === 0 ? 'NOT_COMMERCIAL' : 'COMMERCIAL',
        route: expectPrimary
          ? index === 0
            ? 'primary'
            : 'secondary_commercial'
          : 'secondary_unavailable',
        modelAlias: expectPrimary && index === 0 ? identity.modelAlias : pin.alias,
        modelSha256: expectPrimary && index === 0 ? identity.modelSha256 : pin.modelSha256,
        promptSha256: pin.smokePromptSha256,
        durationMs: 10,
        primaryDurationMs: expectPrimary ? 5 : null,
        secondaryDurationMs: 5,
      })),
    };
    assert.deepEqual(validateWorkstationSmokeResponse(value, expectPrimary), value);
    for (const mutate of [
      (x) => (x.cases[0].modelAlias = 'foreign'),
      (x) => (x.cases[0].route = 'primary_bad'),
      (x) => (x.cases[0].excerpt = 'private'),
    ]) {
      const copy = structuredClone(value);
      mutate(copy);
      assert.throws(() => validateWorkstationSmokeResponse(copy, expectPrimary));
    }
  }
});

test('online smoke waits for readiness to return between two examples sharing one lease', async () => {
  const { runWorkstationSmoke } = await import('./commercial-llm-workstation-smoke.cjs');
  let ready = true,
    calls = 0,
    reads = 0,
    released = false,
    disconnected = false;
  const deps = {
    redis: {
      connect: async () => {},
      get: async () => {
        reads++;
        return ready ? JSON.stringify({ identity }) : null;
      },
      disconnect: () => {
        disconnected = true;
      },
    },
    lease: {
      acquire: async () => 'owned',
      owns: async () => true,
      release: async () => {
        released = true;
      },
    },
    createCpuScope: (token) => ({ finish: () => deps.lease.release(token) }),
    createClient: () => ({
      classify: async () => {
        assert.equal(
          ready,
          true,
          'the next example must not fall back during heartbeat restoration',
        );
        const first = calls++ === 0;
        ready = false;
        setTimeout(() => {
          ready = true;
        }, 20);
        return {
          classification: first ? 'NOT_COMMERCIAL' : 'COMMERCIAL',
          modelAlias: first ? identity.modelAlias : pin.alias,
          modelSha256: first ? identity.modelSha256 : pin.modelSha256,
          promptSha256: pin.smokePromptSha256,
          durationMs: 10,
          cascade: {
            route: first ? 'primary' : 'secondary_commercial',
            primaryDurationMs: 5,
            secondaryDurationMs: first ? undefined : 5,
          },
        };
      },
    }),
    hasHeadroom: async () => true,
    heartbeatKey: 'synthetic',
    matchesIdentity: (value) => value.modelAlias === identity.modelAlias,
    cascadeVersion: 'commercial-qwen4b9b-shadow-v1',
  };
  const value = await runWorkstationSmoke(deps, true);
  assert.equal(value.casesPassed, 2);
  assert.equal(calls, 2);
  assert.ok(reads >= 3);
  assert.ok(released && disconnected);
  validateWorkstationSmokeResponse(value, true);
});

test('smoke delegates uncertain CPU lease cleanup to its scope exactly once', async () => {
  const { runWorkstationSmoke } = await import('./commercial-llm-workstation-smoke.cjs');
  let finished = 0,
    rawRelease = 0,
    disconnected = false;
  const scope = {
    finish: async () => {
      finished++;
    },
  };
  await assert.rejects(
    runWorkstationSmoke(
      {
        redis: {
          connect: async () => {},
          disconnect: () => {
            disconnected = true;
          },
        },
        lease: {
          acquire: async () => 'owned',
          owns: async () => true,
          release: async () => {
            rawRelease++;
          },
        },
        createCpuScope: (token) => {
          assert.equal(token, 'owned');
          return scope;
        },
        createClient: (value) => {
          assert.equal(value, scope);
          return {
            classify: async () => {
              throw new Error('unknown_cpu');
            },
          };
        },
        hasHeadroom: async () => true,
      },
      false,
    ),
    /unknown_cpu/,
  );
  assert.equal(finished, 1);
  assert.equal(rawRelease, 0);
  assert.equal(disconnected, true);
});

test('smoke readiness has its own short precondition deadline and rejects foreign identity', async () => {
  const { waitForWorkstationReady } = await import('./commercial-llm-workstation-smoke.cjs');
  for (const value of [null, '{}', JSON.stringify({ identity: { modelAlias: 'foreign' } })]) {
    await assert.rejects(
      waitForWorkstationReady(
        { get: async () => value },
        'synthetic',
        (item) => item?.modelAlias === identity.modelAlias,
        new AbortController().signal,
        20,
      ),
      /primary_not_ready/,
    );
  }
});

test('workstation host smoke uses the attested container and compiled classifiers without changing production timing', () => {
  const controller = readFileSync(
    new URL('infra/scripts/commercial-llm-runtime.mjs', root),
    'utf8',
  );
  const harness = readFileSync(
    new URL('infra/scripts/commercial-llm-workstation-smoke.cjs', root),
    'utf8',
  );
  assert.match(
    controller,
    /function checkWorkstation\(expectPrimary\) \{\s*const id = inspectBackgroundClient\(\)/u,
  );
  assert.match(controller, /commercial-llm-workstation-smoke\.cjs/u);
  for (const module of [
    'commercial-llm-cascade.client.js',
    'commercial-llm-workstation.mailbox.js',
    'commercial-llm-shadow.lease.js',
  ])
    assert.ok(harness.includes(module));
  assert.doesNotMatch(harness, /prototype\.|MAX_API|new Prisma|fetch\(/u);
  assert.equal(api.COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS, 3000);
});
