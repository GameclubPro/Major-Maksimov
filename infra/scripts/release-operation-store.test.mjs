import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registryArtifactName } from './registry-preload-host.mjs';
import { OperationStore, requestHash, validateReleaseRequest } from './release-operation-store.mjs';

const sourceSha = 'a'.repeat(40);
const manifestSha256 = 'b'.repeat(64);
const time = Date.parse('2026-11-04T03:00:00Z');

function request(patch = {}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha,
    expectedManifestSha256: manifestSha256,
    trigger: 'operator',
    images: [],
    ...patch,
  };
}

function imageProof(component = 'api') {
  const aliases = {
    api: 'maxim-api',
    miniapp: 'maxim-miniapp-major',
    admin: 'maxim-admin',
    eraser: 'maxim-eraser',
  };
  const record = {
    schemaVersion: 1,
    component,
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha: sourceSha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runId: '123',
      runAttempt: '2',
      runnerEnvironment: 'github-hosted',
      event: 'push',
    },
    image: {
      alias: `${aliases[component]}:${sourceSha}`,
      imageId: `sha256:${'c'.repeat(64)}`,
      platform: 'linux/amd64',
      sizeBytes: 123456,
    },
    registry: {
      repository: `ghcr.io/gameclubpro/major-maksimov-private-v1-${component}`,
      digest: `sha256:${'d'.repeat(64)}`,
    },
  };
  return {
    record,
    artifact: { id: 456, name: registryArtifactName(record), digest: `sha256:${'e'.repeat(64)}` },
    verifiedAt: new Date(time).toISOString(),
  };
}

