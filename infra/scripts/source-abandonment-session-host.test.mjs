import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { legacyColdDigest as digest } from './legacy-cold-journal.mjs';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { SOURCE_ABANDONMENT_SESSION_LIMITS } from './source-abandonment-session-journal.mjs';
import { sourceAbandonmentSessionRuntimeBindings } from './source-abandonment-session-protocol.mjs';
import {
  createSourceAbandonmentSessionHostContext,
  withSourceAbandonmentSessionHostContext,
  readSourceAbandonmentSessionQueueRegistry,
  sourceAbandonmentSessionHostTopology,
  reviewSourceAbandonmentSessionPending,
  resolveSourceAbandonmentSessionRedisUrl,
  validateSourceAbandonmentSessionAdmission,
} from './source-abandonment-session-host.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = 'a'.repeat(64),
  sourceSha = 'b'.repeat(40),
  imageId = `sha256:${hash}`;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const registryText = readFileSync(
  new URL('../../apps/api/src/scripts/legacy-recovery-live-registry.ts', import.meta.url),
  'utf8',
).trim();
const registry = readSourceAbandonmentSessionQueueRegistry(sourceSha, () => registryText);
const clone = structuredClone;

function fixture(t) {
  const operationDir = mkdtempSync(join(tmpdir(), 'source-session-host-'));
  t.after(() => rmSync(operationDir, { recursive: true, force: true }));
  chmodSync(operationDir, 0o700);
  const queueBundlePath = join(operationDir, 'queues.cjs');
  writeFileSync(queueBundlePath, 'module.exports = {};\n', { mode: 0o600 });
  const queueBundleSha256 = sha256(readFileSync(queueBundlePath));
  const connection = {
    networkId: 'c'.repeat(64),
    publisherBotId: 'publisher',
    majorBotIds: ['major'],
    environment: `DATABASE_URL=postgresql://private:password@postgres/maxim\nREDIS_URL=redis://:secret@redis:6379/2\nERASER_CONTROL_URL=http://eraser:3000\nERASER_CONTROL_TOKEN=${'a'.repeat(64)}\n`,
  };
  const manifest = {
    version: 1,
    kind: 'source_abandonment_session_manifest',
    sessionId: uuid(1),
    clusterIdentity: uuid(2),
    epoch: 1,
    controllerNonce: uuid(3),
    sourceSha,
    imageId,
    cutoff: '2026-10-09T16:10:00.000Z',
    baselineDigest: hash,
    topologyDigest: hash,
    registryDigest: hash,
    botCatalogDigest: canonical({ publisherBotId: connection.publisherBotId }),
    enumerationDigest: 'd'.repeat(64),
    enumerationComplete: true,
    excludedCounts: { rejected: 0, unresolved: 0 },
    budgets: Object.fromEntries(
      [
        'durationMs',
        'proofBytes',
        'inventoryPages',
        'inventoryRows',
        'inventoryProbes',
        'inventoryBytes',
        'materializationPages',
      ].map((key) => [key, SOURCE_ABANDONMENT_SESSION_LIMITS[key]]),
    ),
    children: [],
  };
  const baseline = {
    version: 1,
    complete: true,
    sourceSha,
    imageId,
    selectionDigest: manifest.enumerationDigest,
    controllerNonce: manifest.controllerNonce,
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map((serviceName, i) => ({
      serviceName,
      containerId: String(i + 1).padStart(64, '0'),
      imageId,
      sourceSha,
      stopped: false,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
    })),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((serviceName, i) => ({
      serviceName,
      containerId: String(i + 20).padStart(64, '0'),
      imageId,
      sourceSha,
      stopped: false,
      exactGeneration: true,
      restartPolicy: 'unless-stopped',
      nativeBoundaryDigest: hash,
    })),
  };
  manifest.baselineDigest = digest(baseline);
  manifest.topologyDigest = digest(
    sourceAbandonmentSessionHostTopology({
      baseline,
      ...connection,
      queueBundleSha256,
      queueRegistrySha256: registry.queueRegistrySha256,
    }),
  );
  const selection = {
    ownerWebhookEventIds: ['owner'],
    majorBotIds: ['major'],
    protocol: 'source-abandonment-v1',
    abandonBefore: manifest.cutoff,
  };
  const selectedOwners = [
    {
      ownerWebhookEventId: 'owner',
      semanticKey: 'semantic',
      claimId: 'claim',
      chatId: '-chat',
      messageId: 'message',
      userId: 'user',
      sourceAt: '2026-10-09T15:00:00.000Z',
      rawPayloadSha256: hash,
      normalizedPayloadSha256: hash,
      ownerSnapshotSha256: hash,
      claimSnapshotSha256: hash,
    },
  ];
  const cost = { pages: 2, rows: 1, probes: 2, bytes: 200 };
  const catalog = {
    version: 2,
    complete: true,
    namespaceKeyCounts: { 'moderation-actions': 1 },
    cost: {
      pages: 1,
      scanCountHints: 4096,
      matchedKeys: 1,
      keyBytes: 64,
      bytes: 100,
      measurementBytes: 100,
      databaseKeysMax: 10,
      serverDurationUs: 100,
      maxCallDurationUs: 100,
      durationMs: 1,
    },
    issue: null,
  };
  const admission = {
    version: 1,
    operation: 'admission_preview',
    applied: false,
    activationAuthorized: false,
    stoppingAuthorized: false,
    sourceSha,
    imageId,
    decision: 'READY_FOR_COLD_REVIEW',
    sourceCoverageComplete: true,
    issues: [],
    selectionSha256: canonical(selection),
    registrySha256: manifest.registryDigest,
    publisherCatalogSha256: manifest.botCatalogDigest,
    selectedOwners: clone(selectedOwners),
    cost: clone(cost),
    redisCatalogs: [clone(catalog), clone(catalog)],
  };
  manifest.children = [
    {
      certificateId: uuid(4),
      selection,
      selectionDigest: digest(selection),
      admissionDigest: digest(`${JSON.stringify(admission)}\n`),
      authorities: [
        {
          ownerId: 'owner',
          claimId: 'claim',
          semanticKey: 'semantic',
          chatId: '-chat',
          messageId: 'message',
        },
      ],
    },
  ];
  const child = {
    version: 1,
    kind: 'source_abandonment_session_child',
    sessionId: manifest.sessionId,
    manifestDigest: digest(manifest),
    childIndex: 0,
    revision: 1,
    phase: 'PENDING',
    bindings: {
      ...sourceAbandonmentSessionRuntimeBindings(manifest),
      certificateId: uuid(4),
      selectionDigest: digest(selection),
    },
    selection,
    proofs: {},
    blockedReason: null,
  };
  const inv = {
    version: 1,
    operation: 'inventory_preview',
    applied: false,
    activationAuthorized: false,
    decision: 'READY_TO_INSTALL',
    binding: {
      maintenanceId: manifest.controllerNonce,
      queueFenceNonce: digest(manifest.controllerNonce),
      transitionJournalSha256: digest(child),
      sourceSha,
      imageId,
      publisherBotId: 'publisher',
      stoppedGenerations: [...baseline.services, ...baseline.auxiliaries]
        .map(({ serviceName, containerId, sourceSha, imageId }) => ({
          serviceName,
          containerId,
          sourceSha,
          imageId,
          stopped: true,
        }))
        .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    },
    selectionSha256: canonical(selection),
    registrySha256: manifest.registryDigest,
    inventorySha256: null,
    previewSha256: null,
    selectedOwners,
    children: [],
    sqlPlans: [],
    issues: [],
    cost,
    sqlEvidenceSha256: hash,
    redisEvidenceSha256: hash,
    redisCatalogs: [clone(catalog), clone(catalog)],
  };
  const inventoryPath = join(operationDir, 'child-0-inventory.json');
  let pending;
  const save = () => {
    inv.previewSha256 = canonical({
      operation: 'MODERN_SOURCE_ABANDONMENT_V1',
      selection,
      registrySha256: inv.registrySha256,
      selectedOwners: inv.selectedOwners,
      children: inv.children,
    });
    inv.inventorySha256 = canonical({
      version: 1,
      operation: 'MODERN_SOURCE_ABANDONMENT_V1',
      binding: inv.binding,
      selectionSha256: inv.selectionSha256,
      registrySha256: inv.registrySha256,
      sql: inv.sqlEvidenceSha256,
      redis: inv.redisEvidenceSha256,
      previewSha256: inv.previewSha256,
    });
    const bytes = `${JSON.stringify(inv)}\n`;
    writeFileSync(inventoryPath, bytes, { mode: 0o600 });
    pending = {
      version: 1,
      complete: true,
      sourceSha,
      imageId,
      controllerNonce: manifest.controllerNonce,
      selectionDigest: child.bindings.selectionDigest,
      unknownSources: 0,
      saturated: false,
      previewDigest: inv.previewSha256,
      inventoryDigest: inv.inventorySha256,
      inventoryArtifactSha256: sha256(bytes),
      inventory: inv,
    };
  };
  save();
  const calls = [],
    runtimes = [],
    clientOptions = [],
    storeAdapters = [];
  const queue = Object.fromEntries(
    [
      'inspectQueueBaseline',
      'preDrainRuntime',
      'restoreAuxiliaryQueues',
      'pauseAllQueues',
      'resumeWebhookQueues',
      'readWebhookFence',
      'close',
    ].map((name) => [
      name,
      async (...args) => {
        calls.push([name, ...args]);
        return name === 'readWebhookFence'
          ? {
              queueCount: 24,
              pausedCount: 24,
              activeCount: 0,
              ownerPresent: true,
              ownerMatches: true,
            }
          : name === 'inspectQueueBaseline'
            ? {
                version: 1,
                complete: true,
                registryDigest: manifest.registryDigest,
                queueCount: registry.queueNames.length,
                ownerAbsent: true,
                queues: registry.queueNames.map((name) => ({ name, paused: false })),
              }
            : {};
      },
    ]),
  );
  let journal = null,
    timestamp = Date.parse('2026-10-09T16:20:00.000Z');
  const store = {
    read: () => ({ journal }),
    readEvidence: (value) =>
      value === 'hostAdmission'
        ? { admission: { startupReserveMs: 180000 }, queueBaseline: { fromJournal: true } }
        : admission,
  };
  const options = {
    manifest,
    baseline,
    controllerSha: 'e'.repeat(40),
    operationDir,
    store,
    queueBundlePath,
    queueBundleSha256,
    admissionPreview: async () => ({ admission: true }),
    snapshotFrozenInventory: async () => ({ frozen: true }),
    now: () => timestamp,
    dependencies: {
      assertLock: () => {},
      run: (command, args, opts) => {
        calls.push(['run', command, args, opts]);
        if (command === 'git')
          return args[0] === 'rev-parse'
            ? 'e'.repeat(40)
            : args[0] === 'status'
              ? ''
              : registryText;
        return '';
      },
      readConnection: () => connection,
      resolveQueueRedisUrl: () => 'redis://:secret@172.19.0.3:6379/2',
      loadQueueBundle: () => ({
        createSessionQueueAdapters: (config) => {
          calls.push(['queueFactory', config]);
          return queue;
        },
      }),
      createRuntime: (config) => {
        runtimes.push(config);
        return Object.fromEntries(
          [
            'inspectRuntime',
            'readStoppedRuntime',
            'stopRuntime',
            'startBoundRuntime',
            'readRuntimeIdentity',
          ].map((name) => [
            name,
            () => {
              calls.push([name, config.bindings.selectionDigest]);
              return baseline;
            },
          ]),
        );
      },
      createClient: (config) => {
        clientOptions.push(config);
        return {
          remove: () => calls.push(['clientRemove']),
          invoke: (kind, request) => {
            calls.push(['clientInvoke', kind, request]);
            config.run(['start', '-ai', 'client'], { timeout: 55000 });
            return inv;
          },
        };
      },
      createStoreAdapter: (config) => {
        storeAdapters.push(config);
        return {
          snapshotPending: () => config.client.invoke('inventory', { version: 1 }),
          installDispositions: () =>
            config.client.invoke('store', { version: 1, operation: 'install' }),
          materializeReceipts: () => {},
          readSeal: () => config.client.invoke('store', { version: 1, operation: 'readback' }),
        };
      },
      createBatchAdapter: ({ stockAdapter }) => stockAdapter,
      createSmokes: ({ client }) => ({
        readNativeIdentity: async () => ({ native: true }),
        strictSmokes: () => client.invoke('queues', { version: 1, operation: 'status' }),
      }),
    },
  };
  return {
    options,
    manifest,
    baseline,
    connection,
    child,
    admission,
    inv,
    inventoryPath,
    save,
    calls,
    runtimes,
    clientOptions,
    storeAdapters,
    operationDir,
    queue,
    review: () =>
      reviewSourceAbandonmentSessionPending({
        child,
        pending,
        manifest,
        baseline,
        admission,
        queueNames: registry.queueNames,
        publisherBotId: 'publisher',
        inventoryPath,
      }),
    childStore: {
      read: () => ({ child }),
      readProof: () => pending,
      recordProof: digest,
      markAttempted: () => {},
      markMaterialized: () => {},
      block: () => {},
    },
    setJournal: (value) => {
      journal = value;
    },
    setTime: (value) => {
      timestamp = value;
    },
  };
}

