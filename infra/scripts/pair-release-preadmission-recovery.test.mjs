import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  writeFile,
  readFile,
  lstat,
  mkdir,
  symlink,
  rm,
  chmod,
  link,
  truncate,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PREADMISSION_SOURCE as SOURCE,
  PREADMISSION_CONTRACT as CONTRACT,
  PREADMISSION_SERVICES as SERVICES,
  parsePreadmissionRecoveryArgs,
  buildPreadmissionProof,
  inspectPreadmissionContext,
  inspectPreadmissionRuntime,
  observePreadmissionMaintenanceBoundary,
  observePreadmissionSiblings,
  recoverPreadmission,
  withPreadmissionLocks,
  archivePreadmission,
} from './pair-release-preadmission-recovery.mjs';

const execute = promisify(execFile);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const START = Date.parse(CONTRACT.ownerStartedAt);
const UUID = '11111111-1111-4111-8111-111111111111';
const IMAGE = `sha256:${'d'.repeat(64)}`;
const uid = process.getuid();
function metadata(sha256, at = START - 1000) {
  return { sha256, uid, mode: 0o600, links: 1, dev: 1, ino: 5, mtimeMs: at, ctimeMs: at };
}
function fixture() {
  const snapshot = {
    schemaVersion: 1,
    protocol: 'major-karavan-release-v1',
    major: {
      checkoutSha: SOURCE,
      targetSha: SOURCE,
      manifestSha256: 'e'.repeat(64),
      components: [{ id: 'api-shared', sourceSha: SOURCE, imageId: IMAGE }],
    },
    karavan: {
      checkoutSha: 'b'.repeat(40),
      commit: 'b'.repeat(40),
      manifestSha256: 'c'.repeat(64),
    },
    configuration: { majorSha256: '1'.repeat(64), karavanSha256: '2'.repeat(64) },
  };
  const stateSha256 = digest(JSON.stringify(snapshot));
  const request = {
    mode: 'preview',
    ownerSha256: CONTRACT.ownerSha256,
    stateSha256,
    sourceSha: SOURCE,
    operationId: UUID,
  };
  const observation = {
    operatorUid: uid,
    locksHeld: true,
    admissionInode: '1:2',
    bootId: UUID,
    owner: {
      ...metadata(CONTRACT.ownerSha256, START),
      fields: {
        protocol: 'major-karavan-release-v1',
        product: 'major',
        mode: 'runtime',
        target: SOURCE,
        pid: '99999999',
        start: '12345',
        boot: UUID,
        cwd: digest('/var/www/Chat_bot'),
        inode: '1:2',
        initial_state: stateSha256,
        started_at: CONTRACT.ownerStartedAt,
      },
    },
    process: { present: false },
    noActors: true,
    source: {
      majorSha: SOURCE,
      karavanSha: 'b'.repeat(40),
      majorClean: true,
      karavanClean: true,
      installedMatch: true,
      hashes: {
        host: '3'.repeat(64),
        client: '4'.repeat(64),
        queueControl: CONTRACT.queueControlSha256,
      },
    },
    snapshot,
    fingerprint: stateSha256,
    operation: {
      idSha256: digest(UUID),
      directory: {
        uid,
        mode: 0o700,
        dev: 1,
        ino: 8,
        mtimeMs: Date.parse(CONTRACT.operationChangedAt),
        ctimeMs: Date.parse(CONTRACT.operationChangedAt),
      },
      entries: ['context.json', 'queue-control.cjs'],
      uniqueWindowDirectory: true,
      historicalSiblingFiles: [],
      context: metadata(CONTRACT.contextSha256, START + 923),
      queueControl: metadata(CONTRACT.queueControlSha256, START + 922),
      contextFacts: {
        version: 1,
        protocol: 'source-abandonment-v1',
        selectionSha256: '5'.repeat(64),
        networkSha256: '6'.repeat(64),
        majorCatalogSha256: '7'.repeat(64),
        publisherCatalogSha256: '8'.repeat(64),
        queueControlSha256: CONTRACT.queueControlSha256,
        ownerCount: 1,
        majorCount: 2,
      },
    },
    journals: {
      cold: { ...metadata(CONTRACT.coldSha256), phase: 'COMPLETE' },
      marker: metadata(CONTRACT.markerSha256),
      backlog: { ...metadata(CONTRACT.backlogSha256), phase: 'COMPLETE' },
      predrainAbsent: true,
      sessionAbsent: true,
    },
    runtime: {
      imageId: IMAGE,
      noRecoveryClients: true,
      unexpectedCount: 0,
      nativeBoundaryReviewed: true,
      environmentRefusalProved: true,
      networkSha256: '6'.repeat(64),
      majorCatalogSha256: '7'.repeat(64),
      publisherCatalogSha256: '8'.repeat(64),
      services: SERVICES.map((serviceName, index) => ({
        serviceName,
        containerSha256: digest(String(index)),
        imageId: IMAGE,
        createdAt: '2026-11-09T07:15:00.000Z',
        startedAt: '2026-11-09T07:16:00.000Z',
        running: true,
        healthy: serviceName.startsWith('api-') ? null : true,
        restartCount: 0,
      })),
      queueFence: { queueCount: 24, pausedCount: 0, ownerPresent: false },
    },
  };
  return { request, observation };
}
const cli = (request) => [
  request.mode,
  '--owner-sha256',
  request.ownerSha256,
  '--state-sha256',
  request.stateSha256,
  '--source-sha',
  request.sourceSha,
  '--operation-id',
  request.operationId,
  ...(request.proofSha256 ? ['--proof-sha256', request.proofSha256] : []),
];