function withStore(callback, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-release-store-'));
  const directory = join(root, 'state');
  let clock = time;
  const settings = { directory, now: () => clock, ...options };
  try {
    callback({
      store: new OperationStore(settings),
      root,
      directory,
      settings,
      stateFile: join(directory, 'state.json'),
      advance: (milliseconds = 1000) => {
        clock += milliseconds;
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function admit(store, id) {
  store.transition(id, 'QUEUED', 'ADMITTING');
}

function execute(store, id) {
  admit(store, id);
  store.transition(id, 'ADMITTING', 'EXECUTING');
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error.code === code, code);
}

test('historical exact-source image proofs are accepted without expiring stored operations', () => {
  withStore(({ store, settings, advance }) => {
    const input = request({ images: ['api', 'miniapp', 'admin', 'eraser'].map(imageProof) });
    const accepted = store.submit(input);
    assert.deepEqual(accepted.components, ['api', 'miniapp', 'admin', 'eraser']);
    advance(365 * 86400_000);
    assert.deepEqual(new OperationStore(settings).get(input.id), accepted);
    assert.deepEqual(validateReleaseRequest(request({ expectedManifestSha256: null })).images, []);
  });
});

test('canonical hashes ignore recursive object key order while preserving meaningful image order', () => {
  const input = request({ images: [imageProof(), imageProof('admin')] });
  function reverse(value) {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reverse(entry)]),
      );
    return value;
  }
  assert.equal(requestHash(input), requestHash(reverse(input)));
  assert.notEqual(requestHash(input), requestHash({ ...input, images: input.images.toReversed() }));
});

test('request boundary rejects malformed, unknown, oversized and inconsistent data', () => {
  for (const patch of [
    { schemaVersion: 2 },
    { id: randomUUID().toUpperCase() },
    { id: '00000000-0000-1000-8000-000000000000' },
    { sourceSha: 'A'.repeat(40) },
    { expectedManifestSha256: '' },
    { trigger: 'shell' },
    { images: null },
    { images: [imageProof(), imageProof()] },
    { unexpected: 'ignored' },
    {
      images: [
        imageProof(),
        imageProof('admin'),
        imageProof('miniapp'),
        imageProof('eraser'),
        imageProof(),
      ],
    },
  ])
    assert.throws(() => validateReleaseRequest(request(patch)));
  const malformed = [
    (proof) => {
      proof.record.source.sha = 'f'.repeat(40);
    },
    (proof) => {
      proof.record.source.repository = 'other/repository';
    },
    (proof) => {
      proof.record.source.repositoryId = '1';
    },
    (proof) => {
      proof.record.source.runnerEnvironment = 'self-hosted';
    },
    (proof) => {
      proof.record.source.event = 'pull_request';
    },
    (proof) => {
      proof.record.registry.repository = `ghcr.io/gameclubpro/major-maksimov-${proof.record.component}`;
    },
    (proof) => {
      proof.record.registry.repository = `ghcr.io/gameclubpro/major-maksimov-release-${proof.record.component}`;
    },
    (proof) => {
      proof.artifact.id = 0;
    },
    (proof) => {
      proof.artifact.name = 'unbound-artifact';
    },
    (proof) => {
      proof.verifiedAt = 'not-a-date';
    },
    (proof) => {
      proof.artifact.digest = `sha256:${'A'.repeat(64)}`;
    },
    (proof) => {
      proof.record.component = 'unknown';
    },
  ];
  for (const mutate of malformed) {
    const proof = imageProof();
    mutate(proof);
    assertCode(() => validateReleaseRequest(request({ images: [proof] })), 'INVALID_IMAGE_PROOF');
  }
  const oversized = imageProof();
  oversized.record.extra = 'x'.repeat(65536);
  assertCode(() => validateReleaseRequest(request({ images: [oversized] })), 'REQUEST_TOO_LARGE');
  const cyclic = imageProof();
  cyclic.record.extra = cyclic;
  assertCode(() => validateReleaseRequest(request({ images: [cyclic] })), 'INVALID_JSON');
});

test('idempotent submission returns immutable existing outcome and rejects conflicting content', () => {
  withStore(({ store, advance }) => {
    const input = request({ images: [imageProof()] });
    const first = store.submit(input);
    advance();
    execute(store, input.id);
    store.transition(input.id, 'EXECUTING', 'NEEDS_REVIEW', { reasonCode: 'SMOKE_FAILED' });
    const uncertain = store.get(input.id);
    assert.deepEqual(store.submit(input), uncertain);
    assertCode(
      () => store.submit({ ...input, sourceSha: 'f'.repeat(40), images: [] }),
      'ID_CONFLICT',
    );
    assertCode(() => store.submit(request()), 'UNRESOLVED_REVIEW');
    first.state = 'SUCCEEDED';
    input.images[0].record.image.sizeBytes = 1;
    assert.equal(store.get(input.id).state, 'NEEDS_REVIEW');
    assert.equal(store.readRequest(input.id).images[0].record.image.sizeBytes, 123456);
    const read = store.readRequest(input.id);
    read.images.length = 0;
    assert.equal(store.readRequest(input.id).images.length, 1);
  });
});

test('queue selects the oldest eligible operation and summaries expose bounded safe fields only', () => {
  withStore(({ store }) => {
    const first = request({ images: [imageProof()] });
    const second = request();
    store.submit(first);
    store.submit(second);
    assert.equal(store.next().id, first.id);
    admit(store, first.id);
    store.transition(first.id, 'ADMITTING', 'WAITING_LOCK', { reasonCode: 'LOCK_BUSY' });
    assert.equal(store.next().id, first.id);
    const summaries = [store.get(first.id), ...store.list()];
    for (const item of summaries) {
      assert.equal(Object.hasOwn(item, 'request'), false);
      assert.equal(Object.hasOwn(item, 'images'), false);
      assert.equal(JSON.stringify(item).includes('artifact'), false);
    }
    assert.equal(store.get(randomUUID()), null);
    assert.equal(store.list({ limit: 1 }).length, 1);
    for (const limit of [0, 33, 1.5, '1']) assertCode(() => store.list({ limit }), 'INVALID_LIMIT');
  });
});

test('transition boundary rejects stale states, raw errors and terminal rewrites', () => {
  withStore(({ store, advance }) => {
    const { id } = store.submit(request());
    assertCode(() => store.transition(id, 'ADMITTING', 'EXECUTING'), 'STALE_STATE');
    assertCode(() => store.transition(id, 'QUEUED', 'EXECUTING'), 'INVALID_TRANSITION');
    assertCode(
      () => store.transition(id, 'QUEUED', 'ADMITTING', { error: 'secret log' }),
      'INVALID_SHAPE',
    );
    assertCode(
      () => store.transition(id, 'QUEUED', 'ADMITTING', { reasonCode: 'raw password=abc' }),
      'INVALID_DETAILS',
    );
    advance();
    const admission = store.transition(id, 'QUEUED', 'ADMITTING', { phase: 'VERIFYING_CANDIDATE' });
    assert.equal(admission.phase, 'VERIFYING_CANDIDATE');
    store.transition(id, 'ADMITTING', 'WAITING_LOCK');
    store.transition(id, 'WAITING_LOCK', 'ADMITTING');
    store.transition(id, 'ADMITTING', 'EXECUTING');
    const done = store.transition(id, 'EXECUTING', 'SUCCEEDED');
    assert.ok(done.sequence > done.createdSequence);
    assertCode(() => store.transition(id, 'SUCCEEDED', 'EXECUTING'), 'INVALID_TRANSITION');
    assertCode(() => store.heartbeat(id), 'INVALID_HEARTBEAT_STATE');
    assertCode(
      () =>
        store.resolveReview(id, {
          kind: 'UNCHANGED',
          evidenceSha256: manifestSha256,
          manifestSha256,
        }),
      'INVALID_RESOLUTION_STATE',
    );
  });
});

test('heartbeat and executor identity persist without allowing PID identity replacement', () => {
  withStore(({ store, advance, settings }) => {
    const { id } = store.submit(request());
    assertCode(() => store.heartbeat(id), 'INVALID_HEARTBEAT_STATE');
    const identity = {
      pid: 1234,
      sourceSha,
      startedAt: new Date(time).toISOString(),
      bootId: randomUUID(),
      startTicks: '123456',
    };
    assertCode(() => store.setExecutor(id, identity), 'INVALID_EXECUTOR_STATE');
    execute(store, id);
    const assigned = store.setExecutor(id, identity);
    assert.deepEqual(store.setExecutor(id, identity), assigned);
    assertCode(() => store.setExecutor(id, { ...identity, pid: 1235 }), 'EXECUTOR_CONFLICT');
    advance(10_000);
    const live = store.heartbeat(id);
    assert.equal(live.lastHeartbeatAt, new Date(time + 10_000).toISOString());
    assert.deepEqual(new OperationStore(settings).get(id), live);
  });
});

test('safe lock retries preserve bounded executor history and require exact child-exit proof', () => {
  withStore(({ store, stateFile }) => {
    const { id } = store.submit(request());
    admit(store, id);
    const identity = {
      pid: 1234,
      sourceSha,
      startedAt: new Date(time).toISOString(),
      bootId: randomUUID(),
      startTicks: '123456',
    };
    for (let index = 0; index < 16; index += 1) {
      const executor = {
        ...identity,
        pid: identity.pid + index,
        startTicks: String(123456 + index),
      };
      store.setExecutor(id, executor);
      store.transition(id, 'ADMITTING', 'WAITING_LOCK', { reasonCode: 'LOCK_BUSY' });
      assertCode(
        () => store.transition(id, 'WAITING_LOCK', 'ADMITTING'),
        'PREVIOUS_EXECUTOR_UNPROVED',
      );
      if (index < 15) {
        const retry = store.transition(id, 'WAITING_LOCK', 'ADMITTING', {
          reasonCode: 'PREVIOUS_CHILD_EXIT_PROVED',
        });
        assert.equal(retry.executor, null);
        assert.equal(retry.attemptCount, index + 2);
        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).operations[0];
        assert.deepEqual(persisted.attempts[index].executor, executor);
        assert.equal(Object.hasOwn(retry, 'attempts'), false);
      } else {
        assertCode(
          () =>
            store.transition(id, 'WAITING_LOCK', 'ADMITTING', {
              reasonCode: 'PREVIOUS_CHILD_EXIT_PROVED',
            }),
          'ATTEMPT_LIMIT',
        );
        assert.equal(
          store.transition(id, 'WAITING_LOCK', 'REJECTED', { reasonCode: 'LOCK_WAIT_EXHAUSTED' })
            .state,
          'REJECTED',
        );
      }
    }
  });
});