test('exact stock source inventory and full catalogs grant a finite review', (t) => {
  const h = fixture(t);
  assert.equal(h.review().sourceSelectionComplete, true);
  assert.equal(h.review().descendantsComplete, true);
});
function reviewAdmission(h) {
  return validateSourceAbandonmentSessionAdmission({
    admission: h.admission,
    selection: h.child.selection,
    authorities: h.manifest.children[0].authorities,
    sourceSha,
    imageId,
    registryDigest: h.manifest.registryDigest,
    publisherCatalogDigest: h.manifest.botCatalogDigest,
    queueNames: registry.queueNames,
  });
}
test('online admission retains changing active counts while cold review stays strict', (t) => {
  const h = fixture(t);
  const second = h.admission.redisCatalogs[1];
  second.namespaceKeyCounts['moderation-actions'] = 2;
  second.cost.matchedKeys = 2;
  const original = JSON.stringify(h.admission);
  assert.equal(reviewAdmission(h), h.admission);
  assert.equal(JSON.stringify(h.admission), original);
  h.manifest.children[0].admissionDigest = sha256(`${original}\n`);
  h.child.manifestDigest = digest(h.manifest);
  h.inv.binding.transitionJournalSha256 = digest(h.child);
  h.save();
  assert.equal(h.review().sourceSelectionComplete, true);
  h.inv.redisCatalogs = clone(h.admission.redisCatalogs);
  h.save();
  assert.throws(h.review, /session_host_catalog_changed/);
});
for (const [name, mutate, pattern] of [
  ['missing pass', (proofs) => proofs.pop(), /catalog_unproved/],
  [
    'incomplete pass',
    (proofs) => {
      proofs[1].complete = false;
    },
    /catalog_unproved/,
  ],
  [
    'reported issue',
    (proofs) => {
      proofs[1].issue = 'CATALOG_PAGE_LIMIT';
    },
    /catalog_unproved/,
  ],
  [
    'unknown namespace',
    (proofs) => {
      proofs[1].namespaceKeyCounts = { unknown: 1 };
    },
    /catalog_unproved/,
  ],
  [
    'changed known namespace',
    (proofs) => {
      proofs[1].namespaceKeyCounts = { 'publisher-start': 1 };
    },
    /catalog_changed/,
  ],
  [
    'disappearing namespace',
    (proofs) => {
      proofs[1].namespaceKeyCounts = {};
      proofs[1].cost.matchedKeys = 0;
      proofs[1].cost.keyBytes = 0;
    },
    /catalog_changed/,
  ],
  [
    'zero count',
    (proofs) => {
      proofs[1].namespaceKeyCounts['moderation-actions'] = 0;
    },
    /catalog_unproved/,
  ],
  [
    'forged count accounting',
    (proofs) => {
      proofs[1].cost.matchedKeys = 2;
    },
    /catalog_cost_unproved/,
  ],
  [
    'page budget',
    (proofs) => {
      proofs[1].cost.pages = 4097;
    },
    /catalog_cost_unproved/,
  ],
  [
    'time budget',
    (proofs) => {
      proofs[1].cost.durationMs = 20001;
    },
    /catalog_cost_unproved/,
  ],
])
  test(`online admission refuses ${name}`, (t) => {
    const h = fixture(t);
    mutate(h.admission.redisCatalogs);
    assert.throws(() => reviewAdmission(h), pattern);
  });
