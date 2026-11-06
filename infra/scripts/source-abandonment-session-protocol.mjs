import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';
import sessionQueues from './source-abandonment-session-queues.cjs';
import { legacyColdDigest } from './legacy-cold-journal.mjs';
import { canonicalLegacyColdDigest } from './legacy-cold-store-adapter.mjs';
import { runSourceAbandonmentSessionChild } from './source-abandonment-session-child.mjs';
import {
  sourceAbandonmentSessionDigest as digest,
  validateSourceAbandonmentSessionManifest,
  summarizeSourceAbandonmentSession,
} from './source-abandonment-session-journal.mjs';

// FLAG: These are unchanged single-call ceilings from legacy-recovery-live-budget
// and legacy-cold-store-adapter. Reserve them durably before work, including retries.
export const SOURCE_ABANDONMENT_COLLECTOR_RESERVATION = Object.freeze({
  inventoryPages: 512,
  inventoryRows: 10000,
  inventoryProbes: 50000,
  inventoryBytes: 8 * 1024 * 1024,
  materializationPages: 0,
});
export const SOURCE_ABANDONMENT_MATERIALIZATION_RESERVATION = Object.freeze({
  inventoryPages: 0,
  inventoryRows: 0,
  inventoryProbes: 0,
  inventoryBytes: 0,
  materializationPages: 200,
});
const workKeys = Object.keys(SOURCE_ABANDONMENT_COLLECTOR_RESERVATION);
const { isSupportedSourceAbandonmentQueueInventory } = sessionQueues;
const hash = /^[a-f0-9]{64}$/u;
const parentMethods = [
  'inspectRuntime',
  'inspectQueueBaseline',
  'admissionPreview',
  'preDrainRuntime',
  'stopRuntime',
  'readStoppedRuntime',
  'pauseQueues',
  'readQueueFence',
  'snapshotFrozenInventory',
  'removeStoreClients',
  'createChildAdapters',
  'reviewPendingInventory',
  'startBoundRuntime',
  'readRuntimeIdentity',
  'readNativeIdentity',
  'resumeQueues',
  'restoreAuxiliaryQueues',
  'strictSmokes',
];
const requireFact = (fact, code) => {
  if (!fact) throw new Error(code);
};
const proofDigest = (value) => digest(`${JSON.stringify(value)}\n`);
function context(store, adapters) {
  requireFact(
    store &&
      [
        'read',
        'readEvidence',
        'recordProof',
        'seed',
        'beginStopping',
        'recordPreDrain',
        'markStopped',
        'reserveWork',
        'reviewChild',
        'childStore',
        'beginResume',
        'beginAbortResume',
        'reconcileStopped',
        'finish',
        'block',
      ].every((name) => typeof store[name] === 'function') &&
      parentMethods.every((name) => typeof adapters?.[name] === 'function'),
    'session_protocol_context_required',
  );
}
export function sourceAbandonmentSessionRuntimeBindings(manifest) {
  validateSourceAbandonmentSessionManifest(manifest);
  return {
    clusterIdentity: manifest.clusterIdentity,
    epoch: manifest.epoch,
    controllerNonce: manifest.controllerNonce,
    certificateId: manifest.sessionId,
    baselineDigest: manifest.baselineDigest,
    sourceSha: manifest.sourceSha,
    targetSha: manifest.sourceSha,
    targetImageId: manifest.imageId,
    topologyDigest: manifest.topologyDigest,
    selectionDigest: manifest.enumerationDigest,
  };
}
function bound(value, bindings, code) {
  requireFact(
    value?.version === 1 &&
      value.complete === true &&
      value.sourceSha === bindings.targetSha &&
      value.imageId === bindings.targetImageId &&
      value.controllerNonce === bindings.controllerNonce &&
      value.selectionDigest === bindings.selectionDigest,
    code,
  );
  return value;
}
function parentProof(manifest, value) {
  return {
    ...value,
    version: 1,
    complete: true,
    sessionId: manifest.sessionId,
    manifestDigest: digest(manifest),
  };
}
function boundParent(value, manifest, code) {
  requireFact(
    value?.version === 1 &&
      value.complete === true &&
      value.sessionId === manifest.sessionId &&
      value.manifestDigest === digest(manifest),
    code,
  );
  return value;
}
function fence(value, bindings) {
  bound(value, bindings, 'session_fence_binding_unproved');
  requireFact(
    value.queueCount === 24 &&
      value.pausedCount === 24 &&
      value.activeCount === 0 &&
      value.ownerNonce === bindings.controllerNonce,
    'session_fence_unproved',
  );
  return value;
}
function record(store, value) {
  const reference = store.recordProof(value);
  requireFact(reference === proofDigest(value), 'session_proof_persistence_unproved');
  return reference;
}
function current(store, expected, phases) {
  const state = store.read();
  requireFact(
    state.journal &&
      hash.test(expected ?? '') &&
      state.digest === expected &&
      phases.includes(state.journal.phase),
    'session_expected_journal_required',
  );
  return state.journal;
}
function frozenProof(value, manifest) {
  boundParent(value, manifest, 'session_frozen_binding_unproved');
  requireFact(
    value.coverage === 'FROZEN' &&
      value.cutoff === manifest.cutoff &&
      value.sourceSha === manifest.sourceSha &&
      value.imageId === manifest.imageId &&
      value.enumerationComplete === true &&
      value.plannedEnumerationDigest === manifest.enumerationDigest &&
      hash.test(value.frozenEnumerationDigest ?? '') &&
      value.manifestMatches === true &&
      value.unknownAdditions === 0 &&
      value.missingOrChangedAuthorities === 0,
    'session_frozen_inventory_unproved',
  );
  return value;
}
function queueBaselineProof(value, manifest) {
  requireFact(
    value?.version === 1 &&
      value.complete === true &&
      value.registryDigest === manifest.registryDigest &&
      value.ownerAbsent === true &&
      Array.isArray(value.queues) &&
      value.queueCount === value.queues.length &&
      value.queues.every(
        (row) =>
          typeof row.name === 'string' &&
          /^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(row.name) &&
          typeof row.paused === 'boolean',
      ) &&
      isSupportedSourceAbandonmentQueueInventory(value.queues.map((row) => row.name)),
    'session_queue_baseline_unproved',
  );
  return value;
}
function preDrainProof(value, manifest, baseline) {
  boundParent(value, manifest, 'session_predrain_binding_unproved');
  requireFact(
    value.queueCount === baseline.queueCount &&
      value.pausedCount === baseline.queueCount &&
      value.activeCount === 0 &&
      value.queueWorkDrained === true &&
      value.ownerNonce === manifest.controllerNonce,
    'session_predrain_unproved',
  );
  return value;
}
function admissionProof(value, manifest) {
  boundParent(value, manifest, 'session_admission_binding_unproved');
  requireFact(
    value.feasible === true &&
      Number.isSafeInteger(value.estimatedColdMs) &&
      Number.isSafeInteger(value.startupReserveMs) &&
      value.startupReserveMs > 0 &&
      value.estimatedColdMs >= value.startupReserveMs &&
      value.estimatedColdMs <= manifest.budgets.durationMs,
    'session_duration_infeasible',
  );
  const reservation = value.frozenInventoryReservation;
  requireFact(
    reservation &&
      Object.keys(reservation).length === workKeys.length &&
      workKeys.every((key) => Number.isSafeInteger(reservation[key]) && reservation[key] >= 0) &&
      reservation.materializationPages === 0,
    'session_frozen_reservation_required',
  );
  for (const key of workKeys) {
    const required =
      reservation[key] +
      manifest.children.length *
        (2 * SOURCE_ABANDONMENT_COLLECTOR_RESERVATION[key] +
          SOURCE_ABANDONMENT_MATERIALIZATION_RESERVATION[key]);
    requireFact(required <= manifest.budgets[key], 'session_work_plan_infeasible');
  }
  return value;
}
function workWindow(store, now) {
  const journal = store.read().journal;
  const admission = store.readEvidence(journal.proofs.hostAdmission);
  const timestamp = now();
  requireFact(
    Number.isSafeInteger(timestamp) &&
      timestamp <
        Date.parse(journal.coldStartedAt) +
          journal.manifest.budgets.durationMs -
          admission.admission.startupReserveMs,
    'session_work_window_exhausted',
  );
}
function reserve(store, reservation, now) {
  workWindow(store, now);
  store.reserveWork(store.read().digest, reservation);
}
async function contained(store, manifest, adapters) {
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  const proof = {
    runtimeStopped: false,
    clientsRemoved: false,
    queuesPaused: false,
    stoppedReadback: false,
    fenceReadback: false,
  };
  // FLAG: Runtime stops before cleanup or any fence repair after unknown writes or
  // failed startup. Only a later explicit positive finish may start it again.
  for (const [name, field] of [
    ['stopRuntime', 'runtimeStopped'],
    ['removeStoreClients', 'clientsRemoved'],
    ['pauseQueues', 'queuesPaused'],
  ]) {
    try {
      await adapters[name](bindings);
      proof[field] = true;
    } catch {
      /* Retain uncertainty. */
    }
  }
  try {
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    proof.stoppedReadback = true;
  } catch {
    /* Retain uncertainty. */
  }
  try {
    fence(await adapters.readQueueFence(bindings), bindings);
    proof.fenceReadback = true;
  } catch {
    /* Retain uncertainty. */
  }
  try {
    const state = store.read();
    store.block(state.digest, 'session_proof_failed', {
      failureEvidence: record(store, parentProof(manifest, proof)),
    });
  } catch {
    /* A lost durable response never becomes permission to restart. */
  }
  return proof;
}
async function refuse(store, manifest, adapters, cause) {
  const containment = await contained(store, manifest, adapters);
  throw Object.assign(new Error('source_abandonment_session_refused', { cause }), { containment });
}
function result(journal, extra = {}) {
  return {
    ...summarizeSourceAbandonmentSession(journal),
    journalDigest: digest(journal),
    releaseRecorded: false,
    ...extra,
  };
}