test('restart quarantines every nonqueued active phase durably and never retries an executor', () => {
  withStore(({ store, settings, advance }) => {
    const ids = Array.from({ length: 4 }, () => store.submit(request()).id);
    admit(store, ids[1]);
    admit(store, ids[2]);
    store.transition(ids[2], 'ADMITTING', 'WAITING_LOCK');
    execute(store, ids[3]);
    advance();
    const restarted = new OperationStore(settings);
    const recovered = restarted.recoverInterrupted();
    assert.deepEqual(
      recovered.map(({ id }) => id),
      ids.slice(1),
    );
    assert.ok(
      recovered.every(
        (item) => item.state === 'NEEDS_REVIEW' && item.reasonCode === 'DAEMON_RESTART',
      ),
    );
    assert.equal(restarted.get(ids[0]).state, 'QUEUED');
    assert.equal(restarted.next(), null);
    assert.equal(restarted.hasUncertain(), true);
    assertCode(() => restarted.transition(ids[0], 'QUEUED', 'ADMITTING'), 'UNRESOLVED_REVIEW');
    const again = new OperationStore(settings);
    assert.equal(again.hasUncertain(), true);
    assert.deepEqual(again.recoverInterrupted(), []);
  });
});

test('trusted review resolution preserves the historical failure and is immutable and idempotent', () => {
  withStore(({ store, advance, settings }) => {
    const input = request();
    store.submit(input);
    execute(store, input.id);
    store.transition(input.id, 'EXECUTING', 'NEEDS_REVIEW', { reasonCode: 'UNCERTAIN_SMOKE' });
    advance();
    const resolution = { kind: 'RECOVERED', evidenceSha256: 'f'.repeat(64), manifestSha256 };
    const resolved = store.resolveReview(input.id, resolution);
    assert.equal(resolved.state, 'NEEDS_REVIEW');
    assert.equal(resolved.reasonCode, 'UNCERTAIN_SMOKE');
    assert.deepEqual(resolved.resolution, {
      kind: 'RECOVERED',
      resolvedAt: new Date(time + 1000).toISOString(),
    });
    assert.deepEqual(store.resolveReview(input.id, resolution), resolved);
    assertCode(
      () => store.resolveReview(input.id, { ...resolution, kind: 'UNCHANGED' }),
      'RESOLUTION_CONFLICT',
    );
    assert.equal(store.hasUncertain(), false);
    assert.deepEqual(store.submit(input), resolved);
    assert.equal(new OperationStore(settings).hasUncertain(), false);
    assert.doesNotThrow(() => store.submit(request()));
  });
});

