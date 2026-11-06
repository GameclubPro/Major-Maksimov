import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { canonicalLegacyColdDigest } from './legacy-cold-store-adapter.mjs';
import {
  createSourceAbandonmentSessionStore,
  assertNoActiveSourceAbandonmentSession,
  SOURCE_ABANDONMENT_SESSION_LIMITS as limits,
  sourceAbandonmentSessionDigest as digest,
} from './source-abandonment-session-journal.mjs';
import {
  prepareSourceAbandonmentSession,
  applySourceAbandonmentSession,
  finishSourceAbandonmentSession,
  reconcileSourceAbandonmentSession,
  sourceAbandonmentSessionRuntimeBindings,
} from './source-abandonment-session-protocol.mjs';

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const hash = 'a'.repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));
const proofDigest = (value) => digest(`${JSON.stringify(value)}\n`);
function fixture(t, count = 2, queueCount = 54) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-session-protocol-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = {
    running: true,
    now: Date.parse('2026-10-09T16:20:00.000Z'),
    events: [],
    certificates: Array.from({ length: count }, () => 'ABSENT'),
    calls: Array.from({ length: count }, () => 0),
    childFaults: {},
    faults: {},
    factoryIndexes: [],
  };
  const store = createSourceAbandonmentSessionStore({
    directory,
    assertLock() {},
    now: () => new Date(state.now).toISOString(),
  });
  const manifest = {
    version: 1,
    kind: 'source_abandonment_session_manifest',
    sessionId: uuid(1),
    clusterIdentity: uuid(2),
    epoch: 1,
    controllerNonce: uuid(3),
    sourceSha: 'b'.repeat(40),
    imageId: `sha256:${hash}`,
    cutoff: '2026-10-09T16:10:00.000Z',
    baselineDigest: hash,
    topologyDigest: hash,
    registryDigest: hash,
    botCatalogDigest: hash,
    enumerationDigest: 'c'.repeat(64),
    enumerationComplete: true,
    excludedCounts: { rejected: 2, unresolved: 3 },
    budgets: Object.fromEntries(
      [
        'durationMs',
        'proofBytes',
        'inventoryPages',
        'inventoryRows',
        'inventoryProbes',
        'inventoryBytes',
        'materializationPages',
      ].map((key) => [key, limits[key]]),
    ),
    children: Array.from({ length: count }, (_, index) => {
      const selection = {
        ownerWebhookEventIds: [`private_owner_${index}`],
        majorBotIds: ['private_bot'],
        protocol: 'source-abandonment-v1',
        abandonBefore: '2026-10-09T16:10:00.000Z',
      };
      return {
        certificateId: uuid(index + 10),
        selection,
        selectionDigest: digest(selection),
        admissionDigest: hash,
        authorities: [
          {
            ownerId: `private_owner_${index}`,
            claimId: `private_claim_${index}`,
            semanticKey: `private_semantic_${index}`,
            chatId: '-private_chat',
            messageId: `private_message_${index}`,
          },
        ],
      };
    }),
  };
  for (const child of manifest.children)
    child.admissionDigest = store.recordProof({
      version: 1,
      operation: 'admission_preview',
      applied: false,
      activationAuthorized: false,
      stoppingAuthorized: false,
      sourceSha: manifest.sourceSha,
      imageId: manifest.imageId,
      selectionSha256: canonicalLegacyColdDigest(child.selection),
      publisherCatalogSha256: manifest.botCatalogDigest,
      registrySha256: manifest.registryDigest,
      decision: 'READY_FOR_COLD_REVIEW',
      sourceCoverageComplete: true,
      issues: [],
      selectedOwners: child.authorities.map(({ ownerId, ...row }) => ({
        ownerWebhookEventId: ownerId,
        ...row,
      })),
    });
  const stockBase = (bindings) => ({
    version: 1,
    complete: true,
    sourceSha: bindings.targetSha,
    imageId: bindings.targetImageId,
    selectionDigest: bindings.selectionDigest,
    controllerNonce: bindings.controllerNonce,
  });
  const parent = (fields) => ({
    version: 1,
    complete: true,
    sessionId: manifest.sessionId,
    manifestDigest: digest(manifest),
    ...fields,
  });
  const generation = (serviceName, stopped) => ({
    serviceName,
    stopped,
    exactGeneration: true,
    restartPolicy: 'unless-stopped',
  });
  const runtime = (bindings, stopped) => ({
    ...stockBase(bindings),
    compatible: true,
    singletonCount: 14,
    nativeCount: 2,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map((name) => generation(name, stopped)),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((name) =>
      generation(name, stopped),
    ),
  });
  manifest.baselineDigest = digest(
    runtime(sourceAbandonmentSessionRuntimeBindings(manifest), false),
  );
  const originalQueues = Array.from({ length: 53 }, (_, index) => ({
    name: `queue_${index}`,
    paused: index >= 24 && index % 3 === 0,
  }));
  if (queueCount === 54) originalQueues.push({ name: 'admin-manual-commands', paused: true });
  state.queues = clone(originalQueues);
  const queueBaseline = {
    version: 1,
    complete: true,
    registryDigest: manifest.registryDigest,
    queueCount: originalQueues.length,
    ownerAbsent: true,
    queues: clone(originalQueues),
  };
  const fence = (bindings) => ({
    ...stockBase(bindings),
    queueCount: 24,
    pausedCount: state.queues.slice(0, 24).filter((row) => row.paused).length,
    activeCount: 0,
    ownerNonce: bindings.controllerNonce,
  });
  const operations = {
    inspectRuntime: (bindings) => runtime(bindings, !state.running),
    inspectQueueBaseline: () => clone(queueBaseline),
    admissionPreview: () =>
      parent({
        feasible: true,
        estimatedColdMs: 600000,
        startupReserveMs: 60000,
        frozenInventoryReservation: {
          inventoryPages: 3,
          inventoryRows: 100,
          inventoryProbes: 500,
          inventoryBytes: 100000,
          materializationPages: 0,
        },
      }),
    preDrainRuntime() {
      assert.equal(store.read().journal.phase, 'STOPPING');
      assert.deepEqual(
        store.readEvidence(store.read().journal.proofs.hostAdmission).queueBaseline,
        queueBaseline,
      );
      for (const row of state.queues) row.paused = true;
      return parent({
        queueCount: originalQueues.length,
        pausedCount: originalQueues.length,
        activeCount: 0,
        queueWorkDrained: true,
        ownerNonce: manifest.controllerNonce,
      });
    },
    stopRuntime() {
      state.running = false;
    },
    readStoppedRuntime: (bindings) => runtime(bindings, !state.running),
    pauseQueues() {
      for (const row of state.queues.slice(0, 24)) row.paused = true;
    },
    readQueueFence: fence,
    snapshotFrozenInventory() {
      assert.equal(state.running, false);
      assert.equal(
        state.queues.every((row) => row.paused),
        true,
      );
      assert.equal(
        store.read().journal.children.every((child) => child.phase === 'PENDING'),
        true,
      );
      return parent({
        coverage: 'FROZEN',
        cutoff: manifest.cutoff,
        sourceSha: manifest.sourceSha,
        imageId: manifest.imageId,
        enumerationComplete: true,
        plannedEnumerationDigest: manifest.enumerationDigest,
        frozenEnumerationDigest: hash,
        manifestMatches: true,
        unknownAdditions: 0,
        missingOrChangedAuthorities: 0,
      });
    },
    removeStoreClients() {},
    reviewPendingInventory(child, pending) {
      return {
        version: 1,
        previewDigest: pending.previewDigest,
        inventoryDigest: pending.inventoryDigest,
        selectionDigest: child.bindings.selectionDigest,
        admissionDigest: manifest.children[child.childIndex].admissionDigest,
        sourceSelectionComplete: true,
        descendantsComplete: true,
      };
    },
    createChildAdapters(index, childStore, child) {
      state.factoryIndexes.push(index);
      const base = stockBase(child.bindings);
      const invoke =
        (name, fn) =>
        (...args) => {
          state.events.push(`child_${index}_${name}`);
          return state.childFaults[`${index}:${name}`]
            ? state.childFaults[`${index}:${name}`](...args)
            : fn(...args);
        };
      const previewDigest = digest(`preview_${index}`),
        inventoryDigest = digest(`inventory_${index}`);
      return {
        removeStoreClient: invoke('remove', () => {}),
        readStoppedRuntime: invoke('stopped', () => runtime(child.bindings, !state.running)),
        readQueueFence: invoke('fence', () => fence(child.bindings)),
        snapshotPending: invoke('snapshot', () => {
          const current = childStore.read().child;
          if (current.proofs.pendingInventory)
            return {
              ...childStore.readProof('pendingInventory'),
              recheckProof: store.recordProof({
                version: 1,
                childIndex: index,
                freshRecheck: true,
              }),
            };
          const inventory = {
            version: 1,
            operation: 'inventory_preview',
            applied: false,
            activationAuthorized: false,
            decision: 'READY_TO_INSTALL',
            issues: [],
            children: [],
            registrySha256: manifest.registryDigest,
            selectionSha256: canonicalLegacyColdDigest(child.selection),
            binding: {
              maintenanceId: child.bindings.controllerNonce,
              queueFenceNonce: digest(child.bindings.controllerNonce),
              sourceSha: manifest.sourceSha,
              imageId: manifest.imageId,
              transitionJournalSha256: digest(current),
            },
            selectedOwners: manifest.children[index].authorities.map(({ ownerId, ...row }) => ({
              ownerWebhookEventId: ownerId,
              ...row,
            })),
          };
          return {
            ...base,
            previewDigest,
            inventoryDigest,
            unknownSources: 0,
            saturated: false,
            inventoryArtifactSha256: proofDigest(inventory),
            inventory,
          };
        }),
        installDispositions: invoke('install', () => {
          assert.equal(state.running, false);
          assert.equal(
            state.queues.every((row) => row.paused),
            true,
          );
          assert.equal(childStore.read().child.phase, 'ATTEMPTED');
          assert.throws(() => assertNoActiveSourceAbandonmentSession(directory));
          state.calls[index]++;
          state.certificates[index] = 'SEALED';
        }),
        readSeal: invoke('seal', () => ({
          ...base,
          previewDigest,
          inventoryDigest,
          permanentHoldsComplete: ['SEALED', 'MATERIALIZED'].includes(state.certificates[index]),
          ownerProofsComplete: ['SEALED', 'MATERIALIZED'].includes(state.certificates[index]),
          reviewedChatCursorsComplete: state.certificates[index] === 'MATERIALIZED',
        })),
        materializeReceipts: invoke('materialize', () => {
          state.certificates[index] = 'MATERIALIZED';
        }),
      };
    },
    startBoundRuntime() {
      assert.throws(() => assertNoActiveSourceAbandonmentSession(directory));
      assert.ok(['RESUMING', 'ABORT_RESUMING'].includes(store.read().journal.phase));
      assert.equal(state.running, false);
      state.events.push('native_start');
      state.events.push('native_health');
      state.events.push('api_start');
      state.running = true;
    },
    readRuntimeIdentity: (bindings) => ({
      ...runtime(bindings, false),
      exactGenerationCount: state.running ? 14 : 0,
    }),
    readNativeIdentity: (bindings) => ({
      ...stockBase(bindings),
      exactGenerationCount: state.running ? 2 : 0,
    }),
    resumeQueues() {
      for (const row of state.queues.slice(0, 24)) row.paused = false;
    },
    restoreAuxiliaryQueues(_manifest, baseline) {
      assert.equal(
        state.queues.slice(0, 24).some((row) => row.paused),
        false,
      );
      for (let index = 24; index < baseline.queues.length; index++)
        state.queues[index].paused = baseline.queues[index].paused;
      return parent({ restored: true, queueBaselineDigest: digest(baseline) });
    },
    strictSmokes: (bindings) => ({
      ...stockBase(bindings),
      ingressReady: true,
      adminReady: true,
      dependenciesReady: true,
      queueBacklogOnly: false,
      queuesResumed: true,
      actionableLagSeconds: 0,
    }),
  };
  const adapters = Object.fromEntries(
    Object.entries(operations).map(([name, fn]) => [
      name,
      (...args) => {
        state.events.push(name);
        return state.faults[name] ? state.faults[name](...args) : fn(...args);
      },
    ]),
  );
  const prepare = () =>
    prepareSourceAbandonmentSession({ store, manifest, adapters, now: () => state.now });
  const apply = () =>
    applySourceAbandonmentSession({
      store,
      adapters,
      expectedJournalDigest: store.read().digest,
      now: () => state.now,
    });
  const finish = (mode) =>
    finishSourceAbandonmentSession({
      store,
      adapters,
      expectedJournalDigest: store.read().digest,
      mode,
      now: () => state.now,
    });
  const reconcile = () =>
    reconcileSourceAbandonmentSession({
      store,
      adapters,
      expectedJournalDigest: store.read().digest,
      now: () => state.now,
    });
  return {
    directory,
    store,
    manifest,
    state,
    operations,
    adapters,
    parent,
    queueBaseline,
    prepare,
    apply,
    finish,
    reconcile,
  };
}