// FLAG: All original pause states are durable before the first pause; the full
// frozen traversal must match the admitted finite authority plan before any child.
export async function prepareSourceAbandonmentSession({
  store,
  manifest: rawManifest,
  adapters,
  now = Date.now,
}) {
  context(store, adapters);
  const empty = store.read();
  requireFact(empty.marker === null && empty.journal === null, 'session_already_admitted');
  const manifest = JSON.parse(
    JSON.stringify(validateSourceAbandonmentSessionManifest(rawManifest)),
  );
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  const baseline = bound(
    await adapters.inspectRuntime(bindings),
    bindings,
    'session_baseline_unproved',
  );
  requireFact(
    baseline.compatible === true &&
      baseline.singletonCount === 14 &&
      baseline.nativeCount === 2 &&
      baseline.unreviewedProducers === 0 &&
      legacyColdDigest(baseline) === manifest.baselineDigest,
    'session_baseline_changed',
  );
  const queueBaseline = queueBaselineProof(await adapters.inspectQueueBaseline(manifest), manifest);
  const admission = admissionProof(await adapters.admissionPreview(manifest, baseline), manifest);
  let admitted = false;
  try {
    const hostAdmission = record(
      store,
      parentProof(manifest, { baseline, queueBaseline, admission }),
    );
    const beforeSeed = store.read();
    requireFact(
      beforeSeed.marker === null && beforeSeed.journal === null,
      'session_already_admitted',
    );
    admitted = true;
    store.seed(manifest, hostAdmission);
    store.beginStopping(store.read().digest);
    const drained = preDrainProof(
      await adapters.preDrainRuntime(manifest, queueBaseline),
      manifest,
      queueBaseline,
    );
    store.recordPreDrain(store.read().digest, { preDrainInventory: record(store, drained) });
    await adapters.stopRuntime(bindings);
    await adapters.removeStoreClients(bindings);
    const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    await adapters.pauseQueues(bindings);
    const paused = fence(await adapters.readQueueFence(bindings), bindings);
    reserve(store, admission.frozenInventoryReservation, now);
    const frozen = frozenProof(
      await adapters.snapshotFrozenInventory(manifest, bindings),
      manifest,
    );
    workWindow(store, now);
    await adapters.removeStoreClients(bindings);
    const afterStopped = assertLegacyColdStopped(
      await adapters.readStoppedRuntime(bindings),
      bindings,
    );
    const afterFence = fence(await adapters.readQueueFence(bindings), bindings);
    requireFact(
      legacyColdDigest(stopped) === legacyColdDigest(afterStopped) &&
        legacyColdDigest(paused) === legacyColdDigest(afterFence),
      'session_freeze_runtime_changed',
    );
    const journal = store.markStopped(store.read().digest, {
      stoppedInventory: record(store, parentProof(manifest, afterStopped)),
      queueFence: record(store, parentProof(manifest, afterFence)),
      frozenInventory: record(store, frozen),
    });
    return result(journal, { prepared: true, runtimeStarted: false });
  } catch (cause) {
    if (admitted) return refuse(store, manifest, adapters, cause);
    throw cause;
  }
}
function checkPending(pending, child, manifest) {
  bound(pending, child.bindings, 'session_pending_binding_unproved');
  const inventory = pending.inventory;
  const definition = manifest.children[child.childIndex];
  requireFact(
    pending.unknownSources === 0 &&
      pending.saturated === false &&
      hash.test(pending.previewDigest ?? '') &&
      hash.test(pending.inventoryDigest ?? '') &&
      pending.inventoryArtifactSha256 === proofDigest(inventory) &&
      inventory?.version === 1 &&
      inventory.operation === 'inventory_preview' &&
      inventory.applied === false &&
      inventory.activationAuthorized === false &&
      inventory.decision === 'READY_TO_INSTALL' &&
      inventory.registrySha256 === manifest.registryDigest &&
      inventory.selectionSha256 === canonicalLegacyColdDigest(child.selection) &&
      Array.isArray(inventory.issues) &&
      inventory.issues.length === 0 &&
      Array.isArray(inventory.children) &&
      Array.isArray(inventory.selectedOwners) &&
      inventory.selectedOwners.length === definition.authorities.length &&
      definition.authorities.every(
        (authority) =>
          inventory.selectedOwners.filter(
            (row) =>
              row.ownerWebhookEventId === authority.ownerId &&
              row.claimId === authority.claimId &&
              row.semanticKey === authority.semanticKey &&
              row.chatId === authority.chatId &&
              row.messageId === authority.messageId,
          ).length === 1,
      ),
    'session_pending_authorities_unproved',
  );
}
async function childAdapters(store, adapters, index, now) {
  const childStore = store.childStore(index);
  const child = childStore.read().child;
  const actual = await adapters.createChildAdapters(index, childStore, child);
  const wrapped = { ...actual };
  for (const [name, reservation] of [
    ['snapshotPending', SOURCE_ABANDONMENT_COLLECTOR_RESERVATION],
    ['materializeReceipts', SOURCE_ABANDONMENT_MATERIALIZATION_RESERVATION],
  ]) {
    requireFact(typeof actual?.[name] === 'function', 'session_child_adapter_required');
    wrapped[name] = async (...args) => {
      reserve(store, reservation, now);
      return actual[name](...args);
    };
  }
  const install = actual?.installDispositions;
  requireFact(typeof install === 'function', 'session_child_adapter_required');
  wrapped.installDispositions = async (...args) => {
    workWindow(store, now);
    return install.apply(actual, args);
  };
  return { childStore, adapters: wrapped };
}
async function reviewedChild(store, adapters, index, now) {
  const instance = await childAdapters(store, adapters, index, now);
  const child = instance.childStore.read().child;
  if (child.phase === 'PENDING') {
    const manifest = store.read().journal.manifest;
    await instance.adapters.removeStoreClient(child.bindings);
    const pending = await instance.adapters.snapshotPending(child.bindings);
    checkPending(pending, child, manifest);
    const review = await adapters.reviewPendingInventory(child, pending, manifest);
    requireFact(
      review?.version === 1 &&
        review.previewDigest === pending.previewDigest &&
        review.inventoryDigest === pending.inventoryDigest &&
        review.selectionDigest === child.bindings.selectionDigest &&
        review.admissionDigest === manifest.children[index].admissionDigest &&
        review.sourceSelectionComplete === true &&
        review.descendantsComplete === true,
      'session_independent_review_unproved',
    );
    await instance.adapters.removeStoreClient(child.bindings);
    store.reviewChild(store.read().digest, index, {
      pendingInventory: record(store, pending),
      reviewedPreview: record(store, review),
    });
  }
  return instance;
}
export async function applySourceAbandonmentSession({
  store,
  adapters,
  expectedJournalDigest,
  now = Date.now,
}) {
  context(store, adapters);
  const initial = current(store, expectedJournalDigest, ['STOPPED', 'PROCESSING']);
  requireFact(
    initial.blockedReason === null &&
      initial.children.every((child) => child.phase !== 'ATTEMPTED'),
    'session_reconcile_required',
  );
  try {
    for (const definition of initial.children) {
      if (definition.phase === 'MATERIALIZED') continue;
      workWindow(store, now);
      const instance = await reviewedChild(store, adapters, definition.childIndex, now);
      const child = instance.childStore.read().child;
      const pending = instance.childStore.readProof('pendingInventory');
      await runSourceAbandonmentSessionChild({
        store: instance.childStore,
        adapters: instance.adapters,
        expectedChildDigest: digest(child),
        reviewedPreviewDigest: pending.previewDigest,
        reviewedInventoryDigest: pending.inventoryDigest,
      });
    }
  } catch (cause) {
    return refuse(store, initial.manifest, adapters, cause);
  }
  return finishSourceAbandonmentSession({
    store,
    adapters,
    expectedJournalDigest: store.read().digest,
    mode: 'complete',
    now,
  });
}

