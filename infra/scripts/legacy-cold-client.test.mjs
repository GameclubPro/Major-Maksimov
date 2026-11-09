import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createLegacyColdClient } from './legacy-cold-client.mjs';
import { legacyColdStoreEnvironment } from './legacy-cold-host.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceSha = 'b'.repeat(40);
  const imageId = `sha256:${'a'.repeat(64)}`;
  const controllerNonce = '11111111-1111-4111-8111-111111111111';
  const id = 'c'.repeat(64);
  const environmentFile = join(directory, 'client.env');
  const inventoryPath = join(directory, 'inventory.json');
  const queueControlPath = join(directory, 'queue-control.cjs');
  const queueControlBytes = 'reviewed fixture queue controller';
  const absenceProbePath = join(directory, 'absence.cjs');
  const absenceBytes = 'reviewed fixture absence probe';
  const sourceBatchPath = join(directory, 'source-batch.cjs');
  const sourceBatchBytes = 'reviewed finite store harness';
  writeFileSync(sourceBatchPath, sourceBatchBytes, { mode: 0o600 });
  writeFileSync(absenceProbePath, absenceBytes, { mode: 0o600 });
  writeFileSync(queueControlPath, queueControlBytes, { mode: 0o600 });
  writeFileSync(
    environmentFile,
    'DATABASE_URL=postgresql://private.fixture/db\nREDIS_URL=redis://private.fixture/0\n',
    { mode: 0o600 },
  );
  writeFileSync(inventoryPath, '{}\n', { mode: 0o600 });
  const calls = [];
  let exists = false;
  const state = {
    failStart: false,
    failCreate: false,
    failRemove: false,
    foreign: false,
    response: { version: 1, activationAuthorized: false, state: 'SEALED' },
    responseExit: false,
    hostConfig: { NanoCpus: 1_000_000_000, Memory: 402_653_184, MemorySwap: 402_653_184 },
  };
  const run = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'ps') return exists ? id : '';
    if (args[0] === 'image')
      return JSON.stringify([
        { Id: imageId, Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } },
      ]);
    if (args[0] === 'create') {
      exists = true;
      if (state.failCreate) throw new Error('private create response lost');
      return id;
    }
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: id,
          Image: imageId,
          Name: `/maxim-legacy-recovery-${state.foreign ? 'foreign' : controllerNonce}`,
          Config: { Labels: { 'com.maxim.legacy-recovery-client': controllerNonce } },
          HostConfig: state.hostConfig,
        },
      ]);
    if (args[0] === 'start') {
      if (state.failStart) throw new Error('private inventory payload must not escape');
      if (state.responseExit)
        throw Object.assign(new Error('private Docker stderr'), {
          status: 1,
          stdout: JSON.stringify(state.response),
        });
      return JSON.stringify(state.response);
    }
    if (args[0] === 'rm') {
      if (state.failRemove) throw new Error('private remove failure');
      exists = false;
      return id;
    }
    throw new Error('unexpected Docker call');
  };
  const client = createLegacyColdClient({
    ...options,
    sourceSha,
    imageId,
    controllerNonce,
    networkId: 'd'.repeat(64),
    environmentFile,
    inventoryPath,
    queueControlPath,
    queueControlSha256: createHash('sha256').update(queueControlBytes).digest('hex'),
    absenceProbePath,
    absenceProbeSha256: createHash('sha256').update(absenceBytes).digest('hex'),
    sourceBatchPath,
    sourceBatchSha256: createHash('sha256').update(sourceBatchBytes).digest('hex'),
    sourceBatchInventoryPaths: [inventoryPath],
    run,
  });
  return {
    client,
    calls,
    state,
    environmentFile,
    inventoryPath,
    queueControlPath,
    absenceProbePath,
    sourceBatchPath,
    exists: () => exists,
    id,
  };
}

