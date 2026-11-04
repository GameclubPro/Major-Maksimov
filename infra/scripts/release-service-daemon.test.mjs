import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperationStore, requestHash } from './release-operation-store.mjs';
import { exchangeControlFrame } from './release-service-gateway.mjs';
import { buildReleaseManifest } from './release-manifest.mjs';
import {
  observeReleaseChild,
  observeReviewChild,
  parseChildEvent,
  processIdentity,
  readInstalledReleaseInventory,
  ReleaseService,
} from './release-service-daemon.mjs';

const request = (patch = {}) => ({
  schemaVersion: 1,
  id: randomUUID(),
  sourceSha: 'a'.repeat(40),
  expectedManifestSha256: null,
  trigger: 'operator',
  images: [],
  ...patch,
});
const childEvent = (summary, event, reasonCode) => ({
  schemaVersion: 1,
  event,
  id: summary.id,
  requestHash: summary.requestHash,
  ...(reasonCode === undefined ? {} : { reasonCode }),
});
const wire = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const eventCode = (event, reasonCode) =>
  `const event=${JSON.stringify(event)}; const reason=${JSON.stringify(reasonCode)};`;

function installedManifest() {
  return buildReleaseManifest({
    releaseId: 'installed-fixture',
    targetSha: 'd'.repeat(40),
    createdAt: '2026-11-04T04:00:00.000Z',
    components: [
      ['api-shared', 'maxim-api'],
      ['miniapp-major-static', 'maxim-miniapp-major'],
      ['admin-static', 'maxim-admin'],
    ].map(([id, alias], index) => ({
      id,
      sourceSha: 'd'.repeat(40),
      imageRef: `${alias}:${'d'.repeat(40)}`,
      imageId: `sha256:${String(index + 1).repeat(64)}`,
    })),
  });
}

function protocolChild(summary, log, event = 'PREPARED', reasonCode, exit = 0, extra = '') {
  const source = `
    const fs=require('node:fs');
    ${eventCode(event, reasonCode)}
    const payload={schemaVersion:1,event,id:process.argv[1],requestHash:process.argv[2]};
    if(reason!==undefined)payload.reasonCode=reason;
    fs.writeSync(3,JSON.stringify(payload)+'\\n');
    ${event === 'READY' ? `const got=fs.readFileSync(4).toString('utf8'); if(got!=='PROCEED:'+process.argv[1]+':'+process.argv[2]+'\\n')process.exit(91);` : ''}
    ${extra}
    process.exit(${exit});
  `;
  return spawn(process.execPath, ['-e', source, summary.id, summary.requestHash], {
    detached: true,
    stdio: ['ignore', log, log, 'pipe', 'pipe'],
  });
}

function reconciliationChild(
  summary,
  expectedManifestSha256,
  log,
  { kind = 'RECOVERED', exit = 0, raw } = {},
) {
  const payload =
    raw ??
    `${JSON.stringify({ schemaVersion: 1, kind, evidenceSha256: 'e'.repeat(64), manifestSha256: expectedManifestSha256 })}\n`;
  const child = spawn(
    process.execPath,
    ['-e', `require('node:fs').writeSync(1,${JSON.stringify(payload)}); process.exit(${exit});`],
    {
      detached: true,
      stdio: ['ignore', 'pipe', log],
    },
  );
  return observeReviewChild(child, {
    summary,
    expectedManifestSha256,
    timeoutMs: 1500,
    killGraceMs: 20,
  });
}