test('pending capacity fails closed while identical submission retains idempotency', () => {
  withStore(({ store }) => {
    const inputs = Array.from({ length: 32 }, () => request());
    for (const input of inputs) store.submit(input);
    assert.equal(store.list().length, 32);
    assertCode(() => store.submit(request()), 'CAPACITY_REACHED');
    assert.equal(store.submit(inputs[0]).id, inputs[0].id);
    admit(store, inputs[0].id);
    store.transition(inputs[0].id, 'ADMITTING', 'REJECTED');
    assert.doesNotThrow(() => store.submit(request()));
  });
});

test('total capacity preserves all idempotency history rather than pruning old terminal records', () => {
  withStore(({ store }) => {
    const first = request();
    for (let index = 0; index < 256; index += 1) {
      const input = index === 0 ? first : request();
      store.submit(input);
      admit(store, input.id);
      store.transition(input.id, 'ADMITTING', 'SUPERSEDED');
    }
    assertCode(() => store.submit(request()), 'CAPACITY_REACHED');
    assert.equal(store.submit(first).state, 'SUPERSEDED');
  });
});

test('state uses protected permissions and refuses symlink directories and files', () => {
  withStore(({ root, directory, stateFile, store, settings }) => {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    const alternate = join(root, 'other-state');
    fs.mkdirSync(alternate, { mode: 0o700 });
    const alias = join(root, 'alias');
    fs.symlinkSync(alternate, alias);
    assertCode(() => new OperationStore({ ...settings, directory: alias }), 'UNSAFE_DIRECTORY');
    fs.chmodSync(directory, 0o770);
    assertCode(() => store.list(), 'UNSAFE_DIRECTORY');
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(stateFile, 0o640);
    assertCode(() => store.list(), 'UNSAFE_STATE_FILE');
    fs.chmodSync(stateFile, 0o600);
    const backup = join(root, 'saved-state.json');
    fs.renameSync(stateFile, backup);
    fs.symlinkSync(backup, stateFile);
    assertCode(() => new OperationStore(settings), 'UNSAFE_STATE_FILE');
  });
});