function coldSessionFixture(t) {
  const bindings = {
    targetSha: 'b'.repeat(40),
    targetImageId: `sha256:${'a'.repeat(64)}`,
    controllerNonce: '11111111-1111-4111-8111-111111111111',
    selectionDigest: 'f'.repeat(64),
  };
  const stopped = {
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    selectionDigest: bindings.selectionDigest,
    controllerNonce: bindings.controllerNonce,
    services: LEGACY_COLD_API_SERVICES.map((serviceName) => ({
      serviceName,
      stopped: true,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
    })),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((serviceName) => ({
      serviceName,
      stopped: true,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
    })),
    unreviewedProducers: 0,
  };
  const observations = [];
  let reads = 0;
  const state = { mutate: () => {} };
  const h = fixture(t, {
    protocol: 'source-abandonment-v1',
    sourceSessionCold: {
      bindings,
      readStoppedRuntime: () => {
        reads += 1;
        observations.push(h.calls.at(-1)?.args?.[0]);
        state.mutate(stopped, reads);
        return stopped;
      },
    },
  });
  return { ...h, stopped, guardState: state, observations, reads: () => reads };
}

test('cold session uses fixed one CPU only after two fresh stopped fleet proofs', (t) => {
  const h = coldSessionFixture(t);
  assert.equal(h.reads(), 0);
  h.client.invoke('inventory', { version: 1, operation: 'inventory_preview' });
  const create = h.calls.find(({ args }) => args[0] === 'create').args;
  assert.equal(create[create.indexOf('--cpus') + 1], '1');
  assert.equal(create[create.indexOf('--memory') + 1], '384m');
  assert.equal(create[create.indexOf('--memory-swap') + 1], '384m');
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.observations, ['image', 'inspect']);
  assert.equal(h.exists(), false);
});

for (const phase of [1, 2])
  for (const [name, change] of [
    [
      'running API',
      (proof) => {
        proof.services[0].stopped = false;
      },
    ],
    [
      'running native',
      (proof) => {
        proof.auxiliaries[0].stopped = false;
      },
    ],
    [
      'missing native',
      (proof) => {
        proof.auxiliaries.pop();
      },
    ],
    [
      'changed generation',
      (proof) => {
        proof.services[0].exactGeneration = false;
      },
    ],
    [
      'wrong source',
      (proof) => {
        proof.sourceSha = 'e'.repeat(40);
      },
    ],
    [
      'extra producer',
      (proof) => {
        proof.unreviewedProducers = 1;
      },
    ],
  ])
    test(`cold session refuses ${name} before ${phase === 1 ? 'create' : 'start'}`, (t) => {
      const h = coldSessionFixture(t);
      h.guardState.mutate = (proof, read) => {
        if (read === phase) change(proof);
      };
      assert.throws(
        () => h.client.invoke('store', { version: 1, operation: 'readback' }),
        /client_result_unknown/,
      );
      assert.equal(
        h.calls.some(({ args }) => args[0] === 'start'),
        false,
      );
      assert.equal(h.calls.filter(({ args }) => args[0] === 'create').length, phase - 1);
      assert.equal(h.exists(), false);
    });

for (const key of ['NanoCpus', 'Memory', 'MemorySwap'])
  test(`cold session refuses actual ${key} mismatch and cleans owned client`, (t) => {
    const h = coldSessionFixture(t);
    h.state.hostConfig[key] = 1;
    assert.throws(
      () => h.client.invoke('store', { version: 1, operation: 'readback' }),
      /client_result_unknown/,
    );
    assert.equal(
      h.calls.some(({ args }) => args[0] === 'start'),
      false,
    );
    assert.equal(h.exists(), false);
  });

for (const kind of ['admission', 'queues', 'absence'])
  test(`cold session refuses ${kind} without any Docker call`, (t) => {
    const h = coldSessionFixture(t);
    assert.throws(() => h.client.invoke(kind, { version: 1 }), /cold_client_kind_refused/);
    assert.equal(h.calls.length, 0);
  });

test('default legacy and modern online clients keep half CPU without stopped proof', (t) => {
  for (const protocol of ['legacy', 'source-abandonment-v1']) {
    const h = fixture(t, { protocol });
    h.client.invoke('admission', { version: 1, operation: 'admission_preview' });
    const create = h.calls.find(({ args }) => args[0] === 'create').args;
    assert.equal(create[create.indexOf('--cpus') + 1], '0.5');
  }
});