async function until(callback, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(callback, overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-daemon-'));
  const directory = join(root, 'state');
  fs.mkdirSync(directory, { mode: 0o700 });
  const installedDirectory = join(root, 'installed');
  fs.mkdirSync(installedDirectory, { mode: 0o700 });
  fs.writeFileSync(
    join(installedDirectory, 'current.json'),
    `${JSON.stringify(installedManifest(), null, 2)}\n`,
    { mode: 0o600 },
  );
  const policy = {
    schemaVersion: 1,
    paused: false,
    autoEnabled: true,
    policySha256: 'b'.repeat(64),
  };
  const service = new ReleaseService({
    directory,
    socketPath: join(root, 'run', 'control.sock'),
    adminSocketPath: join(root, 'run', 'admin.sock'),
    policyReader: () => ({ ...policy }),
    policyResumer: ({ expectedPolicySha256 }) => {
      if (expectedPolicySha256 !== policy.policySha256) {
        const error = new Error('stale');
        error.code = 'STALE_POLICY';
        throw error;
      }
      policy.paused = false;
      return { ...policy };
    },
    readInventory: () =>
      readInstalledReleaseInventory({ directory: installedDirectory, floor: root }),
    spawnPrepare: (summary, log) => protocolChild(summary, log),
    spawnExecutor: (summary, log) => protocolChild(summary, log, 'READY'),
    validateResult: async () => true,
    reconcileReview: (summary, expectedManifestSha256, log) =>
      reconciliationChild(summary, expectedManifestSha256, log),
    prepareTimeoutMs: 1500,
    executorTimeoutMs: 1500,
    socketTimeoutMs: 100,
    adminSocketTimeoutMs: 1500,
    heartbeatMs: 20,
    retryDelayMs: 5,
    lockDeadlineMs: 2000,
    killGraceMs: 20,
    ...overrides,
  });
  try {
    await service.start();
    await callback({
      service,
      root,
      directory,
      installedDirectory,
      policy,
      send: (frame, admin = false) =>
        exchangeControlFrame(frame, {
          socketPath: admin ? service.adminSocketPath : service.socketPath,
          timeoutMs: 3000,
        }),
    });
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('protocol event requires exact identity and keys without free-form error content', () => {
  const input = request();
  const summary = { id: input.id, requestHash: requestHash(input) };
  assert.deepEqual(
    parseChildEvent(wire(childEvent(summary, 'READY')), summary),
    childEvent(summary, 'READY'),
  );
  for (const value of [
    { ...childEvent(summary, 'READY'), extra: 'secret' },
    { ...childEvent(summary, 'READY'), id: randomUUID() },
    { ...childEvent(summary, 'READY'), requestHash: 'c'.repeat(64) },
    childEvent(summary, 'UNKNOWN'),
    childEvent(summary, 'SAFE_REFUSAL'),
    childEvent(summary, 'SAFE_REFUSAL', 'private message'),
    childEvent(summary, 'PREPARED', 'UNEXPECTED'),
  ])
    assert.throws(() => parseChildEvent(wire(value), summary));
});

test('Unix inventory exposes the exact installed manifest byte hash and a bounded identity projection', async () => {
  await fixture(async ({ send, service, installedDirectory }) => {
    const path = join(installedDirectory, 'current.json');
    const manifest = { ...installedManifest(), privateDiagnostic: 'must-never-cross-inventory' };
    const raw = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path, raw);
    const response = await send({ operation: 'inventory' });
    assert.equal(response.ok, true);
    const installed = response.result.installedRelease;
    assert.equal(installed.status, 'PROVED');
    assert.equal(installed.manifestSha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(installed.releaseId, manifest.releaseId);
    assert.equal(installed.targetSha, manifest.targetSha);
    assert.ok(Number.isFinite(Date.parse(installed.observedAt)));
    assert.deepEqual(installed.components['api-shared'], {
      sourceSha: manifest.components['api-shared'].sourceSha,
      imageRef: manifest.components['api-shared'].imageRef,
      imageId: manifest.components['api-shared'].imageId,
    });
    assert.ok(!JSON.stringify(response).includes('must-never-cross-inventory'));
    const input = request({ expectedManifestSha256: installed.manifestSha256 });
    const accepted = await send({ operation: 'submit', request: input });
    assert.equal(accepted.result.expectedManifestSha256, installed.manifestSha256);
    await until(() => service.store.get(input.id)?.state === 'SUCCEEDED', 'manifest-bound release');
  });
});

test('missing, incomplete, malformed or unsafe installed manifests report unproved without an invented hash', async () => {
  const mutations = [
    (path) => fs.unlinkSync(path),
    (path) => fs.writeFileSync(path, '{invalid private manifest'),
    (path) => fs.writeFileSync(path, ''),
    (path) => fs.writeFileSync(path, ' '.repeat(1024 * 1024 + 1)),
    (path) => fs.writeFileSync(path, JSON.stringify({ ...installedManifest(), components: {} })),
    (path) =>
      fs.writeFileSync(path, JSON.stringify({ ...installedManifest(), createdAt: 'invalid' })),
    (path) => fs.chmodSync(path, 0o666),
    (path) => {
      const target = `${path}.retained`;
      fs.renameSync(path, target);
      fs.symlinkSync(target, path);
    },
    (path) => fs.linkSync(path, `${path}.hardlink`),
    (_path, directory) => fs.chmodSync(directory, 0o777),
  ];
  for (const mutate of mutations) {
    await fixture(async ({ send, installedDirectory }) => {
      mutate(join(installedDirectory, 'current.json'), installedDirectory);
      const response = await send({ operation: 'inventory' });
      assert.equal(response.ok, true);
      assert.deepEqual(Object.keys(response.result.installedRelease).sort(), [
        'observedAt',
        'reasonCode',
        'status',
      ]);
      assert.equal(response.result.installedRelease.status, 'UNPROVED');
      assert.equal(response.result.installedRelease.reasonCode, 'MANIFEST_UNPROVED');
      assert.equal(Object.hasOwn(response.result.installedRelease, 'manifestSha256'), false);
    });
  }
});

test('inventory reader rejects a symlinked state directory and supports an injected observation boundary', async () => {
  await fixture(async ({ root, installedDirectory }) => {
    const link = join(root, 'linked-installed');
    fs.symlinkSync(installedDirectory, link);
    assert.equal(
      readInstalledReleaseInventory({ directory: link, floor: root }).status,
      'UNPROVED',
    );
  });
  const observed = {
    status: 'UNPROVED',
    observedAt: '2026-11-04T04:00:00.000Z',
    reasonCode: 'MANIFEST_UNPROVED',
  };
  await fixture(
    async ({ send }) => {
      const result = await send({ operation: 'inventory' });
      assert.deepEqual(result.result.installedRelease, observed);
    },
    { readInventory: () => observed },
  );
});

test('real child READY authorizes one exact FD4 line after durable EXECUTING write', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-fd-'));
  const store = new OperationStore({ directory: join(root, 'operations') });
  const submitted = store.submit(request());
  store.transition(submitted.id, 'QUEUED', 'ADMITTING');
  const log = fs.openSync(join(root, 'child.log'), 'wx', 0o600);
  const child = protocolChild(submitted, log, 'READY');
  try {
    const result = await observeReleaseChild(child, {
      summary: submitted,
      expectedEvent: 'READY',
      timeoutMs: 1500,
      onReady: () => {
        store.transition(submitted.id, 'ADMITTING', 'EXECUTING');
        assert.equal(
          new OperationStore({ directory: join(root, 'operations') }).get(submitted.id).state,
          'EXECUTING',
        );
      },
    });
    assert.equal(result.invalid, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitProved, true);
    assert.equal(result.event.event, 'READY');
    assert.equal(store.get(submitted.id).state, 'EXECUTING');
  } finally {
    fs.closeSync(log);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real process identity records exact Linux boot and start tick', () => {
  const current = processIdentity(process.pid, 'a'.repeat(40));
  assert.equal(current.pid, process.pid);
  assert.match(current.bootId, /^[a-f0-9-]{36}$/u);
  assert.match(current.startTicks, /^[0-9]+$/u);
  assert.equal(current.sourceSha, 'a'.repeat(40));
});

test('Unix submit returns durable identity, deduplicates, and serializes successful operations', async () => {
  const children = [];
  let active = 0;
  let maximum = 0;
  await fixture(
    async ({ send, service }) => {
      const first = request();
      const repeated = await Promise.all([
        send({ operation: 'submit', request: first }),
        send({ operation: 'submit', request: first }),
      ]);
      assert.equal(repeated[0].result.id, first.id);
      assert.equal(repeated[1].result.requestHash, requestHash(first));
      const second = request();
      await send({ operation: 'submit', request: second });
      await until(
        () => service.store.get(second.id)?.state === 'SUCCEEDED',
        'both serialized operations',
      );
      assert.equal(service.store.get(first.id).state, 'SUCCEEDED');
      assert.equal(maximum, 1);
      assert.equal(children.length, 2);
      const status = await send({ operation: 'status', id: first.id });
      assert.equal(status.result.executor.sourceSha, first.sourceSha);
      assert.ok(status.result.lastHeartbeatAt);
      const conflict = await send({
        operation: 'submit',
        request: { ...first, sourceSha: 'c'.repeat(40) },
      });
      assert.equal(conflict.error.code, 'ID_CONFLICT');
    },
    {
      spawnExecutor: (summary, log) => {
        active += 1;
        maximum = Math.max(maximum, active);
        const child = protocolChild(
          summary,
          log,
          'READY',
          undefined,
          0,
          'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);',
        );
        children.push(child);
        child.once('close', () => {
          active -= 1;
        });
        return child;
      },
    },
  );
});

test('SSH disconnect does not cancel accepted operation or create another execution', async () => {
  let executions = 0;
  await fixture(
    async ({ send, service }) => {
      const input = request();
      const socket = createConnection(service.socketPath);
      socket.on('error', () => {});
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(wire({ operation: 'submit', request: input }));
      await until(() => service.store.get(input.id), 'accepted before disconnect');
      socket.destroy();
      await until(
        () => service.store.get(input.id)?.state === 'SUCCEEDED',
        'independent completion',
      );
      const repeated = await send({ operation: 'submit', request: input });
      assert.equal(repeated.result.state, 'SUCCEEDED');
      assert.equal(executions, 1);
    },
    {
      spawnExecutor: (summary, log) => {
        executions += 1;
        return protocolChild(summary, log, 'READY');
      },
    },
  );
});

test('repeated successful Unix responses release daemon connections before fixture teardown', async () => {
  await fixture(async ({ send, service }) => {
    for (let index = 0; index < 16; index += 1) {
      const response = await send({ operation: 'inventory' }, index % 2 === 1);
      assert.equal(response.ok, true);
      assert.equal(response.result.installedRelease.status, 'PROVED');
      await until(
        () => service.connections.size === 0,
        `response ${index + 1} connection cleanup`,
        1000,
      );
    }
    assert.equal(service.connections.size, 0);
    assert.equal(service.stopping, false);
  });
});

test('an unread Unix peer cannot retain the connection after a response or request timeout', async () => {
  await fixture(async ({ service }) => {
    for (const complete of [true, false]) {
      const peer = createConnection(service.socketPath);
      peer.on('error', () => {});
      peer.pause();
      try {
        await new Promise((resolve, reject) => {
          peer.once('connect', resolve);
          peer.once('error', reject);
        });
        await until(() => service.connections.size === 1, 'unread peer connection');
        peer.write(complete ? wire({ operation: 'inventory' }) : Buffer.from('{"operation":'));
        await until(
          () => service.connections.size === 0,
          complete ? 'unread response connection cleanup' : 'unread timed-out connection cleanup',
          1500,
        );
        assert.equal(service.stopping, false);
      } finally {
        peer.destroy();
      }
    }
  });
});

test('positive correlated prepare refusal distinguishes SUPERSEDED from uncertainty', async () => {
  let executions = 0;
  await fixture(
    async ({ send, service }) => {
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'SUPERSEDED',
        'safe superseded refusal',
      );
      assert.equal(executions, 0);
      assert.equal(service.store.hasUncertain(), false);
    },
    {
      spawnPrepare: (summary, log) => protocolChild(summary, log, 'SAFE_REFUSAL', 'SUPERSEDED', 86),
      spawnExecutor: () => {
        executions += 1;
        throw new Error('must not execute');
      },
    },
  );
});

test('a correlated executor refusal with exit86 is terminal before runtime and allows the next release', async () => {
  for (const reasonCode of ['SUPERSEDED', 'COMPONENT_PLAN_CHANGED']) {
    let attempts = 0;
    let validations = 0;
    await fixture(
      async ({ send, service }) => {
        const first = request();
        await send({ operation: 'submit', request: first });
        const terminal = reasonCode === 'SUPERSEDED' ? 'SUPERSEDED' : 'REJECTED';
        await until(
          () => service.store.get(first.id)?.state === terminal,
          'proved executor refusal',
        );
        assert.equal(service.store.get(first.id).reasonCode, reasonCode);
        assert.equal(service.store.get(first.id).attemptCount, 1);
        assert.equal(service.store.hasUncertain(), false);
        assert.equal(validations, 0);
        const next = request();
        await send({ operation: 'submit', request: next });
        await until(
          () => service.store.get(next.id)?.state === 'SUCCEEDED',
          'release after safe refusal',
        );
        assert.equal(attempts, 2);
        assert.equal(validations, 1);
      },
      {
        spawnExecutor: (summary, log) =>
          ++attempts === 1
            ? protocolChild(summary, log, 'SAFE_REFUSAL', reasonCode, 86)
            : protocolChild(summary, log, 'READY'),
        validateResult: async () => {
          validations += 1;
          return true;
        },
      },
    );
  }
});

test('exit86 without an exact pre-runtime refusal remains uncertain and is never retried', async () => {
  for (const mode of ['untyped', 'wrong-id', 'wrong-exit', 'after-ready']) {
    let attempts = 0;
    await fixture(
      async ({ send, service }) => {
        const input = request();
        await send({ operation: 'submit', request: input });
        await until(
          () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
          `unproved refusal ${mode}`,
        );
        assert.equal(attempts, 1);
        assert.equal(service.store.hasUncertain(), true);
        const next = await send({ operation: 'submit', request: request() });
        assert.equal(next.error.code, 'UNRESOLVED_REVIEW');
      },
      {
        spawnExecutor: (summary, log) => {
          attempts += 1;
          if (mode === 'untyped')
            return spawn(process.execPath, ['-e', 'process.exit(86)'], {
              detached: true,
              stdio: ['ignore', log, log, 'pipe', 'pipe'],
            });
          if (mode === 'wrong-id')
            return protocolChild(
              { ...summary, id: randomUUID() },
              log,
              'SAFE_REFUSAL',
              'SUPERSEDED',
              86,
            );
          if (mode === 'wrong-exit')
            return protocolChild(summary, log, 'SAFE_REFUSAL', 'SUPERSEDED', 85);
          return protocolChild(summary, log, 'READY', undefined, 86);
        },
      },
    );
  }
});

test('only typed LOCK_BUSY plus child exit75 retries the same prepared executor', async () => {
  let preparations = 0;
  const children = [];
  await fixture(
    async ({ send, service }) => {
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'SUCCEEDED',
        'lock retry completion',
      );
      const result = service.store.get(input.id);
      assert.equal(preparations, 1);
      assert.equal(children.length, 2);
      assert.equal(result.attemptCount, 2);
      assert.equal(result.reasonCode, null);
    },
    {
      spawnPrepare: (summary, log) => {
        preparations += 1;
        return protocolChild(summary, log);
      },
      spawnExecutor: (summary, log) => {
        if (children.length) assert.equal(children.at(-1).exitCode, 75);
        const child =
          children.length === 0
            ? protocolChild(summary, log, 'SAFE_REFUSAL', 'LOCK_BUSY', 75)
            : protocolChild(summary, log, 'READY');
        children.push(child);
        return child;
      },
    },
  );
});

test('sixteen safe lock refusals exhaust the bounded attempt budget without re-preparing', async () => {
  let preparations = 0;
  let attempts = 0;
  await fixture(
    async ({ send, service }) => {
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'REJECTED',
        'bounded lock exhaustion',
        10000,
      );
      assert.equal(service.store.get(input.id).reasonCode, 'LOCK_WAIT_EXHAUSTED');
      assert.equal(attempts, 16);
      assert.equal(preparations, 1);
      assert.equal(service.store.hasUncertain(), false);
    },
    {
      spawnPrepare: (summary, log) => {
        preparations += 1;
        return protocolChild(summary, log);
      },
      spawnExecutor: (summary, log) => {
        attempts += 1;
        return protocolChild(summary, log, 'SAFE_REFUSAL', 'LOCK_BUSY', 75);
      },
      lockDeadlineMs: 10000,
    },
  );
});