function channelFixture(t) {
  const h = fixture(t);
  for (const owner of [h.inv.selectedOwners[0], h.admission.selectedOwners[0]])
    Object.assign(owner, { sourceProfile: 'CHANNEL_AUTHORLESS_V1', userId: null });
  h.manifest.children[0].admissionDigest = sha256(`${JSON.stringify(h.admission)}\n`);
  h.child.manifestDigest = digest(h.manifest);
  h.inv.binding.transitionJournalSha256 = digest(h.child);
  h.save();
  return h;
}
test('authorless channel evidence has an explicit profile and exactly attributed SQL marker without a invented user', (t) => {
  const h = channelFixture(t);
  h.inv.children = [
    {
      jobKey: 'marker-1',
      queueName: 'sql:channel-auto-post',
      jobPayloadDigest: hash,
      chatId: h.inv.selectedOwners[0].chatId,
      messageId: h.inv.selectedOwners[0].messageId,
    },
  ];
  h.save();
  assert.equal(h.review().sourceSelectionComplete, true);
});
for (const issue of [
  'null-human',
  'invented-channel-user',
  'unknown-profile',
  'explicit-human-profile',
  'channel-child-user',
  'human-channel-marker',
])
  test(`independent source review refuses ${issue}`, (t) => {
    const h =
      issue === 'null-human' || issue === 'human-channel-marker' ? fixture(t) : channelFixture(t);
    const owner = h.inv.selectedOwners[0];
    if (issue === 'null-human') owner.userId = null;
    if (issue === 'invented-channel-user') owner.userId = 'invented';
    if (issue === 'unknown-profile') owner.sourceProfile = 'CHANNEL_V2';
    if (issue === 'explicit-human-profile') {
      owner.sourceProfile = 'HUMAN_CHAT_V1';
      owner.userId = 'human';
    }
    if (issue === 'channel-child-user' || issue === 'human-channel-marker')
      h.inv.children = [
        {
          jobKey: 'marker-1',
          queueName: 'sql:channel-auto-post',
          jobPayloadDigest: hash,
          chatId: owner.chatId,
          messageId: owner.messageId,
          ...(issue === 'channel-child-user' ? { userId: 'invented' } : {}),
        },
      ];
    h.save();
    assert.throws(h.review, /owner_unproved|children_unproved/);
  });