test('modern exact-source client uses only its fixed collector/store and separate environment domain', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  h.client.invoke('store', { version: 1, operation: 'readback' });
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(create.includes('apps/api/dist/apps/api/src/scripts/source-abandonment-store.js'));
  assert.ok(create.includes('APP_SERVICE_NAME=source-abandonment-store'));
  assert.ok(create.includes('MAXIM_SOURCE_ABANDONMENT_OFFLINE=1'));
  assert.ok(create.includes('MAXIM_SOURCE_ABANDONMENT_STORE_MODE=readback'));
  assert.equal(
    create.filter((arg) => arg === 'MAXIM_SOURCE_ABANDONMENT_PROTOCOL=source-abandonment-v1')
      .length,
    1,
  );
  assert.equal(
    create.some((arg) => arg.startsWith('MAXIM_LEGACY_RECOVERY_')),
    false,
  );
  assert.equal(h.exists(), false);
  h.calls.length = 0;
  h.state.response = { version: 1, decision: 'READY_FOR_COLD_REVIEW', activationAuthorized: false };
  h.client.invoke('admission', { version: 1, operation: 'admission_preview' });
  const collect = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(collect.includes('apps/api/dist/apps/api/src/scripts/source-abandonment-collect.js'));
  assert.ok(collect.includes('APP_SERVICE_NAME=source-abandonment-collect'));
  assert.equal(
    collect.some((arg) => arg.includes('STORE_MODE=')),
    false,
  );
});

function batchRequest(phase = 'install') {
  return {
    version: 1,
    kind: 'source_abandonment_session_store_batch',
    phase,
    deadlineAtMs: Date.now() + 60_000,
    items: [{ inventoryIndex: 0, request: { operation: 'readback' } }],
  };
}

const scopedCredentialNames = [
  'DATABASE_URL',
  'REDIS_URL',
  'ERASER_CONTROL_URL',
  'ERASER_CONTROL_TOKEN',
];
const capturedStores = {
  DATABASE_URL: 'postgresql://captured.fixture/private-db',
  REDIS_URL: 'redis://captured.fixture/6',
};
const capturedControl = {
  ERASER_CONTROL_URL: 'http://eraser:3000',
  ERASER_CONTROL_TOKEN: 'captured-control-'.padEnd(64, 'c'),
};