test('two actual journal children run within one stop/start and restore every original auxiliary pause', async (t) => {
  const h = fixture(t);
  const preview = await h.prepare();
  assert.equal(preview.prepared, true);
  assert.equal(h.state.running, false);
  const outcome = await h.apply();
  assert.equal(outcome.phase, 'COMPLETE');
  assert.equal(outcome.materializedChildren, 2);
  assert.equal(outcome.unattemptedChildren, 0);
  assert.equal(outcome.fleetRecoveryProven, false);
  assert.deepEqual(outcome.excluded, { rejected: 2, unresolved: 3 });
  assert.deepEqual(h.state.calls, [1, 1]);
  assert.equal(h.state.events.filter((event) => event === 'stopRuntime').length, 1);
  assert.equal(h.state.events.filter((event) => event === 'startBoundRuntime').length, 1);
  assert.equal(h.state.events.filter((event) => event === 'preDrainRuntime').length, 1);
  assert.ok(h.state.events.indexOf('native_start') < h.state.events.indexOf('native_health'));
  assert.ok(h.state.events.indexOf('native_health') < h.state.events.indexOf('api_start'));
  assert.ok(
    h.state.events.indexOf('snapshotFrozenInventory') < h.state.events.indexOf('child_0_snapshot'),
  );
  assert.ok(
    h.state.events.lastIndexOf('child_1_seal') < h.state.events.indexOf('startBoundRuntime'),
  );
  assert.ok(
    h.state.events.indexOf('resumeQueues') < h.state.events.indexOf('restoreAuxiliaryQueues'),
  );
  assert.ok(
    h.state.events.indexOf('restoreAuxiliaryQueues') < h.state.events.indexOf('strictSmokes'),
  );
  assert.deepEqual(h.state.queues, h.queueBaseline.queues);
  assert.equal(assertNoActiveSourceAbandonmentSession(h.directory).journal.phase, 'COMPLETE');
  const used = h.store.read().journal.used;
  assert.equal(used.inventoryPages, 3 + 4 * 512);
  assert.equal(used.materializationPages, 400);
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /private_owner|private_chat|private_message|private_bot/,
  );
});
test('a retained 53-queue session completes with the original baseline and no synthesized command queue', async (t) => {
  const h = fixture(t, 1, 53);
  const baselineBytes = JSON.stringify(h.queueBaseline);
  await h.prepare();
  const outcome = await h.apply();
  assert.equal(outcome.phase, 'COMPLETE');
  assert.equal(h.queueBaseline.queueCount, 53);
  assert.equal(JSON.stringify(h.queueBaseline), baselineBytes);
  assert.deepEqual(h.state.queues, h.queueBaseline.queues);
  assert.equal(
    h.state.queues.some(({ name }) => name === 'admin-manual-commands'),
    false,
  );
  assert.deepEqual(
    h.store.readEvidence(h.store.read().journal.proofs.hostAdmission).queueBaseline,
    h.queueBaseline,
  );
});
for (const [label, change] of [
  [
    '52 names',
    (value) => {
      value.queues = value.queues.slice(0, 52);
      value.queueCount = 52;
    },
  ],
  [
    '55 names',
    (value) => {
      value.queues.push({ name: 'unreviewed-extra', paused: false });
      value.queueCount = 55;
    },
  ],
  [
    '54 without command',
    (value) => {
      value.queues.at(-1).name = 'unreviewed-replacement';
    },
  ],
  [
    '53 retaining command',
    (value) => {
      value.queues.splice(0, 1);
      value.queueCount = 53;
    },
  ],
  [
    'duplicate',
    (value) => {
      value.queues[0].name = value.queues[1].name;
    },
  ],
  [
    'count drift',
    (value) => {
      value.queueCount = 53;
    },
  ],
])
  test(`unsupported queue baseline ${label} refuses before stopping`, async (t) => {
    const h = fixture(t, 1);
    change(h.queueBaseline);
    await assert.rejects(h.prepare(), /session_queue_baseline_unproved/u);
    assert.equal(h.store.read().journal, null);
    assert.equal(h.state.running, true);
    assert.equal(h.state.events.includes('preDrainRuntime'), false);
  });