test('untyped exit75, failed smoke, or unmatched event never permits retry or next release', async () => {
  for (const mode of ['untyped', 'failed-smoke', 'wrong-id']) {
    let executions = 0;
    await fixture(
      async ({ send, service }) => {
        const input = request();
        await send({ operation: 'submit', request: input });
        await until(() => service.store.get(input.id)?.state === 'NEEDS_REVIEW', mode);
        const next = await send({ operation: 'submit', request: request() });
        assert.equal(next.error.code, 'UNRESOLVED_REVIEW');
        assert.equal(executions, 1);
      },
      {
        spawnExecutor: (summary, log) => {
          executions += 1;
          if (mode === 'wrong-id')
            return protocolChild({ ...summary, id: randomUUID() }, log, 'READY');
          if (mode === 'untyped')
            return spawn(process.execPath, ['-e', 'process.exit(75)'], {
              detached: true,
              stdio: ['ignore', log, log, 'pipe', 'pipe'],
            });
          return protocolChild(summary, log, 'READY', undefined, 17);
        },
      },
    );
  }
});

test('zero runtime exit still requires independent asynchronous result validation', async () => {
  let validations = 0;
  await fixture(
    async ({ send, service }) => {
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
        'failed independent final validation',
      );
      assert.equal(service.store.get(input.id).reasonCode, 'RESULT_NOT_PROVED');
      assert.equal(validations, 1);
    },
    {
      validateResult: async () => {
        validations += 1;
        return false;
      },
    },
  );
});