function finalBatchFixture(t) {
  const h = fixture(t);
  h.child.phase = 'MATERIALIZED';
  h.child.proofs = Object.fromEntries(
    [
      'pendingInventory',
      'reviewedPreview',
      'attemptEvidence',
      'installedSeal',
      'materializedSeal',
      'stoppedInventory',
      'queueFence',
      'clientRemoval',
    ].map((name) => [name, hash]),
  );
  h.options.store.childStore = (index) => {
    assert.equal(index, 0);
    return h.childStore;
  };
  const oldRead = h.options.store.readEvidence;
  h.options.store.readEvidence = (reference) =>
    reference === 'hostAdmission'
      ? { admission: { startupReserveMs: 180_000, runtimeRestoreAndSmokesMs: 120_000 } }
      : oldRead(reference);
  const started = Date.parse('2026-10-09T16:20:00.000Z');
  h.setJournal({
    coldStartedAt: new Date(started).toISOString(),
    proofs: { hostAdmission: 'hostAdmission' },
  });
  const batchCalls = [];
  const state = { mutate: () => {} };
  h.options.dependencies.createClient = (config) => ({
    remove: () => batchCalls.push({ remove: true }),
    invoke: (kind, input) => {
      assert.equal(kind, 'source-store-batch');
      batchCalls.push({ input, config });
      const result = {
        version: 1,
        kind: 'source_abandonment_session_store_batch_result',
        phase: 'readback',
        results: input.items.map(({ inventoryIndex, request }) => ({
          inventoryIndex,
          certificateId: request.certificateId,
          result: {
            version: 1,
            operation: 'readback',
            certificateId: request.certificateId,
            activationAuthorized: false,
            bindingSha256: canonical(request.binding),
            inventorySha256: request.expected.inventorySha256,
            previewSha256: request.expected.previewSha256,
            state: 'MATERIALIZED',
            completeChats: 1,
            requiredChats: 1,
          },
        })),
      };
      state.mutate(result);
      return result;
    },
  });
  return { ...h, started, batchCalls, state };
}
test('final aggregate runs two isolated read-only batches and reserves restoration time', async (t) => {
  const h = finalBatchFixture(t);
  h.setTime(h.started + h.manifest.budgets.durationMs - 180_000);
  const host = await createSourceAbandonmentSessionHostContext(h.options);
  const output = host.adapters.readFreshMaterializedChildren([h.child]);
  assert.equal(output.readbacks.length, 1);
  assert.equal(output.readbacks[0].first.reviewedChatCursorsComplete, true);
  assert.equal(output.readbacks[0].second.reviewedChatCursorsComplete, true);
  const batches = h.batchCalls.filter((row) => row.input);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].input.deadlineAtMs, h.started + h.manifest.budgets.durationMs - 120_000);
  assert.deepEqual(batches[0].config.sourceBatchInventoryPaths, [h.inventoryPath]);
  assert.deepEqual(
    h.batchCalls.map((row) => (row.remove ? 'remove' : 'readback')),
    ['remove', 'readback', 'remove', 'remove', 'readback', 'remove'],
  );
  await host.close();
});
test('final batch refuses to consume runtime restoration reserve', async (t) => {
  const h = finalBatchFixture(t);
  h.setTime(h.started + h.manifest.budgets.durationMs - 120_000);
  const host = await createSourceAbandonmentSessionHostContext(h.options);
  assert.throws(() => host.adapters.readFreshMaterializedChildren([h.child]), /deadline_exhausted/);
  assert.equal(
    h.batchCalls.some((row) => row.input),
    false,
  );
  await host.close();
});
test('final batch cannot substitute a sibling certificate or incomplete cursor', async (t) => {
  for (const issue of ['certificate', 'cursor']) {
    const h = finalBatchFixture(t);
    h.state.mutate = (output) => {
      if (issue === 'certificate') output.results[0].certificateId = uuid(90);
      else output.results[0].result.completeChats = 0;
    };
    const host = await createSourceAbandonmentSessionHostContext(h.options);
    assert.throws(
      () => host.adapters.readFreshMaterializedChildren([h.child]),
      /unproved|changed|incomplete/,
    );
    assert.equal(h.batchCalls.filter((row) => row.input).length, 1);
    await host.close();
  }
});
for (const [name, mutate, pattern] of [
  [
    'claim authority',
    (h) => {
      h.inv.selectedOwners[0].claimId = 'other';
    },
    /authority/,
  ],
  [
    'semantic authority',
    (h) => {
      h.inv.selectedOwners[0].semanticKey = 'other';
    },
    /authority/,
  ],
  [
    'message authority',
    (h) => {
      h.inv.selectedOwners[0].messageId = 'other';
    },
    /authority/,
  ],
  [
    'source cutoff',
    (h) => {
      h.inv.selectedOwners[0].sourceAt = h.manifest.cutoff;
    },
    /owner/,
  ],
  [
    'source hash',
    (h) => {
      h.inv.binding.sourceSha = 'f'.repeat(40);
    },
    /binding/,
  ],
  [
    'transition journal',
    (h) => {
      h.inv.binding.transitionJournalSha256 = 'f'.repeat(64);
    },
    /binding/,
  ],
  [
    'source evidence',
    (h) => {
      h.inv.selectedOwners[0].rawPayloadSha256 = null;
    },
    /owner/,
  ],
  [
    'registry identity',
    (h) => {
      h.inv.registrySha256 = 'f'.repeat(64);
    },
    /inventory/,
  ],
  [
    'catalog incomplete',
    (h) => {
      h.inv.redisCatalogs[0].complete = false;
    },
    /catalog/,
  ],
  [
    'catalog forged cost',
    (h) => {
      h.inv.redisCatalogs[0].cost.pages = 4097;
    },
    /cost/,
  ],
  [
    'catalog divergent counts',
    (h) => {
      h.inv.redisCatalogs[0].namespaceKeyCounts['moderation-actions'] = 2;
      h.inv.redisCatalogs[0].cost.matchedKeys = 2;
    },
    /catalog_changed/,
  ],
  [
    'unknown namespace',
    (h) => {
      h.inv.redisCatalogs[0].namespaceKeyCounts['unreviewed'] = 1;
      h.inv.redisCatalogs[0].cost.matchedKeys = 2;
    },
    /catalog/,
  ],
  [
    'collector budget',
    (h) => {
      h.inv.cost.rows = 10001;
    },
    /cost/,
  ],
  [
    'wrong stopped generation',
    (h) => {
      h.inv.binding.stoppedGenerations[0].containerId = 'f'.repeat(64);
    },
    /generations/,
  ],
  [
    'child authority',
    (h) => {
      h.inv.children = [
        {
          jobKey: 'job',
          queueName: 'moderation-actions',
          jobPayloadDigest: hash,
          chatId: 'other',
          messageId: 'message',
        },
      ];
    },
    /children/,
  ],
  [
    'child source context',
    (h) => {
      h.child.bindings.sourceSha = 'f'.repeat(40);
      h.child.bindings.targetSha = 'f'.repeat(40);
    },
    /context/,
  ],
])
  test(`independent review refuses ${name} even with rehashed artifact`, (t) => {
    const h = fixture(t);
    mutate(h);
    h.save();
    assert.throws(h.review, pattern);
  });