test('infeasible measured duration or cumulative work refuses before admission and pause', async (t) => {
  for (const type of ['duration', 'work']) {
    const h = fixture(t);
    if (type === 'duration')
      h.state.faults.admissionPreview = () => ({
        ...h.operations.admissionPreview(),
        estimatedColdMs: 9999999,
      });
    else h.manifest.budgets.inventoryPages = 512;
    await assert.rejects(h.prepare(), /infeasible/);
    assert.equal(h.store.read().journal, null);
    assert.equal(h.state.running, true);
    assert.equal(h.state.events.includes('preDrainRuntime'), false);
  }
});
test('incomplete or changed frozen coverage never reaches any child; explicit zero-attempt abort restores work', async (t) => {
  const h = fixture(t);
  h.state.faults.snapshotFrozenInventory = () => ({
    ...h.operations.snapshotFrozenInventory(),
    unknownAdditions: 1,
  });
  await assert.rejects(h.prepare(), /source_abandonment_session_refused/);
  assert.equal(h.state.running, false);
  assert.equal(h.state.factoryIndexes.length, 0);
  assert.equal(h.store.read().journal.phase, 'STOPPING');
  const outcome = await h.finish('abort');
  assert.equal(outcome.phase, 'ABORTED');
  assert.equal(outcome.materializedChildren, 0);
  assert.equal(outcome.unattemptedChildren, 2);
  assert.equal(outcome.selectedScopeComplete, false);
  assert.deepEqual(h.state.queues, h.queueBaseline.queues);
  assert.equal(h.state.running, true);
});
test('failed child one snapshot permits typed abort but complete/partial cannot hide untouched scope', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['0:snapshot'] = () => {
    throw new Error('collector_refused');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  await assert.rejects(h.finish('complete'), /scope_unproved/);
  await assert.rejects(h.finish('partial'), /scope_unproved/);
  assert.equal((await h.finish('abort')).phase, 'ABORTED');
  assert.deepEqual(h.state.calls, [0, 0]);
});
test('failure before child two attempt supports truthful partial completion after fresh child one readback', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['1:snapshot'] = () => {
    throw new Error('unsupported_source');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  assert.equal(h.state.running, false);
  assert.deepEqual(h.state.calls, [1, 0]);
  await assert.rejects(h.finish('complete'), /scope_unproved/);
  await assert.rejects(h.finish('abort'), /scope_unproved/);
  const outcome = await h.finish('partial');
  assert.equal(outcome.phase, 'PARTIAL_COMPLETE');
  assert.equal(outcome.materializedOwners, 1);
  assert.equal(outcome.unattemptedOwners, 1);
  assert.equal(outcome.selectedScopeComplete, false);
  assert.equal(outcome.fleetRecoveryProven, false);
  assert.equal(h.state.running, true);
});
test('an unknown attempted child blocks every terminal branch and never replays install', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['1:install'] = () => {
    h.state.calls[1]++;
    h.state.certificates[1] = 'UNSEALED';
    throw Object.assign(new Error('unknown_write'), { outcomeUnknown: true });
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  for (const mode of ['complete', 'partial', 'abort'])
    await assert.rejects(h.finish(mode), /unresolved_child/);
  await assert.rejects(h.reconcile(), /source_abandonment_session_refused/);
  assert.deepEqual(h.state.calls, [1, 1]);
  assert.equal(h.state.running, false);
  assert.equal(h.state.events.includes('startBoundRuntime'), false);
});
test('bounded materialization reconciliation preserves original certificate and does not prepare another child', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['0:materialize'] = () => {
    throw new Error('lost_materialization_response');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  const certificate = h.store.childStore(0).read().child.bindings.certificateId;
  delete h.state.childFaults['0:materialize'];
  assert.equal((await h.reconcile()).reconciled, true);
  assert.deepEqual(h.state.calls, [1, 0]);
  assert.equal(h.store.childStore(0).read().child.bindings.certificateId, certificate);
  assert.equal(h.store.childStore(1).read().child.phase, 'PENDING');
  assert.equal((await h.finish('partial')).phase, 'PARTIAL_COMPLETE');
  assert.equal(h.store.read().journal.used.materializationPages, 400);
});
test('final aggregate readback catches completed-cursor regression before starting runtime', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['1:snapshot'] = () => {
    throw new Error('stop_before_second');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  h.state.certificates[0] = 'SEALED';
  await assert.rejects(h.finish('partial'), /source_abandonment_session_refused/);
  assert.equal(h.state.events.includes('startBoundRuntime'), false);
  assert.equal(h.state.running, false);
});
test('backlog-only smoke retains running fleet without claiming strict readiness or whole-fleet recovery', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  h.state.faults.strictSmokes = (bindings) => ({
    ...h.operations.strictSmokes(bindings),
    ingressReady: false,
    adminReady: false,
    queueBacklogOnly: true,
    actionableLagSeconds: 1000,
  });
  const outcome = await h.apply();
  assert.equal(outcome.phase, 'COMPLETE');
  assert.equal(outcome.fleetReady, false);
  assert.equal(outcome.fleetRecoveryProven, false);
  assert.equal(h.state.running, true);
});
test('failed post-resume smoke stops first and recovery rereads children without reinstalling', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  h.state.faults.strictSmokes = () => {
    throw new Error('database_down');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  const failure = h.state.events.lastIndexOf('strictSmokes');
  assert.deepEqual(h.state.events.slice(failure + 1, failure + 4), [
    'stopRuntime',
    'removeStoreClients',
    'pauseQueues',
  ]);
  assert.equal(h.state.running, false);
  assert.equal(h.store.read().journal.phase, 'RESUMING');
  delete h.state.faults.strictSmokes;
  assert.equal((await h.finish('complete')).phase, 'COMPLETE');
  assert.deepEqual(h.state.calls, [1]);
  assert.equal(h.state.running, true);
});
test('auxiliary restoration failure cannot create terminal success and retains original baseline', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  h.state.faults.restoreAuxiliaryQueues = () =>
    h.parent({ restored: false, queueBaselineDigest: digest(h.queueBaseline) });
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  assert.equal(h.state.running, false);
  assert.equal(h.state.events.includes('strictSmokes'), false);
  assert.deepEqual(
    h.store.readEvidence(h.store.read().journal.proofs.hostAdmission).queueBaseline,
    h.queueBaseline,
  );
});
test('stale caller digest cannot start a child or alter runtime', async (t) => {
  const h = fixture(t);
  const prepared = await h.prepare();
  const before = h.state.events.length;
  await assert.rejects(
    applySourceAbandonmentSession({
      store: h.store,
      adapters: h.adapters,
      expectedJournalDigest: '0'.repeat(64),
    }),
    /expected_journal/,
  );
  assert.equal(h.state.events.length, before);
  assert.equal(h.store.read().digest, prepared.journalDigest);
});
test('independent preview review cannot admit changed authorities or unknown descendants', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  h.state.faults.reviewPendingInventory = (child, pending) => ({
    ...h.operations.reviewPendingInventory(child, pending),
    descendantsComplete: false,
  });
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  assert.deepEqual(h.state.calls, [0]);
  assert.equal(h.store.childStore(0).read().child.phase, 'PENDING');
});
test('startup time reserve stops fresh work but permits a positive partial finish', async (t) => {
  const h = fixture(t);
  await h.prepare();
  h.state.childFaults['1:snapshot'] = () => {
    h.state.now += limits.durationMs;
    throw new Error('duration_expired');
  };
  await assert.rejects(h.apply(), /source_abandonment_session_refused/);
  const outcome = await h.finish('partial');
  assert.equal(outcome.phase, 'PARTIAL_COMPLETE');
  assert.deepEqual(h.state.calls, [1, 0]);
});