test('pause blocks both triggers; administrator resume is separate and optimistic', async () => {
  await fixture(async ({ policy, send, service }) => {
    policy.paused = true;
    for (const trigger of ['automatic', 'operator']) {
      const denied = await send({ operation: 'submit', request: request({ trigger }) });
      assert.equal(denied.error.code, 'POLICY_PAUSED');
    }
    const deniedResume = await send({
      operation: 'resume',
      expectedPolicySha256: policy.policySha256,
    });
    assert.equal(deniedResume.error.code, 'INVALID_COMMAND');
    const stale = await send({ operation: 'resume', expectedPolicySha256: 'c'.repeat(64) }, true);
    assert.equal(stale.error.code, 'STALE_POLICY');
    await send({ operation: 'resume', expectedPolicySha256: policy.policySha256 }, true);
    policy.autoEnabled = false;
    const deniedAuto = await send({
      operation: 'submit',
      request: request({ trigger: 'automatic' }),
    });
    assert.equal(deniedAuto.error.code, 'AUTOMATIC_DISABLED');
    const accepted = await send({ operation: 'submit', request: request() });
    await until(
      () => service.store.get(accepted.result.id)?.state === 'SUCCEEDED',
      'manual release after resume',
    );
    assert.equal(fs.statSync(service.adminSocketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(service.socketPath).mode & 0o777, 0o660);
  });
});

test('a submit during pump completion is picked up by the next worker without another wake request', async () => {
  await fixture(async ({ service, send }) => {
    if (service.running) await service.running;
    const originalPump = service.pump.bind(service);
    const input = request();
    let inject = true;
    service.pump = async () => {
      await originalPump();
      if (inject) {
        inject = false;
        const accepted = await send({ operation: 'submit', request: input });
        assert.equal(accepted.result.state, 'QUEUED');
      }
    };
    service.wake();
    await until(
      () => service.store.get(input.id)?.state === 'SUCCEEDED',
      'submit during ending pump',
    );
    assert.equal(service.store.get(input.id).attemptCount, 1);
  });
});

test('a paused queue waits for privileged resume while an accepted runtime finishes', async () => {
  let attempts = 0;
  let releasePath;
  await fixture(
    async ({ service, send, policy, root }) => {
      releasePath = join(root, 'runtime-may-finish');
      const first = request();
      await send({ operation: 'submit', request: first });
      await until(
        () => service.store.get(first.id)?.state === 'EXECUTING',
        'accepted runtime before pause',
      );
      const queued = request();
      await send({ operation: 'submit', request: queued });
      policy.paused = true;
      const denied = await send({ operation: 'submit', request: request() });
      assert.equal(denied.error.code, 'POLICY_PAUSED');
      fs.writeFileSync(releasePath, 'allowed');
      await until(
        () => service.store.get(first.id)?.state === 'SUCCEEDED',
        'accepted runtime after pause',
      );
      if (service.running) await service.running;
      assert.equal(service.store.get(queued.id).state, 'QUEUED');
      assert.equal(attempts, 1);
      const resumed = await send(
        { operation: 'resume', expectedPolicySha256: policy.policySha256 },
        true,
      );
      assert.equal(resumed.ok, true);
      await until(
        () => service.store.get(queued.id)?.state === 'SUCCEEDED',
        'queued operation after explicit resume',
      );
      assert.equal(attempts, 2);
    },
    {
      spawnExecutor: (summary, log) => {
        attempts += 1;
        return protocolChild(
          summary,
          log,
          'READY',
          undefined,
          0,
          `while(!fs.existsSync(${JSON.stringify(releasePath)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`,
        );
      },
    },
  );
});

test('only the privileged Unix command can persist a locked verified review resolution and it preserves pause', async () => {
  let reconciliations = 0;
  for (const kind of ['RECOVERED', 'UNCHANGED']) {
    await fixture(
      async ({ send, service, policy }) => {
        const input = request();
        await send({ operation: 'submit', request: input });
        await until(
          () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
          'review before privileged verification',
        );
        if (service.running) await service.running;
        policy.paused = true;
        const inventory = await send({ operation: 'inventory' });
        const expectedManifestSha256 = inventory.result.installedRelease.manifestSha256;
        const frame = { operation: 'resolve_review', id: input.id, expectedManifestSha256 };
        const publicDenied = await send(frame);
        assert.equal(publicDenied.error.code, 'INVALID_COMMAND');
        const rejectedOverride = await send({ ...frame, evidenceSha256: 'f'.repeat(64) }, true);
        assert.equal(rejectedOverride.error.code, 'INVALID_COMMAND');
        const result = await send(frame, true);
        assert.equal(result.ok, true);
        assert.equal(result.result.state, 'NEEDS_REVIEW');
        assert.equal(result.result.resolution.kind, kind);
        assert.equal(service.store.hasUncertain(), false);
        assert.equal(policy.paused, true);
        const stillPaused = await send({ operation: 'submit', request: request() });
        assert.equal(stillPaused.error.code, 'POLICY_PAUSED');
        const retained = await send(frame, true);
        assert.equal(retained.error.code, 'INVALID_RESOLUTION_STATE');
      },
      {
        spawnExecutor: (summary, log) => protocolChild(summary, log, 'READY', undefined, 17),
        reconcileReview: (summary, hash, log) => {
          reconciliations += 1;
          assert.equal(summary.state, 'NEEDS_REVIEW');
          assert.equal(fs.fstatSync(log).mode & 0o777, 0o600);
          return reconciliationChild(summary, hash, log, { kind });
        },
      },
    );
  }
  assert.equal(reconciliations, 2);
});

test('unknown reconciliation output or failed child cannot close review or leak private output', async () => {
  for (const mode of [
    'exit',
    'malformed',
    'wrong-hash',
    'extra-line',
    'oversized',
    'injected-extra',
  ]) {
    await fixture(
      async ({ send, service }) => {
        const input = request();
        await send({ operation: 'submit', request: input });
        await until(
          () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
          'retained uncertain runtime',
        );
        if (service.running) await service.running;
        const result = await send(
          { operation: 'resolve_review', id: input.id, expectedManifestSha256: 'b'.repeat(64) },
          true,
        );
        assert.equal(result.ok, false, mode);
        assert.equal(result.error.code, 'RESOLUTION_UNPROVED');
        assert.ok(!JSON.stringify(result).includes('private-child-detail'));
        assert.equal(service.store.get(input.id).resolution, null);
        assert.equal(service.store.hasUncertain(), true);
        const next = await send({ operation: 'submit', request: request() });
        assert.equal(next.error.code, 'UNRESOLVED_REVIEW');
      },
      {
        spawnExecutor: (summary, log) => protocolChild(summary, log, 'READY', undefined, 17),
        reconcileReview: (summary, hash, log) => {
          if (mode === 'injected-extra')
            return {
              kind: 'RECOVERED',
              evidenceSha256: 'e'.repeat(64),
              manifestSha256: hash,
              private: 'private-child-detail',
            };
          if (mode === 'exit') return reconciliationChild(summary, hash, log, { exit: 17 });
          if (mode === 'malformed')
            return reconciliationChild(summary, hash, log, { raw: '{private-child-detail}\n' });
          if (mode === 'wrong-hash')
            return reconciliationChild(summary, hash, log, {
              raw: `${JSON.stringify({ schemaVersion: 1, kind: 'RECOVERED', evidenceSha256: 'e'.repeat(64), manifestSha256: 'c'.repeat(64) })}\n`,
            });
          if (mode === 'oversized')
            return reconciliationChild(summary, hash, log, {
              raw: `${'private-child-detail'.repeat(500)}\n`,
            });
          return reconciliationChild(summary, hash, log, {
            raw: `${JSON.stringify({ schemaVersion: 1, kind: 'RECOVERED', evidenceSha256: 'e'.repeat(64), manifestSha256: hash })}\nprivate-child-detail\n`,
          });
        },
      },
    );
  }
});

test('concurrent privileged reconciliation is serialized and cannot wake another release', async () => {
  let finishProof;
  let calls = 0;
  await fixture(
    async ({ send, service, policy }) => {
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
        'review before concurrent reconcile',
      );
      if (service.running) await service.running;
      policy.paused = true;
      const hash = 'b'.repeat(64);
      const frame = { operation: 'resolve_review', id: input.id, expectedManifestSha256: hash };
      const first = send(frame, true);
      await until(() => service.recovering === input.id, 'active reconcile');
      const second = await send(frame, true);
      assert.equal(second.error.code, 'RESOLUTION_BUSY');
      const inventory = await send({ operation: 'inventory' });
      assert.equal(inventory.result.activeRecovery, input.id);
      service.wake();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(service.running, null);
      finishProof({ kind: 'UNCHANGED', evidenceSha256: 'e'.repeat(64), manifestSha256: hash });
      assert.equal((await first).ok, true);
      assert.equal(calls, 1);
      assert.equal(service.recovering, null);
      assert.equal(policy.paused, true);
    },
    {
      spawnExecutor: (summary, log) => protocolChild(summary, log, 'READY', undefined, 17),
      reconcileReview: () => {
        calls += 1;
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 1000);
          finishProof = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
      },
    },
  );
});