function withAmbientCredentials(callback) {
  const ambient = {
    DATABASE_URL: 'postgresql://ambient.fixture/never-use',
    REDIS_URL: 'redis://ambient.fixture/9',
    ERASER_CONTROL_URL: 'http://ambient.invalid',
    ERASER_CONTROL_TOKEN: 'ambient-control-'.padEnd(64, 'a'),
    MAX_BOT_TOKEN: 'ambient-max-token-must-not-reach-the-container',
  };
  const before = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, ambient);
    callback(ambient);
    for (const [key, value] of Object.entries(ambient)) assert.equal(process.env[key], value);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertCredentialProjection(h, expected, ambient) {
  const create = h.calls.find(({ args }) => args[0] === 'create');
  assert.ok(create, 'the validated captured environment must reach Docker creation');
  assert.equal(create.args.includes('--env-file'), false);
  const passedNames = create.args.flatMap((value, index, args) =>
    value === '--env' ? [args[index + 1]] : [],
  );
  const scopedNames = passedNames.filter((name) => scopedCredentialNames.includes(name));
  assert.deepEqual([...scopedNames].sort(), Object.keys(expected).sort());
  for (const key of scopedCredentialNames) {
    assert.equal(Object.hasOwn(create.options.env, key), Object.hasOwn(expected, key));
    assert.equal(create.options.env[key], expected[key]);
  }
  const containerEnvironment = Object.fromEntries(
    passedNames.map((entry) => {
      const separator = entry.indexOf('=');
      return separator < 0
        ? [entry, create.options.env[entry]]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  assert.equal(Object.hasOwn(containerEnvironment, 'MAX_BOT_TOKEN'), false);
  for (const value of [
    ...Object.values(capturedStores),
    ...Object.values(capturedControl),
    ...Object.values(ambient),
  ])
    assert.equal(
      create.args.some((argument) => argument.includes(value)),
      false,
    );
  assert.equal(h.calls.filter(({ args }) => args[0] === 'create').length, 1);
  assert.equal(h.calls.filter(({ args }) => args[0] === 'start').length, 1);
  assert.equal(h.exists(), false);
}

const storePhases = ['certificate_create', 'install', 'readback', 'materialize'];
for (const protocol of ['legacy', 'source-abandonment-v1']) {
  const operations = [
    { kind: 'admission', request: { version: 1, operation: 'admission_preview' } },
    { kind: 'inventory', request: { version: 1, operation: 'inventory_preview' } },
    ...storePhases.map((operation) => ({ kind: 'store', request: { version: 1, operation } })),
    { kind: 'queues', request: { version: 1, operation: 'status' } },
    ...(protocol === 'source-abandonment-v1'
      ? [
          {
            kind: 'absence',
            request: { version: 1, certificateId: '33333333-3333-4333-8333-333333333333' },
          },
        ]
      : []),
  ];
  for (const { kind, request } of operations)
    test(`${protocol} ${kind}/${request.operation ?? 'readback'} projects only its required captured credentials`, (t) => {
      const h = fixture(t, { protocol });
      const captured = legacyColdStoreEnvironment(
        Object.entries({ ...capturedStores, ...capturedControl }).map(
          ([key, value]) => `${key}=${value}`,
        ),
      );
      writeFileSync(h.environmentFile, captured);
      if (kind === 'queues') h.state.response = { queueCount: 24, pausedCount: 0, activeCount: 0 };
      withAmbientCredentials((ambient) => {
        h.client.invoke(kind, request);
        assertCredentialProjection(
          h,
          {
            ...capturedStores,
            ...(kind === 'store' && request.operation === 'install' ? capturedControl : {}),
          },
          ambient,
        );
        assert.equal(readFileSync(h.environmentFile, 'utf8'), captured);
        assert.equal(
          h.calls.find(({ args }) => args[0] === 'start').options.input,
          JSON.stringify(request),
        );
      });
    });
}

for (const phase of ['install', 'materialize', 'readback'])
  test(`source store batch/${phase} receives independent hold control only during installation`, (t) => {
    const h = fixture(t, { protocol: 'source-abandonment-v1' });
    const captured = legacyColdStoreEnvironment(
      Object.entries({ ...capturedStores, ...capturedControl }).map(
        ([key, value]) => `${key}=${value}`,
      ),
    );
    writeFileSync(h.environmentFile, captured);
    h.state.response = {
      version: 1,
      kind: 'source_abandonment_session_store_batch_result',
      phase,
      results: [{}],
    };
    const request = batchRequest(phase);
    withAmbientCredentials((ambient) => {
      h.client.invoke('source-store-batch', request);
      assertCredentialProjection(
        h,
        { ...capturedStores, ...(phase === 'install' ? capturedControl : {}) },
        ambient,
      );
      assert.equal(readFileSync(h.environmentFile, 'utf8'), captured);
    });
  });

test('absent independent control remains absent for installation despite ambient credentials', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  const captured = legacyColdStoreEnvironment(
    Object.entries(capturedStores).map(([key, value]) => `${key}=${value}`),
  );
  writeFileSync(h.environmentFile, captured);
  withAmbientCredentials((ambient) => {
    h.client.invoke('store', { version: 1, operation: 'install' });
    assertCredentialProjection(h, capturedStores, ambient);
    assert.equal(readFileSync(h.environmentFile, 'utf8'), captured);
  });
});

for (const [name, extra] of [
  ['partial control', ['ERASER_CONTROL_URL=http://eraser:3000']],
  [
    'invalid control token',
    ['ERASER_CONTROL_URL=http://eraser:3000', 'ERASER_CONTROL_TOKEN=short'],
  ],
  [
    'foreign control origin',
    [
      'ERASER_CONTROL_URL=https://external.invalid',
      `ERASER_CONTROL_TOKEN=${capturedControl.ERASER_CONTROL_TOKEN}`,
    ],
  ],
  ['duplicate store', [`DATABASE_URL=${capturedStores.DATABASE_URL}`]],
  ['unknown MAX credential', ['MAX_BOT_TOKEN=must-not-be-forwarded']],
])
  test(`cold client refuses ${name} before any Docker call`, (t) => {
    const h = fixture(t, { protocol: 'source-abandonment-v1' });
    writeFileSync(
      h.environmentFile,
      `${[...Object.entries(capturedStores).map(([key, value]) => `${key}=${value}`), ...extra].join('\n')}\n`,
    );
    assert.throws(
      () => h.client.invoke('admission', { version: 1, operation: 'admission_preview' }),
      /client_environment_not_allowlisted/,
    );
    assert.equal(h.calls.length, 0);
  });

test('finite source writer batch mounts only the hash-bound harness and indexed inventory then removes the writer', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  h.state.response = {
    version: 1,
    kind: 'source_abandonment_session_store_batch_result',
    phase: 'install',
    results: [{}],
  };
  h.client.invoke('source-store-batch', batchRequest());
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert(
    create.includes(
      `type=bind,source=${h.sourceBatchPath},target=/app/source-abandonment-session-store-batch.cjs,readonly`,
    ),
  );
  assert(
    create.includes(
      `type=bind,source=${h.inventoryPath},target=/run/maxim-source-session/inventory-0.json,readonly`,
    ),
  );
  assert(create.includes('APP_SERVICE_NAME=source-abandonment-store'));
  assert(create.includes('MAXIM_SOURCE_ABANDONMENT_STORE_MODE=writer'));
  assert.equal(create.at(-1), '/app/source-abandonment-session-store-batch.cjs');
  assert.equal(h.exists(), false);
  assert.equal(h.calls.filter((call) => call.args[0] === 'start').length, 1);
});
test('source batch readback uses a separate read-only store pool and lost writer output never retries', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  h.state.response = {
    version: 1,
    kind: 'source_abandonment_session_store_batch_result',
    phase: 'readback',
    results: [{}],
  };
  h.client.invoke('source-store-batch', batchRequest('readback'));
  assert(
    h.calls
      .find((call) => call.args[0] === 'create')
      .args.includes('MAXIM_SOURCE_ABANDONMENT_STORE_MODE=readback'),
  );
  h.calls.length = 0;
  h.state.failStart = true;
  assert.throws(
    () => h.client.invoke('source-store-batch', batchRequest()),
    (error) => error.outcomeUnknown === true && error.message === 'client_result_unknown',
  );
  assert.equal(h.calls.filter((call) => call.args[0] === 'start').length, 1);
  assert.equal(h.exists(), false);
});
for (const change of ['harness', 'inventory', 'index', 'deadline', 'phase', 'protocol'])
  test(`source batch refuses changed ${change} before creating a container`, (t) => {
    const h = fixture(t, { protocol: change === 'protocol' ? 'legacy' : 'source-abandonment-v1' });
    const request = batchRequest();
    if (change === 'harness') writeFileSync(h.sourceBatchPath, 'changed');
    if (change === 'inventory') chmodSync(h.inventoryPath, 0o644);
    if (change === 'index') request.items[0].inventoryIndex = 1;
    if (change === 'deadline') request.deadlineAtMs = Date.now() + 300_001;
    if (change === 'phase') request.phase = 'shell';
    assert.throws(() => h.client.invoke('source-store-batch', request));
    assert.equal(h.calls.length, 0);
  });