test('CLI accepts exact preview and proof-bound apply, including reordered flags', () => {
  const { request } = fixture();
  assert.deepEqual(parsePreadmissionRecoveryArgs(cli(request)), request);
  const apply = { ...request, mode: 'apply', proofSha256: 'f'.repeat(64) };
  assert.deepEqual(parsePreadmissionRecoveryArgs(cli(apply)), apply);
  assert.deepEqual(
    parsePreadmissionRecoveryArgs([
      'preview',
      ...cli(request).slice(3, 5),
      ...cli(request).slice(1, 3),
      ...cli(request).slice(5),
    ]),
    request,
  );
});
test('CLI rejects duplicates, unknowns, partial identities, wrong source and missing apply proof', () => {
  const { request } = fixture();
  for (const args of [
    [],
    ['status'],
    cli({ ...request, operationId: UUID.replace('-4111-', '-5111-') }),
    cli({ ...request, sourceSha: 'a'.repeat(40) }),
    cli({ ...request, ownerSha256: 'f'.repeat(64) }),
    cli({ ...request, mode: 'apply' }),
    [...cli(request), '--proof-sha256', 'f'.repeat(64)],
    [...cli(request), '--runtime', 'true'],
    [...cli(request).slice(0, -2), '--source-sha', SOURCE],
  ]) {
    assert.throws(() => parsePreadmissionRecoveryArgs(args), /invalid_/u);
  }
});
test('valid proof attests only pre-admission boundary and exposes no private IDs or credentials', () => {
  const { request, observation } = fixture();
  const proof = buildPreadmissionProof(request, observation);
  assert.equal(proof.verification, 'historical_durable_preadmission_boundary');
  assert.equal(proof.runtimeMutation, false);
  assert.equal(proof.ownerSha256, CONTRACT.ownerSha256);
  const serialized = JSON.stringify(proof);
  for (const privateValue of [
    UUID,
    '99999999',
    'DATABASE_URL',
    'ownerWebhookEventIds',
    'publisherBotId',
  ])
    assert.equal(serialized.includes(privateValue), false);
  assert.deepEqual(buildPreadmissionProof(request, structuredClone(observation)), proof);
});
const refusals = [
  [
    'unheld locks',
    (o) => {
      o.locksHeld = false;
    },
  ],
  [
    'live original PID',
    (o) => {
      o.process = { present: true, startTicks: '12345' };
    },
  ],
  [
    'reused PID',
    (o) => {
      o.process = { present: true, startTicks: '99999' };
    },
  ],
  [
    'different boot',
    (o) => {
      o.bootId = '22222222-2222-4222-8222-222222222222';
    },
  ],
  [
    'owner hash drift',
    (o) => {
      o.owner.sha256 = 'f'.repeat(64);
    },
  ],
  [
    'owner scope drift',
    (o) => {
      o.owner.fields.target = 'f'.repeat(40);
    },
  ],
  [
    'owner mode drift',
    (o) => {
      o.owner.mode = 0o644;
    },
  ],
  [
    'admission inode drift',
    (o) => {
      o.admissionInode = '1:3';
    },
  ],
  [
    'pair fingerprint drift',
    (o) => {
      o.fingerprint = 'f'.repeat(64);
    },
  ],
  [
    'manifest drift',
    (o) => {
      o.snapshot.major.manifestSha256 = 'f'.repeat(64);
    },
  ],
  [
    'source drift',
    (o) => {
      o.source.majorSha = 'f'.repeat(40);
    },
  ],
  [
    'dirty sibling',
    (o) => {
      o.source.karavanClean = false;
    },
  ],
  [
    'installed reporter drift',
    (o) => {
      o.source.installedMatch = false;
    },
  ],
  [
    'active wrapper',
    (o) => {
      o.noActors = false;
    },
  ],
  [
    'ambiguous private directory',
    (o) => {
      o.operation.uniqueWindowDirectory = false;
    },
  ],
  [
    'new unexpected artifact',
    (o) => {
      o.operation.entries.push('extra.json');
    },
  ],
  [
    'durable admission present',
    (o) => {
      o.operation.entries.push('admission.json');
    },
  ],
  [
    'retained credential input',
    (o) => {
      o.operation.entries.push('client.env');
    },
  ],
  [
    'directory ctime changed',
    (o) => {
      o.operation.directory.ctimeMs += 1;
    },
  ],
  [
    'context ctime changed',
    (o) => {
      o.operation.context.ctimeMs = START + 11000;
    },
  ],
  [
    'context hash changed',
    (o) => {
      o.operation.context.sha256 = 'f'.repeat(64);
    },
  ],
  [
    'queue-controller changed',
    (o) => {
      o.operation.queueControl.sha256 = 'f'.repeat(64);
    },
  ],
  [
    'cold journal active',
    (o) => {
      o.journals.cold.phase = 'STOPPED';
    },
  ],
  [
    'backlog journal touched',
    (o) => {
      o.journals.backlog.ctimeMs = START;
    },
  ],
  [
    'session exists',
    (o) => {
      o.journals.sessionAbsent = false;
    },
  ],
  [
    'predrain exists',
    (o) => {
      o.journals.predrainAbsent = false;
    },
  ],
  [
    'client exists',
    (o) => {
      o.runtime.noRecoveryClients = false;
    },
  ],
  [
    'unexpected producer',
    (o) => {
      o.runtime.unexpectedCount = 1;
    },
  ],
  [
    'runtime image drift',
    (o) => {
      o.runtime.imageId = `sha256:${'f'.repeat(64)}`;
    },
  ],
  [
    'missing runtime role',
    (o) => {
      o.runtime.services.pop();
    },
  ],
  [
    'late API start',
    (o) => {
      o.runtime.services[0].startedAt = '2026-11-09T08:00:00.000Z';
    },
  ],
  [
    'unhealthy native',
    (o) => {
      o.runtime.services.at(-1).healthy = false;
    },
  ],
  [
    'paused queue',
    (o) => {
      o.runtime.queueFence.pausedCount = 1;
    },
  ],
  [
    'missing queue',
    (o) => {
      o.runtime.queueFence.queueCount = 23;
    },
  ],
  [
    'environment refusal unproved',
    (o) => {
      o.runtime.environmentRefusalProved = false;
    },
  ],
  [
    'context network changed',
    (o) => {
      o.runtime.networkSha256 = 'f'.repeat(64);
    },
  ],
];
for (const [name, change] of refusals)
  test(`proof refuses ${name}`, () => {
    const { request, observation } = fixture();
    change(observation);
    const codes = {
      'unheld locks': 'missing_recovery_locks',
      'live original PID': 'owner_process_not_proved_dead',
      'reused PID': 'owner_process_not_proved_dead',
      'different boot': 'owner_process_not_proved_dead',
      'owner hash drift': 'owner_changed',
      'owner scope drift': 'unexpected_owner_scope',
      'owner mode drift': 'unsafe_owner',
      'admission inode drift': 'admission_inode_changed',
      'pair fingerprint drift': 'pair_state_changed',
      'manifest drift': 'pair_state_changed',
      'source drift': 'exact_source_unproved',
      'dirty sibling': 'exact_source_unproved',
      'installed reporter drift': 'exact_source_unproved',
      'active wrapper': 'active_recovery_actor',
      'ambiguous private directory': 'preadmission_directory_changed',
      'new unexpected artifact': 'preadmission_directory_changed',
      'durable admission present': 'preadmission_directory_changed',
      'retained credential input': 'preadmission_directory_changed',
      'directory ctime changed': 'preadmission_directory_changed',
      'context ctime changed': 'preadmission_artifact_changed',
      'context hash changed': 'preadmission_artifact_changed',
      'queue-controller changed': 'preadmission_artifact_changed',
      'cold journal active': 'prior_journal_changed',
      'backlog journal touched': 'prior_journal_changed',
      'session exists': 'active_maintenance_journal',
      'predrain exists': 'active_maintenance_journal',
      'client exists': 'runtime_boundary_unproved',
      'unexpected producer': 'runtime_boundary_unproved',
      'runtime image drift': 'runtime_boundary_unproved',
      'missing runtime role': 'runtime_generation_changed',
      'late API start': 'runtime_generation_changed',
      'unhealthy native': 'runtime_generation_changed',
      'paused queue': 'queue_fence_not_released',
      'missing queue': 'queue_fence_not_released',
      'environment refusal unproved': 'runtime_boundary_unproved',
      'context network changed': 'runtime_context_changed',
    };
    assert.throws(() => buildPreadmissionProof(request, observation), { message: codes[name] });
  });