test('privileged reconciliation refuses an active worker and shutdown preserves unresolved review', async () => {
  let releasePath;
  let calls = 0;
  await fixture(
    async ({ send, service, root }) => {
      releasePath = join(root, 'executor-may-finish');
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(
        () => service.store.get(input.id)?.state === 'EXECUTING',
        'runtime active during admin request',
      );
      const denied = await send(
        { operation: 'resolve_review', id: input.id, expectedManifestSha256: 'b'.repeat(64) },
        true,
      );
      assert.equal(denied.error.code, 'RESOLUTION_BUSY');
      assert.equal(calls, 0);
      fs.writeFileSync(releasePath, 'allowed');
      await until(
        () => service.store.get(input.id)?.state === 'NEEDS_REVIEW',
        'failed runtime retained for shutdown',
      );
      if (service.running) await service.running;
      let finishProof;
      service.reconcileReview = () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 1000);
          finishProof = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
      const pending = send(
        { operation: 'resolve_review', id: input.id, expectedManifestSha256: 'b'.repeat(64) },
        true,
      ).catch(() => null);
      await until(() => service.recovering === input.id, 'reconciliation before shutdown');
      const stopped = service.stop();
      finishProof({
        kind: 'RECOVERED',
        evidenceSha256: 'e'.repeat(64),
        manifestSha256: 'b'.repeat(64),
      });
      await stopped;
      await pending;
      assert.equal(service.store.get(input.id).resolution, null);
      assert.equal(service.store.hasUncertain(), true);
      assert.equal(service.recovering, null);
    },
    {
      spawnExecutor: (summary, log) =>
        protocolChild(
          summary,
          log,
          'READY',
          undefined,
          17,
          `while(!fs.existsSync(${JSON.stringify(releasePath)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`,
        ),
      reconcileReview: () => {
        calls += 1;
        throw new Error('must not reconcile active runtime');
      },
    },
  );
});