// Reconcile exactly the already attempted certificate. Starting another child is
// a separate operation and is never inferred from an uncertain writer response.
export async function reconcileSourceAbandonmentSession({
  store,
  adapters,
  expectedJournalDigest,
  now = Date.now,
}) {
  context(store, adapters);
  const initial = current(store, expectedJournalDigest, ['PROCESSING']);
  const attempted = initial.children.filter((child) => child.phase === 'ATTEMPTED');
  requireFact(attempted.length === 1, 'session_attempted_child_required');
  try {
    const bindings = sourceAbandonmentSessionRuntimeBindings(initial.manifest);
    await adapters.stopRuntime(bindings);
    await adapters.removeStoreClients(bindings);
    await adapters.pauseQueues(bindings);
    assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
    fence(await adapters.readQueueFence(bindings), bindings);
    const instance = await childAdapters(store, adapters, attempted[0].childIndex, now);
    const pending = instance.childStore.readProof('pendingInventory');
    await runSourceAbandonmentSessionChild({
      store: instance.childStore,
      adapters: instance.adapters,
      expectedChildDigest: digest(instance.childStore.read().child),
      reviewedPreviewDigest: pending.previewDigest,
      reviewedInventoryDigest: pending.inventoryDigest,
      reconcile: true,
    });
    return result(store.read().journal, { reconciled: true, runtimeStarted: false });
  } catch (cause) {
    return refuse(store, initial.manifest, adapters, cause);
  }
}
function finishShape(journal, mode) {
  requireFact(['complete', 'partial', 'abort'].includes(mode), 'session_finish_mode_required');
  requireFact(
    journal.children.every((child) =>
      ['PENDING', 'REVIEWED', 'MATERIALIZED'].includes(child.phase),
    ),
    'session_unresolved_child',
  );
  const completed = journal.children.filter((child) => child.phase === 'MATERIALIZED').length;
  requireFact(
    mode === 'complete'
      ? completed === journal.children.length
      : mode === 'partial'
        ? completed > 0 && completed < journal.children.length
        : completed === 0 && journal.children.every((child) => !child.proofs.attemptEvidence),
    'session_finish_scope_unproved',
  );
}
async function stoppedProofs(store, adapters, manifest) {
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  await adapters.removeStoreClients(bindings);
  const stopped = assertLegacyColdStopped(await adapters.readStoppedRuntime(bindings), bindings);
  const paused = fence(await adapters.readQueueFence(bindings), bindings);
  await adapters.removeStoreClients(bindings);
  return {
    stoppedInventory: record(store, parentProof(manifest, stopped)),
    queueFence: record(store, parentProof(manifest, paused)),
    clientRemoval: record(store, parentProof(manifest, { clientCount: 0 })),
  };
}

