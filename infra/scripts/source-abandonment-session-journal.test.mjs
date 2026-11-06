import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoActiveSourceAbandonmentSession,
  createSourceAbandonmentSessionStore,
  SOURCE_ABANDONMENT_SESSION_JOURNAL as journalName,
  SOURCE_ABANDONMENT_SESSION_MARKER as markerName,
  SOURCE_ABANDONMENT_SESSION_LIMITS as limits,
  sourceAbandonmentSessionDigest as digest,
  summarizeSourceAbandonmentSession,
  validateSourceAbandonmentSessionManifest,
} from './source-abandonment-session-journal.mjs';
import { runSourceAbandonmentSessionChild } from './source-abandonment-session-child.mjs';

const hash = 'a'.repeat(64);
const canonical = (item) =>
  Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(
          Object.entries(item)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : item;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const names = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
];
const cold = (name) => ({
  serviceName: name,
  stopped: true,
  exactGeneration: true,
  restartPolicy: 'unless-stopped',
});
const stopped = {
  unreviewedProducers: 0,
  services: names.map(cold),
  auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map(cold),
};
const manifest = (children = 2) => ({
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
  enumerationDigest: hash,
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
  children: Array.from({ length: children }, (_, index) => {
    const selection = {
      ownerWebhookEventIds: [`owner_${index}`],
      majorBotIds: ['bot'],
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
          ownerId: `owner_${index}`,
          claimId: `claim_${index}`,
          semanticKey: `semantic_${index}`,
          chatId: '-chat',
          messageId: `message_${index}`,
        },
      ],
    };
  }),
});
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-session-journal-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let currentTime = '2026-10-09T16:20:00.000Z',
    crash = null,
    lockCalls = 0;
  const store = createSourceAbandonmentSessionStore({
    directory,
    assertLock: () => {
      lockCalls++;
    },
    now: () => currentTime,
    onDurableStep: (step) => {
      if (crash?.(step)) throw new Error('injected_crash');
    },
  });
  const plan = manifest(options.children ?? 2);
  if (options.adjust) options.adjust(plan);
  for (const definition of plan.children)
    definition.admissionDigest = store.recordProof({
      version: 1,
      operation: 'admission_preview',
      applied: false,
      activationAuthorized: false,
      stoppingAuthorized: false,
      sourceSha: plan.sourceSha,
      imageId: plan.imageId,
      selectionSha256: digest(canonical(definition.selection)),
      publisherCatalogSha256: plan.botCatalogDigest,
      registrySha256: plan.registryDigest,
      decision: 'READY_FOR_COLD_REVIEW',
      sourceCoverageComplete: true,
      issues: [],
      selectedOwners: definition.authorities.map(({ ownerId, ...row }) => ({
        ownerWebhookEventId: ownerId,
        ...row,
      })),
    });
  const parent = (fields) => ({
    version: 1,
    complete: true,
    sessionId: plan.sessionId,
    manifestDigest: digest(plan),
    ...fields,
  });
  const proof = (fields) => store.recordProof(parent(fields));
  const queueBaseline = {
    version: 1,
    complete: true,
    registryDigest: plan.registryDigest,
    queueCount: options.legacyQueues ? 53 : 54,
    ownerAbsent: true,
    queues: Array.from({ length: 53 }, (_, index) => ({
      name: `queue_${index}`,
      paused: index % 3 === 0,
    })),
  };
  if (!options.legacyQueues)
    queueBaseline.queues.push({ name: 'admin-manual-commands', paused: true });
  if (options.adjustQueueBaseline) options.adjustQueueBaseline(queueBaseline);
  const admission = proof({ admission: true, queueBaseline });
  const seed = () => store.seed(plan, admission);
  if (options.seed !== false) seed();
  const paused = {
    queueCount: 24,
    pausedCount: 24,
    activeCount: 0,
    ownerNonce: plan.controllerNonce,
  };
  const stopProofs = () => ({
    stoppedInventory: proof(stopped),
    queueFence: proof(paused),
    frozenInventory: proof({
      coverage: 'FROZEN',
      cutoff: plan.cutoff,
      sourceSha: plan.sourceSha,
      imageId: plan.imageId,
      enumerationComplete: true,
      plannedEnumerationDigest: plan.enumerationDigest,
      frozenEnumerationDigest: hash,
      manifestMatches: true,
      unknownAdditions: 0,
      missingOrChangedAuthorities: 0,
    }),
  });
  const drain = () =>
    store.recordPreDrain(store.read().digest, {
      preDrainInventory: proof({
        queueCount: queueBaseline.queueCount,
        pausedCount: queueBaseline.queueCount,
        activeCount: 0,
        queueWorkDrained: true,
        ownerNonce: plan.controllerNonce,
      }),
    });
  const stop = () => {
    store.beginStopping(store.read().digest);
    drain();
    return store.markStopped(store.read().digest, stopProofs());
  };
  const childBase = (child) => ({
    version: 1,
    complete: true,
    sourceSha: child.bindings.targetSha,
    imageId: child.bindings.targetImageId,
    controllerNonce: child.bindings.controllerNonce,
    selectionDigest: child.bindings.selectionDigest,
  });
  const child = (index) => store.childStore(index).read().child;
  const review = (index) => {
    const current = child(index);
    const pending = {
      ...childBase(current),
      previewDigest: hash,
      inventoryDigest: 'c'.repeat(64),
      inventoryArtifactSha256: 'd'.repeat(64),
      unknownSources: 0,
      saturated: false,
      inventory: {
        binding: {
          maintenanceId: plan.controllerNonce,
          queueFenceNonce: digest(plan.controllerNonce),
          sourceSha: plan.sourceSha,
          imageId: plan.imageId,
          transitionJournalSha256: digest(current),
        },
        selectedOwners: plan.children[index].authorities.map((row) => ({
          ownerWebhookEventId: row.ownerId,
          chatId: row.chatId,
        })),
      },
    };
    const pendingInventory = store.recordProof(pending),
      reviewedPreview = store.recordProof({
        version: 1,
        selectionDigest: current.bindings.selectionDigest,
        previewDigest: pending.previewDigest,
        inventoryDigest: pending.inventoryDigest,
      });
    store.reviewChild(store.read().digest, index, { pendingInventory, reviewedPreview });
    return pending;
  };
  const identity = (current) => ({
    version: current.version,
    kind: current.kind,
    sessionId: current.sessionId,
    manifestDigest: current.manifestDigest,
    childIndex: current.childIndex,
    bindings: current.bindings,
    selection: current.selection,
  });
  const envelope = (current, kind, fields) => ({
    version: 1,
    kind: `source_abandonment_child_${kind}`,
    childBindingDigest: digest(identity(current)),
    certificateId: current.bindings.certificateId,
    proof: fields,
  });
  const attempt = (index) => {
    const current = child(index);
    const attemptEvidence = store.recordProof(
      envelope(current, 'attempt', {
        beforeChildDigest: digest(current),
        pendingInventory: current.proofs.pendingInventory,
        reviewedPreview: current.proofs.reviewedPreview,
      }),
    );
    return store.childStore(index).markAttempted(digest(current), { attemptEvidence });
  };
  const finishChild = (index) => {
    const current = child(index),
      pending = store.childStore(index).readProof('pendingInventory');
    const sealed = {
      ...childBase(current),
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      permanentHoldsComplete: true,
      ownerProofsComplete: true,
      reviewedChatCursorsComplete: true,
    };
    const fields = {
      installedSeal: ['installed_seal', sealed],
      materializedSeal: ['materialized_seal', sealed],
      stoppedInventory: ['stopped', { ...childBase(current), ...stopped }],
      queueFence: ['fence', { ...childBase(current), ...paused }],
      clientRemoval: ['client_removal', { complete: true }],
    };
    const proofs = Object.fromEntries(
      Object.entries(fields).map(([key, [kind, value]]) => [
        key,
        store.recordProof(envelope(current, kind, value)),
      ]),
    );
    return store.childStore(index).markMaterialized(digest(current), proofs);
  };
  const resumeProofs = () => {
    const rows = store.read().journal.children.filter((row) => row.phase === 'MATERIALIZED');
    return {
      aggregateReadback: proof({
        children: rows.map((row) => ({
          childIndex: row.childIndex,
          certificateId: row.bindings.certificateId,
          childDigest: digest(row),
          materializedSeal: row.proofs.materializedSeal,
        })),
        freshReadbacks: rows.map((row) => ({
          childIndex: row.childIndex,
          materializedSeal: row.proofs.materializedSeal,
        })),
        unattemptedCount: plan.children.length - rows.length,
      }),
      stoppedInventory: proof(stopped),
      queueFence: proof(paused),
      clientRemoval: proof({ clientCount: 0 }),
    };
  };
  const abortProofs = () => ({
    noAttemptLedger: proof({
      attemptedCount: 0,
      childDigests: store.read().journal.children.map(digest),
    }),
    stoppedInventory: proof(stopped),
    queueFence: proof(paused),
    clientRemoval: proof({ clientCount: 0 }),
  });
  const finishProofs = (lag = 0) => ({
    runtimeIdentity: proof({ exactGenerationCount: 14, unreviewedProducers: 0 }),
    auxiliaryRestoration: proof({ restored: true, queueBaselineDigest: digest(queueBaseline) }),
    nativeIdentity: proof({ exactGenerationCount: 2 }),
    strictSmokes: proof({
      queuesResumed: true,
      ingressReady: lag <= 10,
      adminReady: lag <= 10,
      dependenciesReady: true,
      queueBacklogOnly: lag > 10,
      actionableLagSeconds: lag,
    }),
  });
  return {
    directory,
    store,
    plan,
    parent,
    proof,
    admission,
    queueBaseline,
    seed,
    stop,
    drain,
    child,
    childBase,
    review,
    attempt,
    finishChild,
    resumeProofs,
    abortProofs,
    finishProofs,
    stopProofs,
    paused,
    setCrash: (fn) => {
      crash = fn;
    },
    setTime: (value) => {
      currentTime = value;
    },
    lockCalls: () => lockCalls,
  };
}