test('a failed queue transition marks the worker unavailable instead of retrying the uncertain write', async () => {
  let spawned = 0;
  await fixture(
    async ({ service, send }) => {
      if (service.running) await service.running;
      const transition = service.store.transition.bind(service.store);
      let failOnce = true;
      service.store.transition = (...args) => {
        if (failOnce && args[1] === 'QUEUED') {
          failOnce = false;
          throw new Error('simulated uncertain state write');
        }
        return transition(...args);
      };
      const input = request();
      await send({ operation: 'submit', request: input });
      await until(() => service.fatal, 'fatal worker after uncertain write');
      const observed = await send({ operation: 'inventory' });
      assert.equal(observed.result.workerAvailable, false);
      assert.equal(service.store.get(input.id).state, 'QUEUED');
      assert.equal(spawned, 0);
      const denied = await send({ operation: 'submit', request: request() });
      assert.equal(denied.error.code, 'DAEMON_UNAVAILABLE');
    },
    {
      spawnPrepare: () => {
        spawned += 1;
        throw new Error('must not start');
      },
    },
  );
});

test('daemon restart recovers active and waiting operations as review and never respawns them', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-restart-'));
  const directory = join(root, 'state');
  fs.mkdirSync(directory, { mode: 0o700 });
  const store = new OperationStore({ directory: join(directory, 'operations') });
  const input = request();
  store.submit(input);
  store.transition(input.id, 'QUEUED', 'ADMITTING');
  store.transition(input.id, 'ADMITTING', 'WAITING_LOCK', { reasonCode: 'LOCK_BUSY' });
  let spawned = 0;
  const service = new ReleaseService({
    directory,
    socketPath: join(root, 'run', 'control.sock'),
    adminSocketPath: join(root, 'run', 'admin.sock'),
    policyReader: () => ({ paused: false, autoEnabled: true }),
    spawnPrepare: () => {
      spawned += 1;
      throw new Error('must not respawn');
    },
  });
  try {
    await service.start();
    assert.equal(service.store.get(input.id).state, 'NEEDS_REVIEW');
    assert.equal(service.store.get(input.id).reasonCode, 'DAEMON_RESTART');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawned, 0);
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing socket or file is preserved rather than unlinked on startup', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-socket-'));
  const directory = join(root, 'state');
  fs.mkdirSync(directory, { mode: 0o700 });
  const path = join(root, 'existing.sock');
  fs.writeFileSync(path, 'retained evidence', { mode: 0o600 });
  const service = new ReleaseService({
    directory,
    socketPath: path,
    adminSocketPath: join(root, 'admin.sock'),
    policyReader: () => ({ paused: true }),
  });
  try {
    await assert.rejects(service.start(), (error) => error.code === 'SOCKET_EXISTS');
    assert.equal(fs.readFileSync(path).toString('utf8'), 'retained evidence');
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('socket framing rejects shell-like operations and raw error details', async () => {
  await fixture(async ({ send }) => {
    for (const frame of [
      { operation: 'shell', command: 'private command' },
      { operation: 'inventory', extra: true },
      { operation: 'status', id: randomUUID(), extra: true },
      { operation: 'submit', request: { ...request(), private: true } },
      { operation: 'resolve-review', id: randomUUID() },
    ]) {
      const result = await send(frame);
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result.error), ['code']);
      assert.ok(['INVALID_COMMAND', 'INVALID_REQUEST'].includes(result.error.code));
    }
  });
});