test('unknown controller protocol is refused before creating a client', (t) => {
  assert.throws(() => fixture(t, { protocol: 'source-abandonment-v2' }), /invalid_client_binding/);
});

test('preinstall absence uses only the hash-bound readonly probe in the frozen image', (t) => {
  const h = fixture(t, { protocol: 'source-abandonment-v1' });
  h.state.response = { version: 1, state: 'ABSENT' };
  h.client.invoke('absence', { version: 1, certificateId: '33333333-3333-4333-8333-333333333333' });
  const args = h.calls.find((call) => call.args[0] === 'create').args;
  assert(args.includes('--read-only'));
  assert(
    args.includes(
      `type=bind,source=${h.absenceProbePath},target=/app/source-abandonment-absence.cjs,readonly`,
    ),
  );
  assert.equal(args.at(-1), '/app/source-abandonment-absence.cjs');
  assert(!args.some((arg) => arg.includes('STORE_MODE=') || arg.includes('inventory.json')));
  assert.equal(h.exists(), false);
  writeFileSync(h.absenceProbePath, 'changed');
  h.calls.length = 0;
  assert.throws(
    () =>
      h.client.invoke('absence', {
        version: 1,
        certificateId: '33333333-3333-4333-8333-333333333333',
      }),
    /absence_probe_binding_unproved/,
  );
  assert.equal(h.calls.length, 0);
});

test('store uses an immutable bounded client with readonly inventory and exact cleanup', (t) => {
  const h = fixture(t);
  const result = h.client.invoke('store', { version: 1, operation: 'readback' });
  assert.equal(result.state, 'SEALED');
  assert.equal(h.exists(), false);
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.ok(create.includes('MAXIM_LEGACY_RECOVERY_STORE_MODE=readback'));
  assert.ok(create.includes('--read-only'));
  assert.ok(create.includes('ALL'));
  assert.ok(create.includes('--memory'));
  assert.ok(create.includes('0.5'));
  assert.ok(
    create.includes(
      `type=bind,source=${h.inventoryPath},target=/run/maxim-legacy-recovery/inventory.json,readonly`,
    ),
  );
  assert.equal(create.includes('--privileged'), false);
  assert.deepEqual(h.calls.find((call) => call.args[0] === 'rm').args, ['rm', '-f', h.id]);
  assert.equal(h.calls.at(-1).args[0], 'ps');
  assert.equal(h.calls.filter((call) => call.args[0] === 'start').length, 1);
});