test('preview observes once and never archives; apply requires the reviewed proof and reobserves', async () => {
  const { request, observation } = fixture();
  let observations = 0;
  let archives = 0;
  const dependencies = {
    observe: async () => {
      observations++;
      return structuredClone(observation);
    },
    archive: async () => {
      archives++;
    },
  };
  const preview = await recoverPreadmission(request, dependencies);
  assert.equal(observations, 1);
  assert.equal(archives, 0);
  assert.match(preview.proofSha256, /^[0-9a-f]{64}$/u);
  assert.equal(preview.archived, false);
  assert.equal(preview.runtimeMutation, false);
  const result = await recoverPreadmission(
    { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
    dependencies,
  );
  assert.equal(observations, 3);
  assert.equal(archives, 1);
  assert.equal(result.archived, true);
});
test('apply refuses caller proof drift and any second observation change without archive', async () => {
  const { request, observation } = fixture();
  const preview = await recoverPreadmission(request, { observe: async () => observation });
  let archives = 0;
  await assert.rejects(
    recoverPreadmission(
      { ...request, mode: 'apply', proofSha256: 'f'.repeat(64) },
      {
        observe: async () => observation,
        archive: async () => {
          archives++;
        },
      },
    ),
    /proof/u,
  );
  let count = 0;
  await assert.rejects(
    recoverPreadmission(
      { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
      {
        observe: async () => {
          const next = structuredClone(observation);
          if (count++) next.runtime.services[0].restartCount++;
          return next;
        },
        archive: async () => {
          archives++;
        },
      },
    ),
  );
  assert.equal(archives, 0);
});

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'preadmission-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locks = [0, 1, 2].map((i) => join(root, `lock-${i}`));
  for (const path of locks) await writeFile(path, '', { mode: 0o600 });
  return { root, locks };
}
async function competing(path) {
  try {
    await execute('flock', ['-n', path, 'true']);
    return true;
  } catch {
    return false;
  }
}
test('all original lock descriptions fence competitors through the callback and retain their inodes', async (t) => {
  const { locks } = await temporary(t);
  const before = await Promise.all(locks.map((path) => lstat(path)));
  await withPreadmissionLocks(locks, async ({ assertLocks, holderPid }) => {
    await assertLocks();
    for (const path of locks) assert.equal(await competing(path), false);
    process.kill(holderPid, 'SIGKILL');
    for (const path of locks) assert.equal(await competing(path), false);
    await assert.rejects(assertLocks());
  });
  for (const [index, path] of locks.entries()) {
    assert.equal(await competing(path), true);
    assert.equal((await lstat(path)).ino, before[index].ino);
  }
});
for (const index of [1, 2])
  test(`busy lock ${index + 1} closes earlier descriptions`, async (t) => {
    const { locks } = await temporary(t);
    const holder = spawn(
      'flock',
      ['-x', locks[index], 'bash', '-c', 'printf "HELD\\n"; read -r _'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    t.after(() => {
      holder.stdin.end('done\n');
      holder.kill();
    });
    await assert.rejects(
      withPreadmissionLocks(locks, async () => assert.fail('busy lock admitted')),
      /lock/u,
    );
    for (let i = 0; i < index; i++) assert.equal(await competing(locks[i]), true);
  });
test('symlink lock and lock metadata changes are refused', async (t) => {
  const { root, locks } = await temporary(t);
  const link = join(root, 'link');
  await symlink(locks[0], link);
  await assert.rejects(
    withPreadmissionLocks([link, ...locks.slice(1)], async () => assert.fail('symlink admitted')),
  );
  await withPreadmissionLocks(locks, async ({ assertLocks }) => {
    await chmod(locks[0], 0o644);
    await assert.rejects(assertLocks());
  });
});
test('durable archive preserves original bytes and inode, plus proof before removing owner name', async (t) => {
  const { root, locks } = await temporary(t);
  const ownerPath = join(root, 'admission.owner');
  const ownerBytes = Buffer.from('original-owner\n');
  await writeFile(ownerPath, ownerBytes, { mode: 0o600 });
  const original = await lstat(ownerPath);
  const proof = { ownerSha256: digest(ownerBytes), runtimeMutation: false };
  const archiveDirectory = join(root, 'archive');
  await withPreadmissionLocks(locks, ({ assertLocks }) =>
    archivePreadmission({
      ownerPath,
      archiveDirectory,
      ownerBytes,
      proof,
      assertLocks,
      operatorUid: uid,
      ownerIdentity: { dev: original.dev, ino: original.ino, uid, mode: 0o600, links: 1 },
    }),
  );
  assert.deepEqual(
    await readFile(join(archiveDirectory, `${proof.ownerSha256}.owner`)),
    ownerBytes,
  );
  assert.equal(
    (await lstat(join(archiveDirectory, `${proof.ownerSha256}.owner`))).ino,
    original.ino,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(archiveDirectory, `${proof.ownerSha256}.proof.json`))),
    proof,
  );
  await assert.rejects(lstat(ownerPath), { code: 'ENOENT' });
});
test('archive refuses changed owner or preexisting destination without removing owner', async (t) => {
  const { root } = await temporary(t);
  const ownerPath = join(root, 'admission.owner');
  const archiveDirectory = join(root, 'archive');
  const ownerBytes = Buffer.from('owner\n');
  await writeFile(ownerPath, ownerBytes, { mode: 0o600 });
  const proof = { ownerSha256: digest(ownerBytes) };
  const original = await lstat(ownerPath);
  const args = {
    ownerPath,
    archiveDirectory,
    ownerBytes,
    proof,
    assertLocks: async () => {},
    operatorUid: uid,
    ownerIdentity: { dev: original.dev, ino: original.ino, uid, mode: 0o600, links: 1 },
  };
  await mkdir(archiveDirectory, { mode: 0o700 });
  await writeFile(join(archiveDirectory, `${proof.ownerSha256}.owner`), 'existing', {
    mode: 0o600,
  });
  await assert.rejects(archivePreadmission(args), /archive/u);
  assert.deepEqual(await readFile(ownerPath), ownerBytes);
  await rm(join(archiveDirectory, `${proof.ownerSha256}.owner`));
  await writeFile(ownerPath, 'changed\n');
  await assert.rejects(archivePreadmission(args), /owner/u);
  assert.equal(await readFile(ownerPath, 'utf8'), 'changed\n');
});

function privateContext() {
  return {
    version: 1,
    protocol: 'source-abandonment-v1',
    selection: {
      ownerWebhookEventIds: ['synthetic-owner'],
      majorBotIds: ['botA', 'botB'],
      protocol: 'source-abandonment-v1',
      abandonBefore: '2026-11-09T07:00:00.000Z',
    },
    publisherBotId: 'publisher',
    networkId: '6'.repeat(64),
    queueControlSha256: CONTRACT.queueControlSha256,
  };
}
function rawRuntime() {
  const context = privateContext();
  const rows = SERVICES.map((serviceName, index) => ({
    Id: digest(`container-${index}`),
    Name: `/infra-${serviceName}-1`,
    Image: IMAGE,
    Created: '2026-11-09T07:15:00.000000000Z',
    RestartCount: 0,
    Config: {
      Image: `maxim-api:${SOURCE}`,
      Labels: {
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': serviceName,
        'org.opencontainers.image.revision': SOURCE,
      },
      Env: [`APP_ROLE=${serviceName.slice(4)}`],
    },
    State: {
      Status: 'running',
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      StartedAt: '2026-11-09T07:16:00.000000000Z',
      ...(!serviceName.startsWith('api-') ? { Health: { Status: 'healthy' } } : {}),
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  }));
  const admin = rows.find((row) => row.Name === '/infra-api-admin-1');
  admin.Config.Env = [
    'APP_ROLE=admin',
    'MAX_BOT_ID=botA',
    'MAX_BOTS_JSON=[{"id":"botB"}]',
    'MAX_PUBLISHER_BOT_ID=publisher',
    'DATABASE_URL=postgresql://synthetic:test@postgres/test',
    'REDIS_URL=redis://redis:6379',
    'ERASER_CONTROL_URL=http://eraser:3000',
    `ERASER_CONTROL_TOKEN=${'synthetic'.repeat(8)}`,
  ];
  admin.NetworkSettings = { Networks: { infra_default: { NetworkID: context.networkId } } };
  const publisher = rows.find((row) => row.Name === '/infra-api-publisher-1');
  publisher.Config.Env = [
    'APP_ROLE=publisher',
    'MAX_BOT_ID=publisher',
    'MAX_PUBLISHER_BOT_ID=publisher',
  ];
  const fleet = {
    available: true,
    expectedRoleCount: 14,
    observedRoleCount: 14,
    singletonRoleCount: 14,
    runningRoleCount: 14,
    identityRoleCount: 14,
    exactImageRoleCount: 14,
    duplicateContainerCount: 0,
    unexpectedApiContainerCount: 0,
    unexpectedMainContainerCount: 0,
    unexpectedScaleContainerCount: 0,
    unexpectedManualContainerCount: 0,
  };
  return { rows, options: { imageId: IMAGE, context, fleet } };
}
test('private context validates finite exact source selection and emits hashes only', () => {
  const context = privateContext();
  const facts = inspectPreadmissionContext(Buffer.from(JSON.stringify(context)));
  assert.equal(facts.ownerCount, 1);
  assert.equal(facts.majorCount, 2);
  const text = JSON.stringify(facts);
  for (const id of ['synthetic-owner', 'botA', 'botB', 'publisherBotId'])
    assert.equal(text.includes(id), false);
  assert.equal(facts.majorCatalogSha256.length, 64);
});
for (const [name, change, code] of [
  [
    'additional field',
    (c) => {
      c.credentials = 'secret';
    },
    'private_context_unproved',
  ],
  [
    'wrong protocol',
    (c) => {
      c.protocol = 'legacy';
    },
    'private_context_unproved',
  ],
  [
    'future cutoff',
    (c) => {
      c.selection.abandonBefore = '2026-11-10T00:00:00.000Z';
    },
    'private_selection_unproved',
  ],
  [
    'oversized selection',
    (c) => {
      c.selection.ownerWebhookEventIds = Array.from({ length: 9 }, (_, i) => `owner-${i}`);
    },
    'private_selection_unproved',
  ],
  [
    'unsorted catalog',
    (c) => {
      c.selection.majorBotIds.reverse();
    },
    'private_selection_unproved',
  ],
  [
    'duplicate catalog',
    (c) => {
      c.selection.majorBotIds.push('botA');
    },
    'private_selection_unproved',
  ],
  [
    'publisher overlaps major',
    (c) => {
      c.publisherBotId = 'botA';
    },
    'private_catalog_unproved',
  ],
])
  test(`context refuses ${name}`, () => {
    const context = privateContext();
    change(context);
    assert.throws(() => inspectPreadmissionContext(Buffer.from(JSON.stringify(context))), {
      message: code,
    });
  });
test('runtime proves immutable environment refusal and tolerates missing ordinary API healthchecks', () => {
  const { rows, options } = rawRuntime();
  const runtime = inspectPreadmissionRuntime(rows, options);
  assert.equal(runtime.services.length, 16);
  assert.equal(runtime.environmentRefusalProved, true);
  const output = JSON.stringify(runtime);
  for (const raw of [
    'synthetic:test',
    'syntheticsynthetic',
    'botA',
    'DATABASE_URL',
    'publisherBotId',
  ])
    assert.equal(output.includes(raw), false);
});
for (const [name, change, code] of [
  [
    'missing native boundary',
    (_rows, o) => {
      o.fleet.unexpectedApiContainerCount = 1;
    },
    'native_runtime_boundary_unproved',
  ],
  [
    'unhealthy OCR',
    (rows) => {
      rows.find((r) => r.Name.includes('ocr-native')).State.Health.Status = 'unhealthy';
    },
    'native_runtime_unhealthy',
  ],
  [
    'late API generation',
    (rows) => {
      rows[0].State.StartedAt = '2026-11-09T08:00:00.000Z';
    },
    'runtime_continuity_unproved',
  ],
  [
    'late photo generation',
    (rows) => {
      rows.at(-1).State.StartedAt = '2026-11-09T08:00:00.000Z';
    },
    'runtime_continuity_unproved',
  ],
  [
    'late created OCR',
    (rows) => {
      rows.at(-2).Created = '2026-11-09T08:00:00.000Z';
    },
    'runtime_generation_unproved',
  ],
  [
    'new infra service',
    (rows) => {
      rows.push({
        ...rows[0],
        Id: 'f'.repeat(64),
        Name: '/infra-unknown-1',
        Config: {
          ...rows[0].Config,
          Labels: {
            'com.docker.compose.project': 'infra',
            'com.docker.compose.service': 'unknown',
          },
        },
      });
    },
    'unexpected_maxim_container',
  ],
  [
    'recovery client',
    (rows) => {
      rows[0].Config.Labels['com.maxim.legacy-recovery-client'] = UUID;
    },
    'recovery_client_present',
  ],
  [
    'control pair absent',
    (rows) => {
      rows[1].Config.Env = rows[1].Config.Env.filter((v) => !v.startsWith('ERASER_CONTROL_'));
    },
    'historical_environment_refusal_unproved',
  ],
  [
    'control URL changed',
    (rows) => {
      rows[1].Config.Env = rows[1].Config.Env.map((v) =>
        v.startsWith('ERASER_CONTROL_URL=') ? 'ERASER_CONTROL_URL=http://unknown:3000' : v,
      );
    },
    'historical_environment_refusal_unproved',
  ],
  [
    'duplicate DB key',
    (rows) => {
      rows[1].Config.Env.push('DATABASE_URL=postgresql://other/test');
    },
    'ambiguous_runtime_environment',
  ],
  [
    'context network drift',
    (_rows, o) => {
      o.context.networkId = 'f'.repeat(64);
    },
    'runtime_network_unproved',
  ],
])
  test(`runtime refuses ${name}`, () => {
    const { rows, options } = rawRuntime();
    change(rows, options);
    assert.throws(() => inspectPreadmissionRuntime(rows, options), { message: code });
  });
test('OCR current restart is explicitly recorded while all API and photo generations retain continuity', () => {
  const { rows, options } = rawRuntime();
  const ocr = rows.at(-2);
  ocr.RestartCount = 5;
  ocr.State.StartedAt = '2026-11-09T09:06:35.000Z';
  const runtime = inspectPreadmissionRuntime(rows, options);
  assert.equal(runtime.services.at(-2).restartCount, 5);
  assert.equal(runtime.services.at(-2).startedAt, ocr.State.StartedAt);
  const { request, observation } = fixture();
  Object.assign(observation.runtime.services.at(-2), {
    restartCount: 5,
    startedAt: ocr.State.StartedAt,
  });
  assert.equal(
    buildPreadmissionProof(request, observation).runtime.services.find(
      (s) => s.serviceName === 'ocr-native-sandbox',
    ).restartCount,
    5,
  );
});
test('OCR restart between preview and apply invalidates the reviewed proof', async () => {
  const { request, observation } = fixture();
  const preview = await recoverPreadmission(request, {
    observe: async () => structuredClone(observation),
  });
  Object.assign(observation.runtime.services.at(-2), {
    restartCount: 5,
    startedAt: '2026-11-09T09:06:35.000Z',
  });
  await assert.rejects(
    recoverPreadmission(
      { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
      { observe: async () => observation, archive: async () => assert.fail('drift archived') },
    ),
    { message: 'preview_proof_changed' },
  );
});
test('proof excludes untrusted extension fields from every projection', () => {
  const { request, observation } = fixture();
  observation.operation.contextFacts.privatePayload = 'synthetic-secret';
  observation.runtime.services[0].privatePayload = 'synthetic-secret';
  assert.equal(
    JSON.stringify(buildPreadmissionProof(request, observation)).includes('synthetic-secret'),
    false,
  );
});

test('maintenance observer reads the actual session directory, with no historical filename fallback', async (t) => {
  const { root } = await temporary(t);
  assert.deepEqual(await observePreadmissionMaintenanceBoundary(root), {
    predrainAbsent: true,
    sessionAbsent: true,
  });
  await mkdir(join(root, 'source-abandonment-session'), { mode: 0o700 });
  await writeFile(
    join(root, 'source-abandonment-session', 'journal.json'),
    '{"phase":"ADMITTED"}',
    { mode: 0o600 },
  );
  await writeFile(join(root, 'source-abandonment-session', 'marker.json'), '{}', { mode: 0o600 });
  await assert.rejects(lstat(join(root, 'source-abandonment-session.json')), { code: 'ENOENT' });
  await assert.rejects(observePreadmissionMaintenanceBoundary(root), {
    message: 'active_maintenance_journal',
  });
});
for (const kind of ['file', 'symlink', 'dangling-symlink'])
  test(`maintenance observer refuses an unknown ${kind} at the actual session path`, async (t) => {
    const { root } = await temporary(t);
    const path = join(root, 'source-abandonment-session');
    if (kind === 'file') await writeFile(path, 'unknown', { mode: 0o600 });
    else await symlink(kind === 'symlink' ? root : join(root, 'missing'), path);
    await assert.rejects(observePreadmissionMaintenanceBoundary(root), {
      message: 'active_maintenance_journal',
    });
  });
test('maintenance observer retains the independent predrain fence', async (t) => {
  const { root } = await temporary(t);
  await writeFile(join(root, 'queue-predrain-pending.json'), '{}', { mode: 0o600 });
  await assert.rejects(observePreadmissionMaintenanceBoundary(root), {
    message: 'active_maintenance_journal',
  });
});
test('the actual streamed module rejects invalid arguments and identities before host observation', async () => {
  const source = await readFile(
    new URL('./pair-release-preadmission-recovery.mjs', import.meta.url),
  );
  const { request } = fixture();
  for (const [args, code] of [
    [['preview'], 'invalid_arguments'],
    [cli({ ...request, operationId: 'invalid-operation' }), 'invalid_identity'],
  ]) {
    const pending = execute(process.execPath, ['--input-type=module', '-', ...args], {
      timeout: 5000,
      maxBuffer: 16384,
    });
    pending.child.stdin.end(source);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
      return true;
    });
  }
});

function historicalSibling(overrides = {}) {
  return {
    nameSha256: digest('opaque-history-fixture'),
    kind: 'regular',
    uid,
    mode: 0o600,
    nlink: 1,
    size: 32,
    dev: 1,
    ino: 42,
    mtimeMs: START - 2000,
    ctimeMs: START - 1000,
    ...overrides,
  };
}
async function siblingFilesystem(t) {
  const root = await mkdtemp(join(tmpdir(), 'preadmission-siblings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'opaque-operator-history');
  await writeFile(file, 'synthetic-private-opaque-content', { mode: 0o600 });
  await delay(20);
  const selected = join(root, UUID);
  await mkdir(selected, { mode: 0o700 });
  const ownerStartedAtMs = (await lstat(selected)).ctimeMs;
  return { root, file, selected, options: { ownerStartedAtMs } };
}
test('sibling observation accepts one safe historical opaque file while preserving the unique operation window', async (t) => {
  const h = await siblingFilesystem(t);
  const result = await observePreadmissionSiblings(h.root, UUID, h.options);
  assert.equal(result.uniqueWindowDirectory, true);
  assert.equal(result.historicalSiblingFiles.length, 1);
  const file = result.historicalSiblingFiles[0];
  assert.equal(file.nameSha256, digest('opaque-operator-history'));
  assert.equal(file.kind, 'regular');
  assert.equal(file.mode, 0o600);
  assert.equal(file.nlink, 1);
  assert.equal(file.size, Buffer.byteLength('synthetic-private-opaque-content'));
  assert.ok(file.ctimeMs < h.options.ownerStartedAtMs);
  assert.ok(file.mtimeMs <= file.ctimeMs);
  const text = JSON.stringify(result);
  assert.equal(text.includes('opaque-operator-history'), false);
  assert.equal(text.includes('synthetic-private-opaque-content'), false);
});
test('sibling observation hashes names and sorts explicit metadata independently of directory enumeration', async (t) => {
  const h = await siblingFilesystem(t);
  await writeFile(join(h.root, 'another-opaque-history'), '', { mode: 0o600 });
  const latest = (await lstat(join(h.root, 'another-opaque-history'))).ctimeMs;
  const result = await observePreadmissionSiblings(h.root, UUID, { ownerStartedAtMs: latest + 1 });
  assert.equal(result.historicalSiblingFiles.length, 2);
  const names = result.historicalSiblingFiles.map((file) => file.nameSha256);
  assert.deepEqual(names, [...names].sort());
});
for (const [name, change, code] of [
  [
    'world-readable file',
    async (h) => {
      await chmod(h.file, 0o644);
    },
    'unsafe_historical_sibling_file',
  ],
  [
    'special permission bits',
    async (h) => {
      await chmod(h.file, 0o4600);
    },
    'unsafe_historical_sibling_file',
  ],
  [
    'multiple hard links',
    async (h) => {
      await link(h.file, join(h.root, 'alias'));
    },
    'unsafe_historical_sibling_file',
  ],
  [
    'symbolic link',
    async (h) => {
      await symlink(h.file, join(h.root, 'alias'));
    },
    'unsafe_sibling_private_directory',
  ],
  [
    'oversized file',
    async (h) => {
      await truncate(h.file, 65537);
    },
    'unsafe_historical_sibling_file',
  ],
  [
    'recent file',
    async (h) => {
      await writeFile(join(h.root, 'new-file'), '', { mode: 0o600 });
    },
    'unsafe_historical_sibling_file',
  ],
  [
    'unsafe sibling directory',
    async (h) => {
      const path = join(h.root, 'other-directory');
      await mkdir(path, { mode: 0o755 });
    },
    'unsafe_sibling_private_directory',
  ],
])
  test(`sibling filesystem refuses ${name}`, async (t) => {
    const h = await siblingFilesystem(t);
    await change(h);
    if (name !== 'recent file') {
      // Keep the file historical so its unsafe metadata must cause the refusal.
      h.options.ownerStartedAtMs = (await lstat(h.file)).ctimeMs + 1;
    }
    await assert.rejects(observePreadmissionSiblings(h.root, UUID, h.options), { message: code });
  });
test('sibling filesystem refuses a historical file belonging to a different operator', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'preadmission-sibling-uid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'old-file');
  await writeFile(file, '', { mode: 0o600 });
  await assert.rejects(
    observePreadmissionSiblings(root, UUID, {
      ownerStartedAtMs: (await lstat(file)).ctimeMs + 1,
      operatorUid: uid + 1,
    }),
    { message: 'unsafe_historical_sibling_file' },
  );
});
test('sibling filesystem rejects ctime exactly at owner acquisition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'preadmission-sibling-time-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'boundary-file');
  await writeFile(file, '', { mode: 0o600 });
  await assert.rejects(
    observePreadmissionSiblings(root, UUID, { ownerStartedAtMs: (await lstat(file)).ctimeMs }),
    { message: 'unsafe_historical_sibling_file' },
  );
});
test('a second safe directory in the owner window still prevents unique-operation proof', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'preadmission-sibling-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, UUID);
  await mkdir(first, { mode: 0o700 });
  const ownerStartedAtMs = (await lstat(first)).ctimeMs;
  await mkdir(join(root, '22222222-2222-4222-8222-222222222222'), { mode: 0o700 });
  const result = await observePreadmissionSiblings(root, UUID, { ownerStartedAtMs });
  assert.equal(result.uniqueWindowDirectory, false);
  assert.deepEqual(result.historicalSiblingFiles, []);
});
test('proof independently validates sibling metadata and returns only a count plus deterministic digest', () => {
  const { request, observation } = fixture();
  const first = historicalSibling();
  const second = historicalSibling({ nameSha256: digest('another-opaque-fixture'), ino: 43 });
  observation.operation.historicalSiblingFiles = [first, second].sort((left, right) =>
    left.nameSha256.localeCompare(right.nameSha256),
  );
  const proof = buildPreadmissionProof(request, observation);
  assert.equal(proof.historicalSiblingFiles.count, 2);
  assert.match(proof.historicalSiblingFiles.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(proof.historicalSiblingFiles).sort(), ['count', 'sha256']);
  assert.equal(JSON.stringify(proof).includes(first.nameSha256), false);
  assert.equal(JSON.stringify(proof).includes(second.nameSha256), false);
});
for (const [name, change] of [
  [
    'missing projection',
    (_rows, o) => {
      delete o.operation.historicalSiblingFiles;
    },
  ],
  [
    'wrong file kind',
    (rows) => {
      rows[0].kind = 'symlink';
    },
  ],
  [
    'wrong operator',
    (rows) => {
      rows[0].uid++;
    },
  ],
  [
    'unsafe mode',
    (rows) => {
      rows[0].mode = 0o644;
    },
  ],
  [
    'multiple links',
    (rows) => {
      rows[0].nlink = 2;
    },
  ],
  [
    'nonfinite device',
    (rows) => {
      rows[0].dev = NaN;
    },
  ],
  [
    'negative device',
    (rows) => {
      rows[0].dev = -1;
    },
  ],
  [
    'fractional inode',
    (rows) => {
      rows[0].ino = 1.5;
    },
  ],
  [
    'negative inode',
    (rows) => {
      rows[0].ino = -1;
    },
  ],
  [
    'negative size',
    (rows) => {
      rows[0].size = -1;
    },
  ],
  [
    'fractional size',
    (rows) => {
      rows[0].size = 0.5;
    },
  ],
  [
    'oversized size',
    (rows) => {
      rows[0].size = 65537;
    },
  ],
  [
    'nonfinite ctime',
    (rows) => {
      rows[0].ctimeMs = NaN;
    },
  ],
  [
    'nonfinite mtime',
    (rows) => {
      rows[0].mtimeMs = Infinity;
    },
  ],
  [
    'ctime at owner',
    (rows) => {
      rows[0].ctimeMs = START;
    },
  ],
  [
    'mtime after ctime',
    (rows) => {
      rows[0].mtimeMs = rows[0].ctimeMs + 1;
    },
  ],
  [
    'invalid filename hash',
    (rows) => {
      rows[0].nameSha256 = 'raw-file-name';
    },
  ],
  [
    'coercible filename hash object',
    (rows) => {
      rows[0].nameSha256 = { toString: () => 'a'.repeat(64) };
    },
  ],
  [
    'sparse census',
    (rows) => {
      delete rows[0];
    },
  ],
  [
    'duplicate filename hashes',
    (rows) => {
      rows.push({ ...rows[0] });
    },
  ],
  [
    'unsorted filename hashes',
    (rows) => {
      rows.push(historicalSibling({ nameSha256: '0'.repeat(64), ino: 99 }));
    },
  ],
  [
    'oversized census',
    (rows) => {
      rows.splice(
        0,
        1,
        ...Array.from({ length: 257 }, (_, i) =>
          historicalSibling({ nameSha256: i.toString(16).padStart(64, '0'), ino: i + 100 }),
        ),
      );
    },
  ],
])
  test(`proof refuses sibling ${name}`, () => {
    const { request, observation } = fixture();
    const rows = [historicalSibling()];
    observation.operation.historicalSiblingFiles = rows;
    change(rows, observation);
    assert.throws(() => buildPreadmissionProof(request, observation), {
      message: 'historical_sibling_metadata_unproved',
    });
  });