test('manifest binds a complete finite plan without truncating children or owners', () => {
  assert.equal(
    validateSourceAbandonmentSessionManifest(manifest(limits.children)).children.length,
    limits.children,
  );
  for (const change of [
    (p) => {
      p.children = [];
    },
    (p) => {
      p.children = manifest(limits.children + 1).children;
    },
    (p) => {
      p.enumerationComplete = false;
    },
    (p) => {
      p.cutoff = '2026-02-30T00:00:00.000Z';
    },
    (p) => {
      p.sourceSha = 'main';
    },
    (p) => {
      p.imageId = 'api:latest';
    },
    (p) => {
      p.extra = true;
    },
    (p) => {
      p.budgets.durationMs = limits.durationMs + 1;
    },
    (p) => {
      p.children[0].selection.ownerWebhookEventIds = Array.from(
        { length: 9 },
        (_, i) => `owner_${i}`,
      );
    },
    (p) => {
      p.children[0].selectionDigest = 'f'.repeat(64);
    },
    (p) => {
      p.children[1].selection.majorBotIds = ['other'];
      p.children[1].selectionDigest = digest(p.children[1].selection);
    },
  ]) {
    const changed = manifest();
    change(changed);
    assert.throws(() => validateSourceAbandonmentSessionManifest(changed));
  }
});
for (const minutes of [60, 75, 90]) {
  test(`manifest accepts an explicit ${minutes}-minute cold budget without changing it`, () => {
    const plan = manifest();
    plan.budgets.durationMs = minutes * 60 * 1000;
    const before = JSON.stringify(plan);
    assert.equal(
      validateSourceAbandonmentSessionManifest(plan).budgets.durationMs,
      minutes * 60 * 1000,
    );
    assert.equal(JSON.stringify(plan), before);
  });
}
test('cold duration ceiling stays finite without increasing child, owner or admission limits', () => {
  assert.equal(limits.durationMs, 90 * 60 * 1000);
  assert.equal(limits.children, 32);
  assert.equal(limits.ownersPerChild, 8);
  assert.equal(limits.admissionCalls, 480);
  const tooLong = manifest();
  tooLong.budgets.durationMs = 90 * 60 * 1000 + 1;
  assert.throws(() => validateSourceAbandonmentSessionManifest(tooLong));
  assert.equal(validateSourceAbandonmentSessionManifest(manifest(32)).children.length, 32);
  assert.throws(() => validateSourceAbandonmentSessionManifest(manifest(33)));
  for (const owners of [8, 9]) {
    const plan = manifest(1);
    const child = plan.children[0];
    child.authorities = Array.from({ length: owners }, (_, index) => ({
      ownerId: `owner_${index}`,
      claimId: `claim_${index}`,
      semanticKey: `semantic_${index}`,
      chatId: '-chat',
      messageId: `message_${index}`,
    }));
    child.selection.ownerWebhookEventIds = child.authorities.map((row) => row.ownerId);
    child.selectionDigest = digest(child.selection);
    if (owners === 8)
      assert.equal(
        validateSourceAbandonmentSessionManifest(plan).children[0].authorities.length,
        8,
      );
    else assert.throws(() => validateSourceAbandonmentSessionManifest(plan));
  }
});
for (const field of ['certificateId', 'ownerId', 'claimId', 'semanticKey', 'messageId']) {
  test(`manifest rejects cross-child ${field} collision`, () => {
    const changed = manifest();
    if (field === 'certificateId') changed.children[1][field] = changed.children[0][field];
    else {
      changed.children[1].authorities[0][field] = changed.children[0].authorities[0][field];
      if (field === 'ownerId') {
        changed.children[1].selection.ownerWebhookEventIds = ['owner_0'];
        changed.children[1].selectionDigest = digest(changed.children[1].selection);
      }
    }
    assert.throws(() => validateSourceAbandonmentSessionManifest(changed), /collision/u);
  });
}
test('one parent remains active through every child and completes only after positive restart proofs', (t) => {
  const f = fixture(t);
  f.stop();
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
  for (let index = 0; index < 2; index++) {
    f.review(index);
    f.attempt(index);
    f.finishChild(index);
    assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
  }
  f.store.beginResume(f.store.read().digest, f.resumeProofs());
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
  const final = f.store.finish(f.store.read().digest, f.finishProofs());
  assert.equal(assertNoActiveSourceAbandonmentSession(f.directory).journal.phase, 'COMPLETE');
  const report = summarizeSourceAbandonmentSession(final);
  assert.equal(report.materializedOwners, 2);
  assert.equal(report.fleetRecoveryProven, false);
  assert.deepEqual(report.excluded, { rejected: 2, unresolved: 3 });
  assert(f.lockCalls() > 10);
});
test('parent refuses an attempted unknown child even when all other children materialized', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.finishChild(0);
  f.review(1);
  f.attempt(1);
  assert.throws(() => f.store.beginResume(f.store.read().digest, f.resumeProofs(), true));
  assert.throws(() => f.store.beginAbortResume(f.store.read().digest, f.abortProofs()));
  assert.equal(f.child(1).phase, 'ATTEMPTED');
});
test('partial completion preserves untouched remainder and accepts stock backlog-only dependency smoke', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.finishChild(0);
  assert.throws(() => f.store.beginResume(f.store.read().digest, f.resumeProofs(), false));
  f.store.beginResume(f.store.read().digest, f.resumeProofs(), true);
  const final = f.store.finish(f.store.read().digest, f.finishProofs(500));
  assert.equal(
    assertNoActiveSourceAbandonmentSession(f.directory).journal.phase,
    'PARTIAL_COMPLETE',
  );
  const report = summarizeSourceAbandonmentSession(final);
  assert.equal(report.unattemptedOwners, 1);
  assert.equal(report.selectedScopeComplete, false);
  assert.equal(report.fleetRecoveryProven, false);
});
test('zero-attempt abort safely resumes after preview failure without a frozen inventory', (t) => {
  const f = fixture(t);
  f.store.beginStopping(f.store.read().digest);
  f.store.block(f.store.read().digest, 'session_proof_failed');
  f.store.beginAbortResume(f.store.read().digest, f.abortProofs());
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
  f.store.finish(f.store.read().digest, f.finishProofs(500));
  assert.equal(assertNoActiveSourceAbandonmentSession(f.directory).journal.phase, 'ABORTED');
});
test('unknown marker acknowledgement cannot replay create or replace a selected certificate', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  const reviewed = f.child(0);
  f.attempt(0);
  const childStore = f.store.childStore(0);
  assert.throws(
    () =>
      childStore.markAttempted(digest(reviewed), {
        attemptEvidence: f.child(0).proofs.attemptEvidence,
      }),
    /cas/u,
  );
  assert.throws(() =>
    childStore.markAttempted(digest(f.child(0)), {
      attemptEvidence: f.child(0).proofs.attemptEvidence,
    }),
  );
  assert.throws(() =>
    f.store.reviewChild(f.store.read().digest, 0, {
      pendingInventory: reviewed.proofs.pendingInventory,
      reviewedPreview: reviewed.proofs.reviewedPreview,
    }),
  );
  assert.throws(() => f.seed(), /already_admitted/u);
  assert.equal(f.child(0).bindings.certificateId, reviewed.bindings.certificateId);
});
test('stale CAS and out-of-order child operations preserve every accepted byte', (t) => {
  const f = fixture(t),
    initial = f.store.read();
  f.stop();
  assert.throws(() => f.store.beginStopping(initial.digest), /cas/u);
  assert.throws(() => f.review(1));
  assert.equal(f.child(1).phase, 'PENDING');
  f.review(0);
  f.attempt(0);
  const before = readFileSync(join(f.directory, journalName));
  assert.throws(() => f.store.childStore(0).markMaterialized(digest(f.child(0)), {}));
  assert.deepEqual(readFileSync(join(f.directory, journalName)), before);
});
test('MATERIALIZED child remains immutable on failed later readback while parent blocks', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.finishChild(0);
  const child = f.child(0),
    reference = f.store.recordProof({ version: 1, failure: true });
  f.store.childStore(0).block(digest(child), 'child_proof_failed', { failureEvidence: reference });
  assert.deepEqual(f.child(0), child);
  assert.equal(f.store.read().journal.blockedReason, 'child_proof_failed');
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
});
test('incomplete frozen enumeration and unowned queue fence fail before any child attempt', (t) => {
  const f = fixture(t);
  f.store.beginStopping(f.store.read().digest);
  f.drain();
  const proofs = f.stopProofs();
  const badFrozen = f.store.readEvidence(proofs.frozenInventory);
  badFrozen.unknownAdditions = 1;
  assert.throws(
    () =>
      f.store.markStopped(f.store.read().digest, {
        ...proofs,
        frozenInventory: f.store.recordProof(badFrozen),
      }),
    /frozen/u,
  );
  assert.throws(
    () =>
      f.store.markStopped(f.store.read().digest, {
        ...proofs,
        queueFence: f.proof({ ...f.paused, ownerNonce: uuid(999) }),
      }),
    /fence/u,
  );
  assert.equal(f.store.read().journal.phase, 'STOPPING');
});
test('seal/cursor evidence cannot be copied from another child or reduced to writer success', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.finishChild(0);
  f.review(1);
  f.attempt(1);
  const first = f.child(0);
  const copied = Object.fromEntries(
    ['installedSeal', 'materializedSeal', 'stoppedInventory', 'queueFence', 'clientRemoval'].map(
      (name) => [name, first.proofs[name]],
    ),
  );
  assert.throws(
    () => f.store.childStore(1).markMaterialized(digest(f.child(1)), copied),
    /unbound/u,
  );
  assert.equal(f.child(1).phase, 'ATTEMPTED');
});
test('duration and cumulative reservation limits stop new writes without fabricating completion', (t) => {
  const f = fixture(t, {
    adjust: (p) => {
      p.budgets.inventoryPages = 1;
      p.budgets.durationMs = 1000;
    },
  });
  f.stop();
  const reservation = {
    inventoryPages: 1,
    inventoryRows: 0,
    inventoryProbes: 0,
    inventoryBytes: 0,
    materializationPages: 0,
  };
  f.store.reserveWork(f.store.read().digest, reservation);
  assert.throws(() => f.store.reserveWork(f.store.read().digest, reservation));
  f.setTime('2026-10-09T16:20:01.001Z');
  assert.throws(() => f.review(0), /duration/u);
  assert.equal(f.child(0).phase, 'PENDING');
  // Expiration prevents new work, but a positive zero-write closure may still restore service.
  f.store.beginAbortResume(f.store.read().digest, f.abortProofs());
  f.store.finish(f.store.read().digest, f.finishProofs());
});
test('reloading a retained 60-minute journal never extends its budget to the new 90-minute ceiling', (t) => {
  assert.equal(limits.durationMs, 90 * 60 * 1000);
  const f = fixture(t, {
    adjust: (plan) => {
      plan.budgets.durationMs = 60 * 60 * 1000;
    },
  });
  f.stop();
  const before = f.store.read();
  const journalBytes = readFileSync(join(f.directory, journalName));
  const markerBytes = readFileSync(join(f.directory, markerName));
  const manifestBytes = JSON.stringify(before.journal.manifest);
  assert.equal(before.journal.coldStartedAt, '2026-10-09T16:20:00.000Z');
  f.setTime('2026-10-09T17:20:00.001Z');
  const reloaded = createSourceAbandonmentSessionStore({
    directory: f.directory,
    assertLock: () => {},
    now: () => '2026-10-09T17:20:00.001Z',
  });
  assert.deepEqual(reloaded.read(), before);
  assert.deepEqual(readFileSync(join(f.directory, journalName)), journalBytes);
  assert.throws(
    () =>
      reloaded.reserveWork(before.digest, {
        inventoryPages: 1,
        inventoryRows: 0,
        inventoryProbes: 0,
        inventoryBytes: 0,
        materializationPages: 0,
      }),
    /session_duration_budget/u,
  );
  assert.throws(() => f.review(0), /session_duration_budget/u);
  const after = reloaded.read();
  assert.equal(after.journal.manifest.budgets.durationMs, 60 * 60 * 1000);
  assert.equal(JSON.stringify(after.journal.manifest), manifestBytes);
  assert.equal(after.journal.manifestDigest, before.journal.manifestDigest);
  assert.equal(digest(after.journal.manifest), before.journal.manifestDigest);
  assert.equal(after.journal.coldStartedAt, before.journal.coldStartedAt);
  assert.deepEqual(after, before);
  assert.deepEqual(readFileSync(join(f.directory, journalName)), journalBytes);
  assert.deepEqual(readFileSync(join(f.directory, markerName)), markerBytes);
});
test('actual evidence files use bounded 0600 bytes and never overwrite immutable content', (t) => {
  const f = fixture(t),
    ref = f.store.recordProof({ fixture: 'private' });
  assert.equal(f.store.recordProof({ fixture: 'private' }), ref);
  assert.equal(statSync(join(f.directory, 'evidence')).mode & 0o777, 0o700);
  for (const name of [journalName, markerName])
    assert.equal(statSync(join(f.directory, name)).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'evidence', `${ref}.json`)).mode & 0o777, 0o600);
  assert.throws(() => f.store.recordProof({ text: 'x'.repeat(limits.proofFileBytes) }), /budget/u);
});
for (const stage of [
  'temp_opened',
  'bytes_written',
  'file_fsynced',
  'renamed',
  'directory_fsynced',
]) {
  test(`crash at ${stage} during admission never opens the guard`, (t) => {
    const f = fixture(t, { seed: false });
    f.setCrash((step) => step.file === journalName && step.stage === stage);
    assert.throws(f.seed, /injected_crash/u);
    assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory));
  });
  test(`crash at ${stage} during attempt preserves unknown write fencing`, (t) => {
    const f = fixture(t);
    f.stop();
    f.review(0);
    f.setCrash((step) => step.file === journalName && step.stage === stage);
    assert.throws(() => f.attempt(0), /injected_crash/u);
    assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory));
    if (['renamed', 'directory_fsynced'].includes(stage))
      assert.equal(f.child(0).phase, 'ATTEMPTED');
  });
}
for (const corruption of [
  'missing-journal',
  'wrong-mode',
  'symlink',
  'hardlink',
  'changed-proof',
  'missing-proof',
  'temp-proof',
]) {
  test(`durable read fails closed on ${corruption}`, (t) => {
    const f = fixture(t);
    const path = join(f.directory, journalName);
    const admission = f.store.read().journal.proofs.hostAdmission;
    const proofPath = join(f.directory, 'evidence', `${admission}.json`);
    if (corruption === 'missing-journal') rmSync(path);
    if (corruption === 'wrong-mode') chmodSync(path, 0o644);
    if (corruption === 'symlink') {
      rmSync(path);
      symlinkSync(markerName, path);
    }
    if (corruption === 'hardlink') linkSync(path, join(f.directory, 'journal-copy.json'));
    if (corruption === 'changed-proof') writeFileSync(proofPath, '{}\n');
    if (corruption === 'missing-proof') rmSync(proofPath);
    if (corruption === 'temp-proof')
      writeFileSync(join(f.directory, 'evidence', '.uncertain.tmp'), '{}\n', { mode: 0o600 });
    assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory));
  });
}
test('unsafe directory and missing inherited lock cannot create an admitted session', (t) => {
  const f = fixture(t, { seed: false });
  chmodSync(f.directory, 0o755);
  assert.throws(() => f.store.read(), /private_directory/u);
  chmodSync(f.directory, 0o700);
  const protectedStore = createSourceAbandonmentSessionStore({ directory: f.directory });
  assert.throws(() => protectedStore.recordProof({ value: true }));
  assert.equal(readdirSync(f.directory).includes(markerName), false);
});
test('real child runner records durable ATTEMPTED before install and reconciliation never reinstalls', async (t) => {
  const f = fixture(t, { children: 1 });
  f.stop();
  const pending = f.review(0);
  let installs = 0,
    materializations = 0,
    sealComplete = false;
  const childStore = f.store.childStore(0),
    current = f.child(0);
  const adapters = {
    removeStoreClient: () => {},
    readStoppedRuntime: () => ({ ...f.childBase(current), ...stopped }),
    readQueueFence: () => ({ ...f.childBase(current), ...f.paused }),
    snapshotPending: () => pending,
    installDispositions: () => {
      installs++;
      assert.equal(f.child(0).phase, 'ATTEMPTED');
      throw Object.assign(new Error('unknown'), { outcomeUnknown: true });
    },
    readSeal: () => ({
      ...f.childBase(current),
      previewDigest: pending.previewDigest,
      inventoryDigest: pending.inventoryDigest,
      permanentHoldsComplete: true,
      ownerProofsComplete: true,
      reviewedChatCursorsComplete: sealComplete,
    }),
    materializeReceipts: () => {
      materializations++;
      sealComplete = true;
    },
  };
  const request = {
    store: childStore,
    adapters,
    expectedChildDigest: digest(current),
    reviewedPreviewDigest: pending.previewDigest,
    reviewedInventoryDigest: pending.inventoryDigest,
  };
  const result = await runSourceAbandonmentSessionChild(request);
  assert.equal(result.childMaterialized, true);
  assert.equal(installs, 1);
  assert.equal(materializations, 1);
  await runSourceAbandonmentSessionChild({
    ...request,
    expectedChildDigest: digest(f.child(0)),
    reconcile: true,
  });
  assert.equal(installs, 1);
  assert.equal(materializations, 1);
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
});
for (const changed of [
  { decision: 'DENY' },
  { stoppingAuthorized: true },
  { sourceCoverageComplete: false },
  { sourceSha: 'c'.repeat(40) },
  { imageId: `sha256:${'c'.repeat(64)}` },
  { registrySha256: 'c'.repeat(64) },
  { publisherCatalogSha256: 'c'.repeat(64) },
  { selectionSha256: 'c'.repeat(64) },
  { selectedOwners: [] },
  { issues: ['unresolved'] },
]) {
  test(`seed rejects retained stock admission mismatch ${Object.keys(changed)[0]}`, (t) => {
    const f = fixture(t, { seed: false });
    const original = f.store.readEvidence(f.plan.children[0].admissionDigest);
    f.plan.children[0].admissionDigest = f.store.recordProof({ ...original, ...changed });
    const host = f.store.recordProof({
      ...f.store.readEvidence(f.admission),
      manifestDigest: digest(f.plan),
    });
    assert.throws(() => f.store.seed(f.plan, host), /session_/u);
    assert.equal(f.store.read().journal, null);
  });
}
test('seed cannot refer to an unstored admission or substitute byte-ordered selection hashing', (t) => {
  const f = fixture(t, { seed: false });
  const reference = f.plan.children[0].admissionDigest;
  rmSync(join(f.directory, 'evidence', `${reference}.json`));
  assert.throws(f.seed, /missing_or_changed/u);
  const definition = f.plan.children[0];
  assert.notEqual(digest(definition.selection), digest(canonical(definition.selection)));
});
test('durable queue baseline precedes pausing and all 54 queues must be drained', (t) => {
  const f = fixture(t);
  f.store.beginStopping(f.store.read().digest);
  assert.equal(
    f.store.readEvidence(f.store.read().journal.proofs.hostAdmission).queueBaseline.queueCount,
    54,
  );
  assert.throws(() => f.store.markStopped(f.store.read().digest, f.stopProofs()));
  assert.throws(
    () =>
      f.store.recordPreDrain(f.store.read().digest, {
        preDrainInventory: f.proof({
          queueCount: 24,
          pausedCount: 24,
          activeCount: 0,
          queueWorkDrained: true,
          ownerNonce: f.plan.controllerNonce,
        }),
      }),
    /predrain/u,
  );
  f.drain();
  f.store.markStopped(f.store.read().digest, f.stopProofs());
  assert.equal(f.store.read().journal.phase, 'STOPPED');
});
test('retained 53-queue journal and evidence reopen without byte or digest rewrites', (t) => {
  const f = fixture(t, { legacyQueues: true });
  const journalPath = join(f.directory, journalName);
  const evidencePath = join(f.directory, 'evidence', `${f.admission}.json`);
  const originalJournal = readFileSync(journalPath);
  const originalEvidence = readFileSync(evidencePath);
  const before = f.store.read();
  const reopened = createSourceAbandonmentSessionStore({ directory: f.directory, assertLock() {} });
  const readback = reopened.read();
  assert.equal(readback.digest, before.digest);
  assert.deepEqual(readFileSync(journalPath), originalJournal);
  assert.deepEqual(readFileSync(evidencePath), originalEvidence);
  const baseline = reopened.readEvidence(readback.journal.proofs.hostAdmission).queueBaseline;
  assert.equal(baseline.queueCount, 53);
  assert.deepEqual(baseline, f.queueBaseline);
  assert.equal(
    baseline.queues.some(({ name }) => name === 'admin-manual-commands'),
    false,
  );
  f.stop();
  assert.equal(f.store.read().journal.phase, 'STOPPED');
  assert.deepEqual(readFileSync(evidencePath), originalEvidence);
});
for (const [label, adjustQueueBaseline] of [
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
  test(`journal refuses unsupported queue baseline ${label}`, (t) => {
    const f = fixture(t, { seed: false, adjustQueueBaseline });
    assert.throws(f.seed, /session_/u);
    assert.equal(f.store.read().journal, null);
  });
test('blocked attempted reconciliation reserves bounded materialization without permitting new inventory', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.store.childStore(0).block(digest(f.child(0)), 'child_proof_failed');
  const reservation = {
    inventoryPages: 0,
    inventoryRows: 0,
    inventoryProbes: 0,
    inventoryBytes: 0,
    materializationPages: 200,
  };
  f.store.reserveWork(f.store.read().digest, reservation);
  assert.equal(f.store.read().journal.used.materializationPages, 200);
  assert.throws(
    () => f.store.reserveWork(f.store.read().digest, { ...reservation, inventoryPages: 1 }),
    /blocked/u,
  );
  assert.throws(
    () => f.store.reserveWork(f.store.read().digest, { ...reservation, materializationPages: 201 }),
    /blocked/u,
  );
  f.finishChild(0);
  f.store.beginResume(f.store.read().digest, f.resumeProofs(), true);
  f.store.finish(f.store.read().digest, f.finishProofs());
});
test('frozen scan reservations are durable before the first stopped inventory', (t) => {
  const f = fixture(t);
  f.store.beginStopping(f.store.read().digest);
  f.store.reserveWork(f.store.read().digest, {
    inventoryPages: 3,
    inventoryRows: 200,
    inventoryProbes: 1000,
    inventoryBytes: 10000,
    materializationPages: 0,
  });
  assert.equal(f.store.read().journal.used.inventoryPages, 3);
  assert.equal(f.child(0).phase, 'PENDING');
  assert.throws(() => f.review(0));
});
for (const abort of [false, true]) {
  test(`startup reconciliation preserves attempt ledger for ${abort ? 'abort' : 'partial'} restart`, (t) => {
    const f = fixture(t);
    if (abort) {
      f.store.beginStopping(f.store.read().digest);
      f.store.beginAbortResume(f.store.read().digest, f.abortProofs());
    } else {
      f.stop();
      f.review(0);
      f.attempt(0);
      f.finishChild(0);
      f.store.beginResume(f.store.read().digest, f.resumeProofs(), true);
    }
    const children = f.store.read().journal.children;
    f.store.block(f.store.read().digest, 'session_proof_failed');
    f.store.reconcileStopped(f.store.read().digest, {
      stoppedInventory: f.proof(stopped),
      queueFence: f.proof(f.paused),
      clientRemoval: f.proof({ clientCount: 0 }),
    });
    assert.deepEqual(f.store.read().journal.children, children);
    assert.equal(f.store.read().journal.phase, abort ? 'STOPPING' : 'PROCESSING');
    assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /active/u);
    if (abort) f.store.beginAbortResume(f.store.read().digest, f.abortProofs());
    else f.store.beginResume(f.store.read().digest, f.resumeProofs(), true);
    f.store.finish(f.store.read().digest, f.finishProofs(500));
  });
}
test('auxiliary restoration must prove the exact original pause baseline before terminal completion', (t) => {
  const f = fixture(t);
  f.store.beginStopping(f.store.read().digest);
  f.store.beginAbortResume(f.store.read().digest, f.abortProofs());
  const proofs = f.finishProofs();
  assert.throws(
    () =>
      f.store.finish(f.store.read().digest, {
        ...proofs,
        auxiliaryRestoration: f.proof({ restored: true, queueBaselineDigest: 'c'.repeat(64) }),
      }),
    /restore/u,
  );
  assert.equal(f.store.read().journal.phase, 'ABORT_RESUMING');
  f.store.finish(f.store.read().digest, proofs);
});
test('proof byte budget includes pre-admission and orphan evidence instead of only referenced files', (t) => {
  const f = fixture(t, { seed: false });
  f.plan.budgets.proofBytes = 100;
  const host = f.store.recordProof({
    ...f.store.readEvidence(f.admission),
    manifestDigest: digest(f.plan),
  });
  assert.throws(() => f.store.seed(f.plan, host), /proof_budget/u);
  assert.equal(f.store.read().journal, null);
});
test('aggregate requires every fresh seal and durable terminal read retains that fresh evidence', (t) => {
  const f = fixture(t);
  f.stop();
  f.review(0);
  f.attempt(0);
  f.finishChild(0);
  const proofs = f.resumeProofs();
  const aggregate = f.store.readEvidence(proofs.aggregateReadback);
  const omitted = structuredClone(aggregate);
  delete omitted.freshReadbacks;
  assert.throws(() =>
    f.store.beginResume(
      f.store.read().digest,
      {
        ...proofs,
        aggregateReadback: f.store.recordProof(omitted),
      },
      true,
    ),
  );
  const unproved = structuredClone(aggregate);
  unproved.freshReadbacks[0].materializedSeal = 'e'.repeat(64);
  assert.throws(
    () =>
      f.store.beginResume(
        f.store.read().digest,
        {
          ...proofs,
          aggregateReadback: f.store.recordProof(unproved),
        },
        true,
      ),
    /missing_or_changed/u,
  );
  const fresh = f.store.readEvidence(f.child(0).proofs.materializedSeal);
  fresh.proof.readbackSequence = 2;
  const freshHash = f.store.recordProof(fresh);
  aggregate.freshReadbacks[0].materializedSeal = freshHash;
  f.store.beginResume(
    f.store.read().digest,
    { ...proofs, aggregateReadback: f.store.recordProof(aggregate) },
    true,
  );
  f.store.finish(f.store.read().digest, f.finishProofs());
  assert.equal(
    assertNoActiveSourceAbandonmentSession(f.directory).journal.phase,
    'PARTIAL_COMPLETE',
  );
  rmSync(join(f.directory, 'evidence', `${freshHash}.json`));
  assert.throws(() => assertNoActiveSourceAbandonmentSession(f.directory), /missing_or_changed/u);
});