test('hardlinked state, foreign ownership, empty and oversized state fail before parsing', () => {
  withStore(({ root, stateFile, store }) => {
    fs.linkSync(stateFile, join(root, 'hardlink'));
    assertCode(() => store.list(), 'UNSAFE_STATE_FILE');
    fs.unlinkSync(join(root, 'hardlink'));
    if (process.getuid() === 0) {
      fs.chownSync(stateFile, 65534, 65534);
      assertCode(() => store.list(), 'UNSAFE_STATE_FILE');
      fs.chownSync(stateFile, 0, 0);
    }
    fs.writeFileSync(stateFile, '');
    assertCode(() => store.list(), 'UNSAFE_STATE_FILE');
    fs.truncateSync(stateFile, 18 * 1024 * 1024 + 1);
    assertCode(() => store.list(), 'UNSAFE_STATE_FILE');
  });
});

test('malformed persisted records cannot silently replace the immutable request or safe summary', () => {
  withStore(({ store, stateFile, settings }) => {
    const { id } = store.submit(request());
    const original = fs.readFileSync(stateFile, 'utf8');
    for (const mutate of [
      (state) => {
        state.operations[0].request.sourceSha = 'f'.repeat(40);
      },
      (state) => {
        state.operations[0].phase = 'raw exception with secret';
      },
      (state) => {
        state.operations[0].requestHash = '0'.repeat(64);
      },
      (state) => {
        state.operations[0].state = 'UNKNOWN';
      },
      (state) => {
        state.operations[0].sequence = state.sequence + 1;
      },
      (state) => {
        state.operations[0].extra = 'unexpected';
      },
      (state) => {
        state.operations.push(structuredClone(state.operations[0]));
      },
      (state) => {
        state.sequence += 1;
      },
    ]) {
      const state = JSON.parse(original);
      mutate(state);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      assert.throws(() => new OperationStore(settings));
    }
    fs.writeFileSync(stateFile, original);
    assert.equal(store.get(id).state, 'QUEUED');
    fs.writeFileSync(stateFile, '{');
    assertCode(() => new OperationStore(settings), 'INVALID_STATE');
  });
});

test('failure before atomic rename retains the complete prior snapshot and removes temporary state', () => {
  let rejectRename = false;
  const fileSystem = {
    ...fs,
    renameSync(from, to) {
      if (rejectRename)
        throw Object.assign(new Error('simulated atomic rename failure'), { code: 'EIO' });
      fs.renameSync(from, to);
    },
  };
  withStore(
    ({ store, directory, stateFile, settings }) => {
      const first = request();
      store.submit(first);
      const original = fs.readFileSync(stateFile, 'utf8');
      rejectRename = true;
      assert.throws(() => store.submit(request()), /simulated atomic rename failure/u);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(directory), ['state.json']);
      assertCode(() => store.submit(first), 'STORE_RESTART_REQUIRED');
      rejectRename = false;
      assert.equal(new OperationStore(settings).get(first.id).state, 'QUEUED');
    },
    { fileSystem },
  );
});

test('failure after rename refuses subsequent mutation and restart observes a complete committed snapshot', () => {
  let rejectDirectorySync = false;
  const fileSystem = {
    ...fs,
    fsyncSync(descriptor) {
      if (rejectDirectorySync && fs.fstatSync(descriptor).isDirectory())
        throw Object.assign(new Error('simulated directory sync failure'), { code: 'EIO' });
      fs.fsyncSync(descriptor);
    },
  };
  withStore(
    ({ store, settings, directory }) => {
      const input = request();
      rejectDirectorySync = true;
      assert.throws(() => store.submit(input), /simulated directory sync failure/u);
      assertCode(() => store.get(input.id), 'STORE_RESTART_REQUIRED');
      rejectDirectorySync = false;
      const restarted = new OperationStore(settings);
      assert.equal(restarted.get(input.id).state, 'QUEUED');
      assert.equal(restarted.submit(input).id, input.id);
      assert.deepEqual(fs.readdirSync(directory), ['state.json']);
    },
    { fileSystem },
  );
});

test('a backwards clock fails closed without modifying the operation', () => {
  withStore(({ store, advance }) => {
    const input = request();
    const initial = store.submit(input);
    advance(-1000);
    assertCode(() => admit(store, input.id), 'CLOCK_MOVED_BACKWARDS');
    assert.deepEqual(store.get(input.id), initial);
  });
});