test('sibling metadata extensions are dropped before deterministic proof hashing', () => {
  const { request, observation } = fixture();
  observation.operation.historicalSiblingFiles = [historicalSibling()];
  const original = buildPreadmissionProof(request, observation);
  Object.defineProperty(observation.operation.historicalSiblingFiles[0], 'opaquePayload', {
    enumerable: true,
    get: () => assert.fail('opaque sibling extension was read'),
  });
  assert.deepEqual(buildPreadmissionProof(request, observation), original);
});
for (const [name, change] of [
  [
    'addition',
    (rows) => {
      rows.push(historicalSibling({ nameSha256: 'f'.repeat(64), ino: 43 }));
    },
  ],
  [
    'removal',
    (rows) => {
      rows.pop();
    },
  ],
  [
    'rename',
    (rows) => {
      rows[0].nameSha256 = digest('renamed-history');
    },
  ],
  [
    'inode',
    (rows) => {
      rows[0].ino++;
    },
  ],
  [
    'size',
    (rows) => {
      rows[0].size++;
    },
  ],
  [
    'mtime',
    (rows) => {
      rows[0].mtimeMs--;
    },
  ],
  [
    'ctime',
    (rows) => {
      rows[0].ctimeMs--;
    },
  ],
])
  test(`sibling ${name} drift between preview and apply prevents archival`, async () => {
    const { request, observation } = fixture();
    observation.operation.historicalSiblingFiles = [historicalSibling()];
    const preview = await recoverPreadmission(request, {
      observe: async () => structuredClone(observation),
    });
    change(observation.operation.historicalSiblingFiles);
    await assert.rejects(
      recoverPreadmission(
        { ...request, mode: 'apply', proofSha256: preview.proofSha256 },
        {
          observe: async () => observation,
          archive: async () => assert.fail('changed sibling evidence reached archival'),
        },
      ),
      { message: 'preview_proof_changed' },
    );
  });