test('artifact bytes and stock admission cannot be substituted', (t) => {
  const h = fixture(t);
  writeFileSync(h.inventoryPath, '{}\n');
  assert.throws(h.review, /artifact/);
  h.save();
  h.admission.sourceCoverageComplete = false;
  assert.throws(h.review, /admission/);
});
test('stock digest projection is recomputed independently', (t) => {
  const h = fixture(t);
  h.inv.selectedOwners[0].ownerSnapshotSha256 = 'f'.repeat(64);
  writeFileSync(h.inventoryPath, `${JSON.stringify(h.inv)}\n`);
  assert.throws(h.review, /digest/);
});

test('real host uses one queue FIFO, exact per-child runtime and private environment', async (t) => {
  const h = fixture(t),
    host = await createSourceAbandonmentSessionHostContext(h.options);
  assert.equal(statSync(join(h.operationDir, 'store.env')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(h.operationDir, 'store.env'), 'utf8'), h.connection.environment);
  assert.equal(JSON.stringify(host.context).includes('secret'), false);
  assert.equal(host.context.controllerSha, h.options.controllerSha);
  assert.equal(host.context.runtimeSha, sourceSha);
  await host.adapters.inspectQueueBaseline();
  await host.adapters.pauseQueues();
  const child = host.adapters.createChildAdapters(0, h.childStore, h.child);
  assert.equal(h.runtimes[1].bindings.selectionDigest, h.child.bindings.selectionDigest);
  assert.equal(h.runtimes[1].baseline, h.runtimes[0].baseline);
  assert.equal(h.storeAdapters[0].store.read().journal.kind, 'source_abandonment_session_child');
  assert.equal(h.clientOptions[0].controllerNonce, h.clientOptions[1].controllerNonce);
  assert.notEqual(h.clientOptions[0].inventoryPath, h.clientOptions[1].inventoryPath);
  assert.deepEqual(
    h.clientOptions[0].sourceSessionCold.bindings,
    sourceAbandonmentSessionRuntimeBindings(h.manifest),
  );
  assert.deepEqual(
    h.clientOptions[1].sourceSessionCold.bindings,
    sourceAbandonmentSessionRuntimeBindings(h.manifest),
  );
  const priorStoppedReads = h.calls.filter(([name]) => name === 'readStoppedRuntime').length;
  h.clientOptions[1].sourceSessionCold.readStoppedRuntime();
  assert.equal(
    h.calls.filter(([name]) => name === 'readStoppedRuntime').length,
    priorStoppedReads + 1,
  );
  assert.equal((await child.readQueueFence()).ownerNonce, h.manifest.controllerNonce);
  await host.adapters.resumeQueues();
  await host.adapters.strictSmokes();
  assert.equal(h.calls.filter(([name]) => name === 'queueFactory').length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'readWebhookFence').length, 2);
  assert.equal(
    h.calls.some(([name, kind]) => name === 'clientInvoke' && kind === 'queues'),
    false,
  );
  assert.equal(Object.hasOwn(child, 'pauseQueues'), false);
  assert.equal(Object.hasOwn(child, 'startBoundRuntime'), false);
  await host.close();
  assert.equal(existsSync(join(h.operationDir, 'store.env')), false);
  assert.equal(h.calls.filter(([name]) => name === 'close').length, 1);
});
test('wrapper cleanup runs after callback failure and exact context can continue', async (t) => {
  const h = fixture(t);
  await assert.rejects(
    withSourceAbandonmentSessionHostContext(h.options, async () => {
      throw new Error('callback failed');
    }),
    /callback failed/,
  );
  assert.equal(existsSync(join(h.operationDir, 'store.env')), false);
  const host = await createSourceAbandonmentSessionHostContext(h.options);
  await host.close();
});
for (const [name, mutate, pattern] of [
  [
    'controller',
    (h) => {
      h.options.controllerSha = 'f'.repeat(40);
    },
    /controller/,
  ],
  [
    'dirty controller',
    (h) => {
      const run = h.options.dependencies.run;
      h.options.dependencies.run = (command, args, ...rest) =>
        args[0] === 'status' ? ' M changed' : run(command, args, ...rest);
    },
    /controller/,
  ],
  [
    'baseline',
    (h) => {
      h.baseline.services[0].containerId = 'f'.repeat(64);
    },
    /baseline/,
  ],
  [
    'catalog',
    (h) => {
      h.connection.majorBotIds = ['other'];
    },
    /catalog/,
  ],
  [
    'MAX credential',
    (h) => {
      h.connection.environment += 'MAX_BOT_TOKEN=secret\n';
    },
    /environment/,
  ],
  [
    'queue bundle',
    (h) => {
      writeFileSync(h.options.queueBundlePath, 'changed');
    },
    /bundle/,
  ],
  [
    'queue bundle mode',
    (h) => {
      chmodSync(h.options.queueBundlePath, 0o644);
    },
    /private_file/,
  ],
  [
    'queue bundle hardlink',
    (h) => {
      linkSync(h.options.queueBundlePath, join(h.operationDir, 'alias'));
    },
    /private_file/,
  ],
])
  test(`host refuses changed ${name} before opening Redis`, async (t) => {
    const h = fixture(t);
    mutate(h);
    await assert.rejects(createSourceAbandonmentSessionHostContext(h.options), pattern);
    assert.equal(
      h.calls.some(([name]) => name === 'queueFactory'),
      false,
    );
  });