// FLAG: Complete/partial/abort are explicit, different terminal outcomes. Every
// attempted child must have a fresh positive readback before the one final start.
export async function finishSourceAbandonmentSession({
  store,
  adapters,
  expectedJournalDigest,
  mode,
  now = Date.now,
}) {
  context(store, adapters);
  let journal = current(store, expectedJournalDigest, [
    'ADMITTED',
    'STOPPING',
    'STOPPED',
    'PROCESSING',
    'RESUMING',
    'ABORT_RESUMING',
  ]);
  finishShape(journal, mode);
  const manifest = journal.manifest;
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  try {
    if (['RESUMING', 'ABORT_RESUMING'].includes(journal.phase)) {
      requireFact(journal.resumeMode === mode, 'session_resume_mode_changed');
      await adapters.stopRuntime(bindings);
      await adapters.removeStoreClients(bindings);
      await adapters.pauseQueues(bindings);
      const proofs = await stoppedProofs(store, adapters, manifest);
      journal = store.reconcileStopped(store.read().digest, proofs);
    } else if (mode === 'abort' && ['ADMITTED', 'STOPPING'].includes(journal.phase)) {
      await adapters.stopRuntime(bindings);
      await adapters.removeStoreClients(bindings);
      await adapters.pauseQueues(bindings);
    }
    let proofs = await stoppedProofs(store, adapters, manifest);
    const materializedChildren = journal.children.filter((entry) => entry.phase === 'MATERIALIZED');
    let batchedReadbacks = null;
    let batchReadbackProof = null;
    if (
      materializedChildren.length &&
      typeof adapters.readFreshMaterializedChildren === 'function'
    ) {
      batchedReadbacks = boundParent(
        await adapters.readFreshMaterializedChildren(materializedChildren),
        manifest,
        'session_fresh_batch_binding_unproved',
      );
      requireFact(
        batchedReadbacks.kind === 'source_abandonment_session_fresh_readbacks' &&
          Array.isArray(batchedReadbacks.readbacks) &&
          batchedReadbacks.readbacks.length === materializedChildren.length &&
          batchedReadbacks.readbacks.every(
            (row, index) =>
              row.childIndex === materializedChildren[index].childIndex &&
              row.certificateId === materializedChildren[index].bindings.certificateId,
          ),
        'session_fresh_batch_scope_unproved',
      );
      batchReadbackProof = record(store, batchedReadbacks);
      await stoppedProofs(store, adapters, manifest);
    }
    const freshReadbacks = [];
    for (const [ordinal, child] of materializedChildren.entries()) {
      const instance = await childAdapters(store, adapters, child.childIndex, now);
      const pending = instance.childStore.readProof('pendingInventory');
      let readCount = 0;
      // FLAG: An explicit pair of fresh aggregate observations is usable only for
      // already MATERIALIZED children, after both read-only clients were removed.
      // The ordinary child proof validator still checks every bound seal; writes
      // and fresh inventories are prohibited throughout this proof-only path.
      const validatedAdapters = batchedReadbacks
        ? {
            ...instance.adapters,
            readSeal: () => {
              requireFact(readCount < 2, 'session_fresh_batch_exhausted');
              const row = batchedReadbacks.readbacks[ordinal];
              return { ...(readCount++ === 0 ? row.first : row.second), batchReadbackProof };
            },
            installDispositions: () => {
              throw new Error('session_fresh_batch_write_refused');
            },
            materializeReceipts: () => {
              throw new Error('session_fresh_batch_write_refused');
            },
            snapshotPending: () => {
              throw new Error('session_fresh_batch_inventory_refused');
            },
          }
        : instance.adapters;
      const readback = await runSourceAbandonmentSessionChild({
        store: instance.childStore,
        adapters: validatedAdapters,
        expectedChildDigest: digest(instance.childStore.read().child),
        reviewedPreviewDigest: pending.previewDigest,
        reviewedInventoryDigest: pending.inventoryDigest,
        reconcile: true,
      });
      requireFact(!batchedReadbacks || readCount === 2, 'session_fresh_batch_incomplete');
      freshReadbacks.push({
        childIndex: child.childIndex,
        materializedSeal: readback.evidence.materializedSeal,
      });
    }
    proofs = await stoppedProofs(store, adapters, manifest);
    journal = store.read().journal;
    finishShape(journal, mode);
    if (mode === 'abort') {
      const noAttemptLedger = record(
        store,
        parentProof(manifest, { attemptedCount: 0, childDigests: journal.children.map(digest) }),
      );
      journal = store.beginAbortResume(store.read().digest, { ...proofs, noAttemptLedger });
    } else {
      const materialized = journal.children.filter((child) => child.phase === 'MATERIALIZED');
      const aggregateReadback = record(
        store,
        parentProof(manifest, {
          children: materialized.map((child) => ({
            childIndex: child.childIndex,
            certificateId: child.bindings.certificateId,
            childDigest: digest(child),
            materializedSeal: child.proofs.materializedSeal,
          })),
          freshReadbacks,
          ...(batchReadbackProof ? { batchReadbackProof } : {}),
          unattemptedCount: journal.children.length - materialized.length,
        }),
      );
      journal = store.beginResume(
        store.read().digest,
        { ...proofs, aggregateReadback },
        mode === 'partial',
      );
    }
    // The actual stock adapter starts both native generations and proves health
    // before starting the exact fourteen API generations. No replacement is built.
    await adapters.startBoundRuntime(bindings);
    const runtime = bound(
      await adapters.readRuntimeIdentity(bindings),
      bindings,
      'session_runtime_identity_unproved',
    );
    const native = bound(
      await adapters.readNativeIdentity(bindings),
      bindings,
      'session_native_identity_unproved',
    );
    requireFact(
      runtime.exactGenerationCount === 14 &&
        runtime.unreviewedProducers === 0 &&
        native.exactGenerationCount === 2,
      'session_restarted_identity_unproved',
    );
    await adapters.resumeQueues(bindings);
    const baseline = store.readEvidence(journal.proofs.hostAdmission).queueBaseline;
    const restored = boundParent(
      await adapters.restoreAuxiliaryQueues(manifest, baseline),
      manifest,
      'session_auxiliary_restore_binding_unproved',
    );
    requireFact(
      restored.restored === true && restored.queueBaselineDigest === digest(baseline),
      'session_auxiliary_restore_unproved',
    );
    const smokes = bound(
      await adapters.strictSmokes(bindings),
      bindings,
      'session_smokes_binding_unproved',
    );
    const fleetReady =
      smokes.ingressReady === true &&
      smokes.adminReady === true &&
      smokes.actionableLagSeconds <= 10;
    requireFact(
      smokes.queuesResumed === true &&
        Number.isFinite(smokes.actionableLagSeconds) &&
        smokes.actionableLagSeconds >= 0 &&
        (fleetReady || (smokes.dependenciesReady === true && smokes.queueBacklogOnly === true)),
      'session_smokes_unproved',
    );
    const terminalProofs = {
      runtimeIdentity: record(store, parentProof(manifest, runtime)),
      nativeIdentity: record(store, parentProof(manifest, native)),
      strictSmokes: record(store, parentProof(manifest, smokes)),
      auxiliaryRestoration: record(store, restored),
    };
    let complete;
    try {
      complete = store.finish(store.read().digest, terminalProofs);
    } catch (cause) {
      // FLAG: All certificate/readiness proofs are already positive. A lost final
      // journal acknowledgement must never stop a fleet beside a terminal guard.
      // Read the same journal once; never replay finish or mutate runtime here.
      let confirmed;
      try {
        confirmed = store.read().journal;
      } catch {
        /* Keep final acknowledgement unknown. */
      }
      const expectedPhase = { complete: 'COMPLETE', partial: 'PARTIAL_COMPLETE', abort: 'ABORTED' }[
        mode
      ];
      if (
        confirmed?.phase === expectedPhase &&
        confirmed.manifestDigest === digest(manifest) &&
        Object.entries(terminalProofs).every(([key, value]) => confirmed.proofs[key] === value)
      )
        complete = confirmed;
      else
        throw Object.assign(new Error('session_final_journal_unconfirmed', { cause }), {
          runtimeAlreadyProven: true,
          runtimeStarted: true,
          queuesResumed: true,
          finalJournalUncertain: true,
        });
    }
    return result(complete, { fleetReady, runtimeStarted: true, queuesResumed: true });
  } catch (cause) {
    if (cause?.finalJournalUncertain === true) throw cause;
    return refuse(store, manifest, adapters, cause);
  }
}