test('another admitted session is refused before any runtime or queue operation', async (t) => {
  const h = fixture(t);
  await h.prepare();
  const before = h.state.events.length;
  await assert.rejects(h.prepare(), /session_already_admitted/);
  assert.equal(h.state.events.length, before);
});
test('lost terminal journal acknowledgement is resolved by exact readback without stopping again', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  const proxy = {
    ...h.store,
    finish(...args) {
      h.store.finish(...args);
      throw new Error('ack_lost');
    },
  };
  const outcome = await applySourceAbandonmentSession({
    store: proxy,
    adapters: h.adapters,
    expectedJournalDigest: h.store.read().digest,
    now: () => h.state.now,
  });
  assert.equal(outcome.phase, 'COMPLETE');
  assert.equal(h.state.running, true);
  assert.equal(h.state.events.filter((event) => event === 'stopRuntime').length, 1);
});
test('unconfirmed final journal preserves the already proved runtime and reports uncertainty', async (t) => {
  const h = fixture(t, 1);
  await h.prepare();
  const proxy = {
    ...h.store,
    finish() {
      throw new Error('journal_write_failed');
    },
  };
  await assert.rejects(
    applySourceAbandonmentSession({
      store: proxy,
      adapters: h.adapters,
      expectedJournalDigest: h.store.read().digest,
      now: () => h.state.now,
    }),
    (error) =>
      error.message === 'session_final_journal_unconfirmed' && error.finalJournalUncertain === true,
  );
  assert.equal(h.state.running, true);
  assert.equal(h.store.read().journal.phase, 'RESUMING');
  assert.throws(() => assertNoActiveSourceAbandonmentSession(h.directory));
  assert.equal(h.state.events.filter((event) => event === 'stopRuntime').length, 1);
});