test('continuation refuses changed immutable context and credential file', async (t) => {
  const h = fixture(t),
    host = await createSourceAbandonmentSessionHostContext(h.options);
  await host.close();
  const context = JSON.parse(readFileSync(join(h.operationDir, 'context.json'), 'utf8'));
  context.runtimeSha = 'f'.repeat(40);
  writeFileSync(join(h.operationDir, 'context.json'), JSON.stringify(context));
  await assert.rejects(createSourceAbandonmentSessionHostContext(h.options), /context_changed/);
});
test('credential symlink is not followed or removed', async (t) => {
  const h = fixture(t),
    outside = join(h.operationDir, 'outside');
  writeFileSync(outside, 'private', { mode: 0o600 });
  symlinkSync(outside, join(h.operationDir, 'store.env'));
  await assert.rejects(createSourceAbandonmentSessionHostContext(h.options));
  assert.equal(readFileSync(outside, 'utf8'), 'private');
});
test('remaining work time clamps real store subprocess; final readback remains available', async (t) => {
  const h = fixture(t),
    frozenCalls = [];
  h.options.snapshotFrozenInventory = (...args) => frozenCalls.push(args);
  const host = await createSourceAbandonmentSessionHostContext(h.options),
    child = host.adapters.createChildAdapters(0, h.childStore, h.child);
  h.setJournal({
    coldStartedAt: '2026-10-09T16:20:00.000Z',
    proofs: { hostAdmission: 'hostAdmission' },
  });
  h.setTime(Date.parse('2026-10-09T16:20:00.000Z') + h.manifest.budgets.durationMs - 180000 - 1000);
  child.installDispositions();
  assert.equal(h.calls.at(-1)[3].timeout, 1000);
  host.adapters.snapshotFrozenInventory(h.manifest, h.child.bindings);
  assert.equal(
    frozenCalls[0][2].deadlineAtMs,
    Date.parse('2026-10-09T16:20:00.000Z') + h.manifest.budgets.durationMs - 180000,
  );
  h.setTime(Date.parse('2026-10-09T16:20:00.000Z') + h.manifest.budgets.durationMs - 180000);
  assert.throws(() => child.installDispositions(), /window_exhausted/);
  child.readSeal();
  await host.close();
});
test('literal registry binds current 54 or retained 53 names to the exact requested source', () => {
  let requested;
  readSourceAbandonmentSessionQueueRegistry(sourceSha, (_cmd, args) => {
    requested = args;
    return registryText;
  });
  assert.equal(requested[1], `${sourceSha}:apps/api/src/scripts/legacy-recovery-live-registry.ts`);
  assert.equal(registry.queueNames.length, 54);
  const legacyText = registryText.replace("  'admin-manual-commands',\n", '');
  const legacySha = 'c'.repeat(40);
  const legacy = readSourceAbandonmentSessionQueueRegistry(legacySha, (_cmd, args) => {
    assert.equal(args[1], `${legacySha}:apps/api/src/scripts/legacy-recovery-live-registry.ts`);
    return legacyText;
  });
  assert.equal(legacy.queueNames.length, 53);
  assert.equal(legacy.queueNames.includes('admin-manual-commands'), false);
  assert.equal(legacy.queueRegistrySha256, sha256(legacyText));
  assert.notEqual(legacy.queueRegistrySha256, registry.queueRegistrySha256);
  assert.throws(
    () =>
      readSourceAbandonmentSessionQueueRegistry(sourceSha, () =>
        registryText.replace("  'message-retention',", ''),
      ),
    /registry/,
  );
  for (const changed of [
    legacyText.replace("  'message-retention',", ''),
    registryText.replace("  'message-retention',", "  'message-retention',\n  'unreviewed-extra',"),
    registryText.replace("  'admin-manual-commands',", "  'unreviewed-replacement',"),
    registryText.replace("  'admin-super-ban',", "  'admin-manual-commands',"),
  ])
    assert.throws(
      () => readSourceAbandonmentSessionQueueRegistry(sourceSha, () => changed),
      /registry/u,
    );
});