test('a historical file content rewrite changes its metadata proof without reading opaque contents', async (t) => {
  const h = await siblingFilesystem(t);
  const first = await observePreadmissionSiblings(h.root, UUID, h.options);
  await writeFile(h.file, 'synthetic-private-rewritten-content', { mode: 0o600 });
  await assert.rejects(observePreadmissionSiblings(h.root, UUID, h.options), {
    message: 'unsafe_historical_sibling_file',
  });
  assert.equal(first.historicalSiblingFiles.length, 1);
});

test('sibling metadata accepts a historical file exactly at its 64 KiB size ceiling', async (t) => {
  const h = await siblingFilesystem(t);
  await truncate(h.file, 65536);
  const ownerStartedAtMs = (await lstat(h.file)).ctimeMs + 1;
  const result = await observePreadmissionSiblings(h.root, UUID, { ownerStartedAtMs });
  assert.equal(result.historicalSiblingFiles.length, 1);
  assert.equal(result.historicalSiblingFiles[0].size, 65536);
});
test('sibling observer never opens or reads opaque historical file contents', async (t) => {
  const h = await siblingFilesystem(t);
  const source = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [moduleUrl, privateDirectory, operationId, cutoff] = process.argv.slice(2);
const { observePreadmissionSiblings } = await import(moduleUrl);
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('opaque_file_contents_accessed'); };
for (const key of ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream']) fs[key] = forbidden;
for (const key of ['open', 'readFile']) fs.promises[key] = forbidden;
syncBuiltinESMExports();
const result = await observePreadmissionSiblings(privateDirectory, operationId, { ownerStartedAtMs: Number(cutoff) });
process.stdout.write(JSON.stringify({ forbiddenCalls, count: result.historicalSiblingFiles.length }));
`;
  const pending = execute(
    process.execPath,
    [
      '--input-type=module',
      '-',
      new URL('./pair-release-preadmission-recovery.mjs', import.meta.url).href,
      h.root,
      UUID,
      String(h.options.ownerStartedAtMs),
    ],
    { timeout: 5000, maxBuffer: 16384 },
  );
  pending.child.stdin.end(source);
  const result = await pending;
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { forbiddenCalls: 0, count: 1 });
});
test('sibling filesystem refuses a FIFO without opening it', async (t) => {
  const h = await siblingFilesystem(t);
  await execute('mkfifo', [join(h.root, 'a-fifo')]);
  await assert.rejects(observePreadmissionSiblings(h.root, UUID, h.options), {
    message: 'unsafe_sibling_private_directory',
  });
});