test('a bounded read-only DENY survives exit 1 without leaking stderr or allowing a writer retry', (t) => {
  const h = fixture(t);
  h.state.response = {
    version: 1,
    operation: 'admission_preview',
    decision: 'DENY',
    applied: false,
    activationAuthorized: false,
    issues: [{ code: 'source_unproved' }],
  };
  h.state.responseExit = true;
  const result = h.client.invoke('admission', { version: 1, operation: 'admission_preview' });
  assert.equal(result.decision, 'DENY');
  assert.equal(h.exists(), false);
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /result_unknown/,
  );
  assert.equal(h.exists(), false);
});

test('queue operations bind a reviewed helper and operation-specific owner without adoption', (t) => {
  const h = fixture(t);
  h.state.response = { queueCount: 24, pausedCount: 24, activeCount: 0 };
  assert.equal(h.client.invoke('queues', { version: 1, operation: 'wait-drained' }).version, 1);
  const create = h.calls.find((call) => call.args[0] === 'create').args;
  assert.equal(create.at(-1), 'wait-drained');
  assert.ok(
    create.some((arg) => /^MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN=rollout:[0-9a-f]{64}$/u.test(arg)),
  );
  assert.ok(create.includes('MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS=1000'));
  assert.equal(
    create.some((arg) => arg.includes('ADOPT_EXISTING')),
    false,
  );
  assert.equal(h.exists(), false);
  writeFileSync(h.queueControlPath, 'changed helper');
  assert.throws(
    () => h.client.invoke('queues', { version: 1, operation: 'resume' }),
    /binding_unproved/,
  );
});

test('invalid queue output never proves quiescence and the client is still removed', (t) => {
  const h = fixture(t);
  h.state.response = { queueCount: 23, pausedCount: 23, activeCount: 0 };
  assert.throws(
    () => h.client.invoke('queues', { version: 1, operation: 'wait-drained' }),
    /result_unknown/,
  );
  assert.equal(h.exists(), false);
});

for (const field of ['failCreate', 'failStart'])
  test(`lost ${field} response is cleaned without a retry or private error`, (t) => {
    const h = fixture(t);
    h.state[field] = true;
    assert.throws(
      () => h.client.invoke('store', { version: 1, operation: 'install' }),
      (error) =>
        error.message === 'client_result_unknown' &&
        error.outcomeUnknown === true &&
        error.cause === undefined,
    );
    assert.equal(h.exists(), false);
    assert.equal(h.calls.filter((call) => call.args[0] === 'create').length, 1);
    assert.ok(h.calls.filter((call) => call.args[0] === 'start').length <= 1);
  });

test('unknown removal and foreign ownership never become permission for another client', (t) => {
  const h = fixture(t);
  h.state.failRemove = true;
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /client_removal_unproved/,
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'readback' }),
    /requires_cleanup/,
  );
  h.state.foreign = true;
  const removals = h.calls.filter((call) => call.args[0] === 'rm').length;
  assert.throws(() => h.client.remove(), /ownership_unproved/);
  assert.equal(h.calls.filter((call) => call.args[0] === 'rm').length, removals);
});

test('MAX credentials, oversized stdin and unsafe input files are refused before creation', (t) => {
  const h = fixture(t);
  writeFileSync(
    h.environmentFile,
    'DATABASE_URL=postgresql://fixture/db\nMAX_BOT_TOKEN=not-a-real-token\n',
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /environment_not_allowlisted/,
  );
  assert.throws(
    () => h.client.invoke('store', { version: 1, input: 'x'.repeat(65_536) }),
    /request_budget/,
  );
  writeFileSync(
    h.environmentFile,
    'DATABASE_URL=postgresql://fixture/db\nREDIS_URL=redis://fixture/0\n',
  );
  chmodSync(h.inventoryPath, 0o644);
  assert.throws(
    () => h.client.invoke('store', { version: 1, operation: 'install' }),
    /unsafe_client_input/,
  );
  assert.equal(h.calls.length, 0);
});