function enableFreshBatch(h, mutate = () => {}) {
  h.adapters.readFreshMaterializedChildren = async (children) => {
    h.state.events.push('aggregateReadbackBatch');
    const readbacks = [];
    for (const child of children) {
      const childStore = h.store.childStore(child.childIndex);
      const adapter = h.adapters.createChildAdapters(child.childIndex, childStore, child);
      const pending = childStore.readProof('pendingInventory');
      readbacks.push({
        childIndex: child.childIndex,
        certificateId: child.bindings.certificateId,
        first: await adapter.readSeal(child.bindings, pending),
        second: await adapter.readSeal(child.bindings, pending),
      });
    }
    const output = {
      version: 1,
      kind: 'source_abandonment_session_fresh_readbacks',
      complete: true,
      sessionId: children[0].sessionId,
      manifestDigest: children[0].manifestDigest,
      readbacks,
    };
    mutate(output);
    return output;
  };
}
test('explicit aggregate observations preserve independent child seals and durable batch provenance', async (t) => {
  const h = fixture(t);
  enableFreshBatch(h);
  await h.prepare();
  const result = await h.apply();
  assert.equal(result.phase, 'COMPLETE');
  assert.deepEqual(h.state.calls, [1, 1]);
  assert.equal(h.state.events.filter((event) => event === 'aggregateReadbackBatch').length, 1);
  const journal = h.store.read().journal;
  const aggregate = h.store.readEvidence(journal.proofs.aggregateReadback);
  const batch = h.store.readEvidence(aggregate.batchReadbackProof);
  assert.equal(batch.readbacks.length, 2);
  for (const fresh of aggregate.freshReadbacks)
    assert.equal(
      h.store.readEvidence(fresh.materializedSeal).proof.batchReadbackProof,
      aggregate.batchReadbackProof,
    );
});
for (const issue of ['session', 'scope', 'certificate', 'first', 'second'])
  test(`aggregate ${issue} proof failure keeps runtime stopped without another install`, async (t) => {
    const h = fixture(t);
    enableFreshBatch(h, (output) => {
      if (issue === 'session') output.sessionId = uuid(100);
      if (issue === 'scope') output.readbacks.pop();
      if (issue === 'certificate') output.readbacks[0].certificateId = uuid(100);
      if (issue === 'first') output.readbacks[0].first.reviewedChatCursorsComplete = false;
      if (issue === 'second') output.readbacks[0].second.ownerProofsComplete = false;
    });
    await h.prepare();
    await assert.rejects(h.apply(), /source_abandonment_session_refused/);
    assert.deepEqual(h.state.calls, [1, 1]);
    assert.equal(h.state.running, false);
  });