function redisFixture() {
  return {
    connection: {
      networkId: 'c'.repeat(64),
      environment: 'DATABASE_URL=postgresql://private\nREDIS_URL=redis://:secret@redis:6379/2\n',
    },
    row: {
      Id: hash,
      Config: {
        Labels: { 'com.docker.compose.project': 'infra', 'com.docker.compose.service': 'redis' },
      },
      State: { Running: true, Paused: false, Restarting: false, Dead: false },
      NetworkSettings: {
        Networks: { infra_default: { NetworkID: 'c'.repeat(64), IPAddress: '172.19.0.3' } },
      },
    },
  };
}
test('Redis alias resolves only to exact captured bridge without changing credentials/database', () => {
  const h = redisFixture();
  assert.equal(
    resolveSourceAbandonmentSessionRedisUrl(h.connection, () => JSON.stringify([h.row])),
    'redis://:secret@172.19.0.3:6379/2',
  );
});
for (const [name, mutate] of [
  [
    'foreign network',
    (h) => {
      h.row.NetworkSettings.Networks.infra_default.NetworkID = hash;
    },
  ],
  [
    'external host',
    (h) => {
      h.connection.environment = h.connection.environment.replace('@redis:', '@attacker:');
    },
  ],
  [
    'unhealthy',
    (h) => {
      h.row.State.Health = { Status: 'unhealthy' };
    },
  ],
  [
    'configured but absent health',
    (h) => {
      h.row.Config.Healthcheck = { Test: ['CMD', 'false'] };
    },
  ],
  [
    'restarting',
    (h) => {
      h.row.State.Restarting = true;
    },
  ],
  [
    'stopped',
    (h) => {
      h.row.State.Running = false;
    },
  ],
])
  test(`Redis route refuses ${name} without exposing URL`, () => {
    const h = redisFixture();
    mutate(h);
    assert.throws(
      () => resolveSourceAbandonmentSessionRedisUrl(h.connection, () => JSON.stringify([h.row])),
      (error) =>
        error.message === 'session_host_redis_route_unproved' && !error.message.includes('secret'),
    );
  });
