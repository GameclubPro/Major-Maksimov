import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import sessionQueues from './source-abandonment-session-queues.cjs';

export const SOURCE_ABANDONMENT_SESSION_DIRECTORY =
  '/var/lib/maxim-deploy/source-abandonment-session';
export const SOURCE_ABANDONMENT_SESSION_JOURNAL = 'journal.json';
export const SOURCE_ABANDONMENT_SESSION_MARKER = 'marker.json';
export const SOURCE_ABANDONMENT_SESSION_DEFAULT_DURATION_MS = 60 * 60 * 1000;
export const SOURCE_ABANDONMENT_SESSION_ONLINE_ADMISSION_MAX_MS = 60 * 60 * 1000;
const maximumChildren = 32;
const ownersPerChild = 8;
export const SOURCE_ABANDONMENT_SESSION_LIMITS = Object.freeze({
  children: maximumChildren,
  ownersPerChild,
  // FLAG: A binary split of each eight-owner group visits at most fifteen nodes.
  admissionCalls: maximumChildren * (2 * ownersPerChild - 1),
  manifestBytes: 256 * 1024,
  journalBytes: 512 * 1024,
  proofBytes: 128 * 1024 * 1024,
  proofFileBytes: 8 * 1024 * 1024,
  // FLAG: Reserve 32 proof slots per child, admission splits, frozen pages and recovery.
  proofFiles: 2048,
  // The frozen scan plus two unchanged stock collector allowances per child.
  // These are parent totals; no existing per-call or per-certificate limit grows.
  // FLAG: Only a new reviewed manifest may select a longer finite cold window.
  // Existing manifests keep their admitted duration and immutable startup reserve.
  durationMs: 90 * 60 * 1000,
  inventoryPages: 10000 + 2 * maximumChildren * 512,
  inventoryRows: 2000000 + 2 * maximumChildren * 10000,
  inventoryProbes: 10000000 + 2 * maximumChildren * 50000,
  inventoryBytes: (128 + 2 * maximumChildren * 8) * 1024 * 1024,
  materializationPages: maximumChildren * 200,
});
const limits = SOURCE_ABANDONMENT_SESSION_LIMITS;
const { QUEUE_LIMITS, isSupportedSourceAbandonmentQueueInventory } = sessionQueues;
const hashPattern = /^[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const budgetKeys = [
  'durationMs',
  'proofBytes',
  'inventoryPages',
  'inventoryRows',
  'inventoryProbes',
  'inventoryBytes',
  'materializationPages',
];
const workKeys = budgetKeys.filter((key) => !['durationMs', 'proofBytes'].includes(key));
const phases = [
  'ADMITTED',
  'STOPPING',
  'STOPPED',
  'PROCESSING',
  'RESUMING',
  'ABORT_RESUMING',
  'COMPLETE',
  'PARTIAL_COMPLETE',
  'ABORTED',
];
const terminal = ['COMPLETE', 'PARTIAL_COMPLETE', 'ABORTED'];
const childProofNames = [
  'pendingInventory',
  'reviewedPreview',
  'pendingRecheck',
  'attemptEvidence',
  'installedSeal',
  'materializedSeal',
  'stoppedInventory',
  'queueFence',
  'clientRemoval',
  'failureEvidence',
];
const parentProofNames = [
  'hostAdmission',
  'preDrainInventory',
  'auxiliaryRestoration',
  'stoppedInventory',
  'queueFence',
  'frozenInventory',
  'aggregateReadback',
  'noAttemptLedger',
  'clientRemoval',
  'runtimeIdentity',
  'nativeIdentity',
  'strictSmokes',
  'failureEvidence',
];
const services = [
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
const auxiliaries = ['ocr-native-sandbox', 'photo-native-sandbox'];
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
export const sourceAbandonmentSessionDigest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const digest = sourceAbandonmentSessionDigest;
function canonicalDigest(value) {
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return digest(canonical(value));
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (condition, code = 'session_journal_refused') => {
  if (!condition) throw new Error(code);
};
function keys(value, expected) {
  fail(value !== null && typeof value === 'object' && !Array.isArray(value));
  fail([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const actual = Reflect.ownKeys(value);
  fail(actual.length === expected.length && actual.every((key) => expected.includes(key)));
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    fail(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}
function partialKeys(value, allowed) {
  fail(value !== null && typeof value === 'object' && !Array.isArray(value));
  keys(value, Object.keys(value));
  fail(Object.keys(value).every((key) => allowed.includes(key)));
}
function count(value, maximum, minimum = 0) {
  fail(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}
function clock(value) {
  fail(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value));
  fail(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  return Date.parse(value);
}
function hash(value) {
  fail(typeof value === 'string' && hashPattern.test(value));
}
function uuid(value) {
  fail(typeof value === 'string' && uuidPattern.test(value));
}
function identity(value, maximum = 1024) {
  fail(
    typeof value === 'string' &&
      value.length > 0 &&
      value.trim() === value &&
      Buffer.byteLength(value) <= maximum &&
      // eslint-disable-next-line no-control-regex -- Durable authority identities reject control bytes.
      !/[\u0000-\u001f\u007f]/u.test(value),
  );
}
function boundedArray(value, maximum, minimum = 0) {
  fail(Array.isArray(value));
  count(value.length, maximum, minimum);
  fail(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    fail(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}
function ids(value, maximum) {
  boundedArray(value, maximum, 1);
  fail(
    value.every((id) => typeof id === 'string' && idPattern.test(id)) &&
      new Set(value).size === value.length &&
      JSON.stringify(value) === JSON.stringify([...value].sort()),
  );
}
function proofReferences(value, allowed) {
  partialKeys(value, allowed);
  Object.values(value).forEach(hash);
}

// FLAG: This is the complete immutable selected plan, not a truncating iterator.
// Online enumeration and these finite certificates never claim whole-fleet recovery.
export function validateSourceAbandonmentSessionManifest(value) {
  keys(value, [
    'version',
    'kind',
    'sessionId',
    'clusterIdentity',
    'epoch',
    'controllerNonce',
    'sourceSha',
    'imageId',
    'cutoff',
    'baselineDigest',
    'topologyDigest',
    'registryDigest',
    'botCatalogDigest',
    'enumerationDigest',
    'enumerationComplete',
    'excludedCounts',
    'budgets',
    'children',
  ]);
  fail(value.version === 1 && value.kind === 'source_abandonment_session_manifest');
  ['sessionId', 'clusterIdentity', 'controllerNonce'].forEach((key) => uuid(value[key]));
  count(value.epoch, Number.MAX_SAFE_INTEGER, 1);
  fail(
    /^[0-9a-f]{40}$/u.test(value.sourceSha ?? '') &&
      /^sha256:[0-9a-f]{64}$/u.test(value.imageId ?? ''),
  );
  clock(value.cutoff);
  for (const key of [
    'baselineDigest',
    'topologyDigest',
    'registryDigest',
    'botCatalogDigest',
    'enumerationDigest',
  ])
    hash(value[key]);
  fail(value.enumerationComplete === true);
  keys(value.excludedCounts, ['rejected', 'unresolved']);
  Object.values(value.excludedCounts).forEach((n) => count(n, 2000000));
  keys(value.budgets, budgetKeys);
  for (const key of budgetKeys) count(value.budgets[key], limits[key], 1);
  boundedArray(value.children, limits.children, 1);
  const unique = Object.fromEntries(
    ['certificate', 'owner', 'claim', 'semantic', 'message'].map((key) => [key, new Set()]),
  );
  const add = (kind, id) => {
    fail(!unique[kind].has(id), 'session_manifest_collision');
    unique[kind].add(id);
  };
  let botIds = null;
  for (const child of value.children) {
    keys(child, [
      'certificateId',
      'selection',
      'selectionDigest',
      'admissionDigest',
      'authorities',
    ]);
    uuid(child.certificateId);
    add('certificate', child.certificateId);
    hash(child.selectionDigest);
    hash(child.admissionDigest);
    keys(child.selection, ['ownerWebhookEventIds', 'majorBotIds', 'protocol', 'abandonBefore']);
    const selection = child.selection;
    fail(
      selection.protocol === 'source-abandonment-v1' && selection.abandonBefore === value.cutoff,
    );
    ids(selection.ownerWebhookEventIds, limits.ownersPerChild);
    ids(selection.majorBotIds, 100);
    fail(digest(selection) === child.selectionDigest);
    const currentBots = JSON.stringify(selection.majorBotIds);
    fail(botIds === null || botIds === currentBots);
    botIds = currentBots;
    boundedArray(child.authorities, limits.ownersPerChild, 1);
    fail(child.authorities.length === selection.ownerWebhookEventIds.length);
    const localOwners = new Set();
    for (const authority of child.authorities) {
      keys(authority, ['ownerId', 'claimId', 'semanticKey', 'chatId', 'messageId']);
      fail(idPattern.test(authority.ownerId ?? '') && idPattern.test(authority.claimId ?? ''));
      identity(authority.semanticKey);
      identity(authority.chatId, 128);
      identity(authority.messageId);
      fail(selection.ownerWebhookEventIds.includes(authority.ownerId));
      localOwners.add(authority.ownerId);
      add('owner', authority.ownerId);
      add('claim', authority.claimId);
      add('semantic', authority.semanticKey);
      add('message', JSON.stringify([authority.chatId, authority.messageId]));
    }
    fail(localOwners.size === child.authorities.length);
  }
  fail(encode(value).length <= limits.manifestBytes, 'session_manifest_budget');
  return value;
}
function childBindings(manifest, definition) {
  return {
    clusterIdentity: manifest.clusterIdentity,
    epoch: manifest.epoch,
    controllerNonce: manifest.controllerNonce,
    certificateId: definition.certificateId,
    baselineDigest: manifest.baselineDigest,
    sourceSha: manifest.sourceSha,
    targetSha: manifest.sourceSha,
    targetImageId: manifest.imageId,
    topologyDigest: manifest.topologyDigest,
    selectionDigest: definition.selectionDigest,
  };
}
function childIdentity(child) {
  return {
    version: child.version,
    kind: child.kind,
    sessionId: child.sessionId,
    manifestDigest: child.manifestDigest,
    childIndex: child.childIndex,
    bindings: child.bindings,
    selection: child.selection,
  };
}
function validateChild(child, manifest, index) {
  keys(child, [
    'version',
    'kind',
    'sessionId',
    'manifestDigest',
    'childIndex',
    'revision',
    'phase',
    'bindings',
    'selection',
    'proofs',
    'blockedReason',
  ]);
  fail(
    child.version === 1 &&
      child.kind === 'source_abandonment_session_child' &&
      child.sessionId === manifest.sessionId &&
      child.manifestDigest === digest(manifest) &&
      child.childIndex === index,
  );
  count(child.revision, Number.MAX_SAFE_INTEGER, 1);
  fail(['PENDING', 'REVIEWED', 'ATTEMPTED', 'MATERIALIZED'].includes(child.phase));
  fail(
    JSON.stringify(child.bindings) ===
      JSON.stringify(childBindings(manifest, manifest.children[index])) &&
      JSON.stringify(child.selection) === JSON.stringify(manifest.children[index].selection),
  );
  proofReferences(child.proofs, childProofNames);
  fail([null, 'child_proof_failed'].includes(child.blockedReason));
  const required = child.phase === 'PENDING' ? [] : ['pendingInventory', 'reviewedPreview'];
  if (['ATTEMPTED', 'MATERIALIZED'].includes(child.phase)) required.push('attemptEvidence');
  if (child.phase === 'MATERIALIZED')
    required.push(
      'installedSeal',
      'materializedSeal',
      'stoppedInventory',
      'queueFence',
      'clientRemoval',
    );
  fail(required.every((name) => child.proofs[name]));
  if (['PENDING', 'REVIEWED'].includes(child.phase))
    fail(
      !child.proofs.attemptEvidence &&
        !['installedSeal', 'materializedSeal', 'clientRemoval'].some((name) => child.proofs[name]),
    );
  if (child.phase === 'MATERIALIZED') fail(child.blockedReason === null);
}
export function validateSourceAbandonmentSessionJournal(value) {
  keys(value, [
    'version',
    'kind',
    'revision',
    'phase',
    'createdAt',
    'updatedAt',
    'coldStartedAt',
    'manifest',
    'manifestDigest',
    'children',
    'used',
    'proofs',
    'blockedReason',
    'resumeMode',
  ]);
  fail(value.version === 1 && value.kind === 'source_abandonment_session_journal');
  count(value.revision, Number.MAX_SAFE_INTEGER, 1);
  fail(phases.includes(value.phase));
  fail(clock(value.updatedAt) >= clock(value.createdAt));
  if (value.coldStartedAt !== null)
    fail(
      clock(value.coldStartedAt) >= clock(value.createdAt) &&
        clock(value.coldStartedAt) <= clock(value.updatedAt),
    );
  fail(value.phase === 'ADMITTED' ? value.coldStartedAt === null : value.coldStartedAt !== null);
  validateSourceAbandonmentSessionManifest(value.manifest);
  fail(digest(value.manifest) === value.manifestDigest);
  boundedArray(value.children, limits.children, 1);
  fail(value.children.length === value.manifest.children.length);
  value.children.forEach((child, index) => validateChild(child, value.manifest, index));
  let unfinished = false;
  for (const child of value.children) {
    if (unfinished) fail(child.phase === 'PENDING');
    if (child.phase !== 'MATERIALIZED') unfinished = true;
  }
  keys(value.used, workKeys);
  for (const key of workKeys) count(value.used[key], value.manifest.budgets[key]);
  proofReferences(value.proofs, parentProofNames);
  fail(value.proofs.hostAdmission);
  fail(
    [null, 'session_proof_failed', 'child_proof_failed', 'session_budget_exhausted'].includes(
      value.blockedReason,
    ),
  );
  fail([null, 'complete', 'partial', 'abort'].includes(value.resumeMode));
  if (['RESUMING', 'COMPLETE', 'PARTIAL_COMPLETE'].includes(value.phase)) {
    fail(['complete', 'partial'].includes(value.resumeMode));
    fail(value.children.some((child) => child.phase === 'MATERIALIZED'));
    fail(
      value.children.every((child) =>
        ['PENDING', 'REVIEWED', 'MATERIALIZED'].includes(child.phase),
      ),
    );
    fail(
      value.resumeMode === 'complete'
        ? value.children.every((child) => child.phase === 'MATERIALIZED')
        : value.children.some((child) => child.phase !== 'MATERIALIZED'),
    );
    fail(
      ['aggregateReadback', 'stoppedInventory', 'queueFence', 'clientRemoval'].every(
        (name) => value.proofs[name],
      ),
    );
  } else if (['ABORT_RESUMING', 'ABORTED'].includes(value.phase)) {
    fail(
      value.resumeMode === 'abort' &&
        value.children.every((child) => ['PENDING', 'REVIEWED'].includes(child.phase)),
    );
    fail(
      ['noAttemptLedger', 'stoppedInventory', 'queueFence', 'clientRemoval'].every(
        (name) => value.proofs[name],
      ),
    );
  } else fail(value.resumeMode === null);
  if (['STOPPED', 'PROCESSING', 'RESUMING', 'COMPLETE', 'PARTIAL_COMPLETE'].includes(value.phase))
    fail(
      value.proofs.stoppedInventory &&
        value.proofs.queueFence &&
        value.proofs.frozenInventory &&
        value.proofs.preDrainInventory,
    );
  if (terminal.includes(value.phase)) {
    fail(
      value.blockedReason === null &&
        ['runtimeIdentity', 'nativeIdentity', 'strictSmokes', 'auxiliaryRestoration'].every(
          (name) => value.proofs[name],
        ),
    );
    fail(
      value.phase ===
        { complete: 'COMPLETE', partial: 'PARTIAL_COMPLETE', abort: 'ABORTED' }[value.resumeMode],
    );
  }
  fail(encode(value).length <= limits.journalBytes, 'session_journal_budget');
  return value;
}

function privateDirectory(directory, absent = false) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (absent && error.code === 'ENOENT') return false;
    throw error;
  }
  fail(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700 &&
      stat.uid === process.getuid(),
    'session_private_directory_required',
  );
  return true;
}
function readBytes(directory, name, maximum) {
  let fd;
  try {
    fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    fail(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= maximum,
      'session_private_file_required',
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readJson(directory, name, maximum) {
  const bytes = readBytes(directory, name, maximum);
  return bytes === null ? null : JSON.parse(bytes);
}
function proofBytes(directory) {
  const proofDirectory = join(directory, 'evidence');
  privateDirectory(proofDirectory);
  const names = readdirSync(proofDirectory);
  fail(
    names.length <= limits.proofFiles && names.every((name) => /^[0-9a-f]{64}\.json$/u.test(name)),
    'session_interrupted_or_excess_evidence',
  );
  let total = 0;
  for (const name of names) {
    const stat = lstatSync(join(proofDirectory, name));
    fail(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= limits.proofFileBytes,
      'session_private_file_required',
    );
    total += stat.size;
  }
  return { names, total };
}
function evidence(directory, reference) {
  hash(reference);
  privateDirectory(join(directory, 'evidence'));
  const bytes = readBytes(join(directory, 'evidence'), `${reference}.json`, limits.proofFileBytes);
  fail(bytes !== null && digest(bytes) === reference, 'session_evidence_missing_or_changed');
  return JSON.parse(bytes);
}
function parentBound(proof, journal) {
  fail(
    proof?.version === 1 &&
      proof.complete === true &&
      proof.sessionId === journal.manifest.sessionId &&
      proof.manifestDigest === journal.manifestDigest,
    'session_parent_proof_unbound',
  );
  return proof;
}
function childEnvelope(proof, child, kind) {
  fail(
    proof?.version === 1 &&
      proof.kind === kind &&
      proof.childBindingDigest === digest(childIdentity(child)) &&
      proof.certificateId === child.bindings.certificateId,
    'session_child_proof_unbound',
  );
  return proof.proof;
}
function childBound(proof, child) {
  const b = child.bindings;
  fail(
    proof?.version === 1 &&
      proof.complete === true &&
      proof.sourceSha === b.targetSha &&
      proof.imageId === b.targetImageId &&
      proof.controllerNonce === b.controllerNonce &&
      proof.selectionDigest === b.selectionDigest,
    'session_child_proof_unbound',
  );
}
function stopped(proof) {
  fail(proof.unreviewedProducers === 0, 'session_stopped_proof_required');
  for (const [key, expected] of [
    ['services', services],
    ['auxiliaries', auxiliaries],
  ]) {
    boundedArray(proof[key], expected.length, expected.length);
    fail(
      expected.every(
        (name) =>
          proof[key].filter(
            (row) =>
              row.serviceName === name &&
              row.stopped === true &&
              row.exactGeneration === true &&
              row.restartPolicy === 'unless-stopped',
          ).length === 1,
      ),
      'session_stopped_proof_required',
    );
  }
}
function fence(proof, nonce) {
  fail(
    proof.queueCount === 24 &&
      proof.pausedCount === 24 &&
      proof.activeCount === 0 &&
      proof.ownerNonce === nonce,
    'session_queue_fence_required',
  );
}
function seal(proof, pending) {
  fail(
    proof.previewDigest === pending.previewDigest &&
      proof.inventoryDigest === pending.inventoryDigest &&
      proof.permanentHoldsComplete === true &&
      proof.ownerProofsComplete === true,
    'session_positive_seal_required',
  );
}
function validateEvidence(journal, read) {
  const parent = (name) => parentBound(read(journal.proofs[name]), journal);
  const admissionProof = parent('hostAdmission'),
    baseline = admissionProof.queueBaseline;
  fail(
    baseline?.version === 1 &&
      baseline.complete === true &&
      baseline.registryDigest === journal.manifest.registryDigest &&
      baseline.ownerAbsent === true,
    'session_queue_baseline_required',
  );
  boundedArray(baseline.queues, QUEUE_LIMITS.queueCount, QUEUE_LIMITS.legacyQueueCount);
  fail(
    baseline.queueCount === baseline.queues.length &&
      isSupportedSourceAbandonmentQueueInventory(baseline.queues.map((row) => row?.name)),
    'session_queue_baseline_required',
  );
  for (const row of baseline.queues) {
    keys(row, ['name', 'paused']);
    fail(
      typeof row.name === 'string' &&
        /^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(row.name) &&
        typeof row.paused === 'boolean',
      'session_queue_baseline_required',
    );
  }
  for (const definition of journal.manifest.children) {
    const admission = read(definition.admissionDigest);
    // botCatalogDigest is the publisher-only catalog hash from stock topology;
    // exact major bot identities are separately bound by every child selection.
    fail(
      admission?.version === 1 &&
        admission.operation === 'admission_preview' &&
        admission.applied === false &&
        admission.activationAuthorized === false &&
        admission.stoppingAuthorized === false &&
        admission.sourceSha === journal.manifest.sourceSha &&
        admission.imageId === journal.manifest.imageId &&
        admission.selectionSha256 === canonicalDigest(definition.selection) &&
        admission.publisherCatalogSha256 === journal.manifest.botCatalogDigest &&
        admission.registrySha256 === journal.manifest.registryDigest &&
        admission.decision === 'READY_FOR_COLD_REVIEW' &&
        admission.sourceCoverageComplete === true &&
        Array.isArray(admission.issues) &&
        admission.issues.length === 0,
      'session_child_admission_required',
    );
    boundedArray(admission.selectedOwners, limits.ownersPerChild, 1);
    fail(
      admission.selectedOwners.length === definition.authorities.length &&
        definition.authorities.every(
          (authority) =>
            admission.selectedOwners.filter(
              (row) =>
                row.ownerWebhookEventId === authority.ownerId &&
                row.claimId === authority.claimId &&
                row.semanticKey === authority.semanticKey &&
                row.chatId === authority.chatId &&
                row.messageId === authority.messageId,
            ).length === 1,
        ),
      'session_child_admission_authority_changed',
    );
  }
  for (const child of journal.children) {
    for (const reference of Object.values(child.proofs)) read(reference);
    if (child.phase === 'PENDING') continue;
    const pending = read(child.proofs.pendingInventory),
      review = read(child.proofs.reviewedPreview);
    childBound(pending, child);
    fail(
      pending.unknownSources === 0 &&
        pending.saturated === false &&
        hashPattern.test(pending.inventoryArtifactSha256 ?? '') &&
        hashPattern.test(pending.previewDigest ?? '') &&
        hashPattern.test(pending.inventoryDigest ?? ''),
      'session_pending_proof_required',
    );
    fail(
      review.version === 1 &&
        review.selectionDigest === child.bindings.selectionDigest &&
        review.previewDigest === pending.previewDigest &&
        review.inventoryDigest === pending.inventoryDigest,
      'session_review_proof_required',
    );
    if (['ATTEMPTED', 'MATERIALIZED'].includes(child.phase)) {
      const attempt = childEnvelope(
        read(child.proofs.attemptEvidence),
        child,
        'source_abandonment_child_attempt',
      );
      hash(attempt.beforeChildDigest);
      fail(
        attempt.pendingInventory === child.proofs.pendingInventory &&
          attempt.reviewedPreview === child.proofs.reviewedPreview,
        'session_attempt_proof_required',
      );
    }
    if (child.phase === 'MATERIALIZED') {
      for (const [name, kind] of [
        ['installedSeal', 'installed_seal'],
        ['materializedSeal', 'materialized_seal'],
      ]) {
        const proof = childEnvelope(
          read(child.proofs[name]),
          child,
          `source_abandonment_child_${kind}`,
        );
        childBound(proof, child);
        seal(proof, pending);
        if (name === 'materializedSeal')
          fail(proof.reviewedChatCursorsComplete === true, 'session_complete_cursors_required');
      }
      const stop = childEnvelope(
        read(child.proofs.stoppedInventory),
        child,
        'source_abandonment_child_stopped',
      );
      childBound(stop, child);
      stopped(stop);
      const paused = childEnvelope(
        read(child.proofs.queueFence),
        child,
        'source_abandonment_child_fence',
      );
      childBound(paused, child);
      fence(paused, child.bindings.controllerNonce);
      fail(
        childEnvelope(
          read(child.proofs.clientRemoval),
          child,
          'source_abandonment_child_client_removal',
        )?.complete === true,
        'session_clients_not_removed',
      );
    }
  }
  if (journal.proofs.stoppedInventory) stopped(parent('stoppedInventory'));
  if (journal.proofs.queueFence) fence(parent('queueFence'), journal.manifest.controllerNonce);
  if (journal.proofs.preDrainInventory) {
    const drained = parent('preDrainInventory');
    fail(
      drained.queueCount === baseline.queueCount &&
        drained.pausedCount === baseline.queueCount &&
        drained.activeCount === 0 &&
        drained.queueWorkDrained === true &&
        drained.ownerNonce === journal.manifest.controllerNonce,
      'session_predrain_required',
    );
  }
  if (journal.proofs.frozenInventory) {
    const frozen = parent('frozenInventory');
    fail(
      frozen.coverage === 'FROZEN' &&
        frozen.cutoff === journal.manifest.cutoff &&
        frozen.sourceSha === journal.manifest.sourceSha &&
        frozen.imageId === journal.manifest.imageId &&
        frozen.enumerationComplete === true &&
        frozen.plannedEnumerationDigest === journal.manifest.enumerationDigest &&
        hashPattern.test(frozen.frozenEnumerationDigest ?? '') &&
        frozen.manifestMatches === true &&
        frozen.unknownAdditions === 0 &&
        frozen.missingOrChangedAuthorities === 0,
      'session_frozen_inventory_required',
    );
  }
  if (journal.proofs.clientRemoval)
    fail(parent('clientRemoval').clientCount === 0, 'session_clients_not_removed');
  if (journal.proofs.aggregateReadback) {
    const aggregate = parent('aggregateReadback');
    const attempted = journal.children.filter((child) => child.phase === 'MATERIALIZED');
    if (aggregate.batchReadbackProof !== undefined) {
      fail(
        hashPattern.test(aggregate.batchReadbackProof),
        'session_fresh_batch_reference_required',
      );
      const batch = read(aggregate.batchReadbackProof);
      fail(
        batch?.version === 1 &&
          batch.complete === true &&
          batch.kind === 'source_abandonment_session_fresh_readbacks' &&
          batch.sessionId === journal.manifest.sessionId &&
          batch.manifestDigest === journal.manifestDigest &&
          Array.isArray(batch.readbacks) &&
          batch.readbacks.length === attempted.length &&
          batch.readbacks.every(
            (row, index) =>
              row.childIndex === attempted[index].childIndex &&
              row.certificateId === attempted[index].bindings.certificateId,
          ),
        'session_fresh_batch_scope_unproved',
      );
      for (const [index, row] of batch.readbacks.entries()) {
        const child = attempted[index];
        const pending = read(child.proofs.pendingInventory);
        childBound(row.first, child);
        seal(row.first, pending);
        childBound(row.second, child);
        seal(row.second, pending);
        fail(
          row.first.reviewedChatCursorsComplete === true &&
            row.second.reviewedChatCursorsComplete === true,
          'session_fresh_batch_incomplete',
        );
      }
    }
    fail(
      JSON.stringify(aggregate.children) ===
        JSON.stringify(
          attempted.map((child) => ({
            childIndex: child.childIndex,
            certificateId: child.bindings.certificateId,
            childDigest: digest(child),
            materializedSeal: child.proofs.materializedSeal,
          })),
        ) && aggregate.unattemptedCount === journal.children.length - attempted.length,
      'session_aggregate_readback_required',
    );
    boundedArray(aggregate.freshReadbacks, attempted.length, attempted.length);
    for (const [index, item] of aggregate.freshReadbacks.entries()) {
      keys(item, ['childIndex', 'materializedSeal']);
      const child = attempted[index];
      fail(item.childIndex === child.childIndex, 'session_fresh_readback_order_changed');
      const fresh = childEnvelope(
        read(item.materializedSeal),
        child,
        'source_abandonment_child_materialized_seal',
      );
      childBound(fresh, child);
      seal(fresh, read(child.proofs.pendingInventory));
      fail(fresh.reviewedChatCursorsComplete === true, 'session_fresh_cursors_required');
      if (aggregate.batchReadbackProof !== undefined)
        fail(
          fresh.batchReadbackProof === aggregate.batchReadbackProof,
          'session_fresh_batch_reference_changed',
        );
    }
  }
  if (journal.proofs.noAttemptLedger) {
    const ledger = parent('noAttemptLedger');
    fail(
      ledger.attemptedCount === 0 &&
        JSON.stringify(ledger.childDigests) === JSON.stringify(journal.children.map(digest)) &&
        journal.children.every(
          (child) => !child.proofs.attemptEvidence && ['PENDING', 'REVIEWED'].includes(child.phase),
        ),
      'session_no_attempt_proof_required',
    );
  }
  if (terminal.includes(journal.phase)) {
    const runtime = parent('runtimeIdentity'),
      native = parent('nativeIdentity'),
      smokes = parent('strictSmokes');
    const restoration = parent('auxiliaryRestoration');
    fail(
      restoration.restored === true && restoration.queueBaselineDigest === digest(baseline),
      'session_auxiliary_restore_required',
    );
    fail(
      runtime.exactGenerationCount === 14 &&
        runtime.unreviewedProducers === 0 &&
        native.exactGenerationCount === 2,
      'session_restarted_identity_required',
    );
    fail(
      smokes.queuesResumed === true &&
        Number.isFinite(smokes.actionableLagSeconds) &&
        smokes.actionableLagSeconds >= 0 &&
        ((smokes.ingressReady === true &&
          smokes.adminReady === true &&
          smokes.actionableLagSeconds <= 10) ||
          (smokes.dependenciesReady === true && smokes.queueBacklogOnly === true)),
      'session_smokes_required',
    );
  }
}

// FLAG: The sticky marker precedes admission. Missing journals, unsafe files or
// interrupted writes remain active uncertainty, including after a controller crash.
export function readSourceAbandonmentSessionState(
  directory = SOURCE_ABANDONMENT_SESSION_DIRECTORY,
) {
  if (!privateDirectory(directory, true)) return { marker: null, journal: null, digest: null };
  const names = readdirSync(directory);
  fail(names.length <= 8, 'session_directory_budget');
  fail(!names.some((name) => name.startsWith('.')), 'session_interrupted_write');
  const marker = readJson(directory, SOURCE_ABANDONMENT_SESSION_MARKER, 4096);
  const journal = readJson(directory, SOURCE_ABANDONMENT_SESSION_JOURNAL, limits.journalBytes);
  if (marker === null && journal === null) return { marker, journal, digest: null };
  fail(marker !== null && journal !== null, 'session_journal_missing');
  keys(marker, ['version', 'kind', 'sessionId', 'manifestDigest', 'admissionDigest']);
  fail(marker.version === 1 && marker.kind === 'source_abandonment_session_marker');
  uuid(marker.sessionId);
  hash(marker.manifestDigest);
  hash(marker.admissionDigest);
  validateSourceAbandonmentSessionJournal(journal);
  fail(
    marker.sessionId === journal.manifest.sessionId &&
      marker.manifestDigest === journal.manifestDigest &&
      marker.admissionDigest === journal.proofs.hostAdmission,
    'session_marker_changed',
  );
  fail(proofBytes(directory).total <= journal.manifest.budgets.proofBytes, 'session_proof_budget');
  const cache = new Map();
  const readEvidence = (reference) => {
    if (!cache.has(reference)) cache.set(reference, evidence(directory, reference));
    return cache.get(reference);
  };
  for (const reference of Object.values(journal.proofs)) readEvidence(reference);
  validateEvidence(journal, readEvidence);
  return { marker, journal, digest: digest(journal) };
}
export function assertNoActiveSourceAbandonmentSession(
  directory = SOURCE_ABANDONMENT_SESSION_DIRECTORY,
) {
  const state = readSourceAbandonmentSessionState(directory);
  fail(
    !state.journal || terminal.includes(state.journal.phase),
    'source_abandonment_session_active',
  );
  return state;
}
function inheritedLock(directory) {
  const fd = Number(process.env.MAXIM_DEPLOY_LOCK_FD);
  fail(Number.isSafeInteger(fd) && fd >= 0, 'session_deploy_lock_required');
  const stat = fstatSync(fd),
    path = lstatSync(join(dirname(directory), 'deploy.lock'));
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
  fail(
    path.isFile() &&
      !path.isSymbolicLink() &&
      path.nlink === 1 &&
      (path.mode & 0o777) === 0o600 &&
      stat.dev === path.dev &&
      stat.ino === path.ino &&
      process.env.MAXIM_DEPLOY_LOCK_IDENTITY === `${stat.dev}:${stat.ino}` &&
      /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info),
    'session_deploy_lock_required',
  );
}

// Callbacks are injection points for disposable filesystem crash tests only.
// Production callers retain the inherited common deploy lock for the whole session.
export function createSourceAbandonmentSessionStore({
  directory = SOURCE_ABANDONMENT_SESSION_DIRECTORY,
  assertLock = () => inheritedLock(directory),
  now = () => new Date().toISOString(),
  onDurableStep = () => {},
} = {}) {
  const timestamp = () => {
    const value = now();
    clock(value);
    return value;
  };
  function syncDirectory(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function ensureDirectory(path) {
    if (!privateDirectory(path, true)) {
      mkdirSync(path, { mode: 0o700 });
      // FLAG: Admission must survive loss of the newly created directory entry,
      // not only loss of bytes inside it. Persist its parent before any attempt.
      syncDirectory(dirname(path));
    }
    privateDirectory(path);
  }
  function mutation() {
    assertLock();
    ensureDirectory(directory);
  }
  function atomic(name, value, subdirectory = directory) {
    const temp = `.${name}.${randomUUID()}.tmp`;
    const fd = openSync(
      join(subdirectory, temp),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const step = (stage) => onDurableStep({ file: name, stage });
    try {
      step('temp_opened');
      writeFileSync(fd, encode(value));
      step('bytes_written');
      fsyncSync(fd);
      step('file_fsynced');
      renameSync(join(subdirectory, temp), join(subdirectory, name));
      step('renamed');
      syncDirectory(subdirectory);
      step('directory_fsynced');
    } finally {
      closeSync(fd);
    }
  }
  const read = () => readSourceAbandonmentSessionState(directory);
  function current(expected) {
    mutation();
    hash(expected);
    const state = read();
    fail(
      state.journal && state.digest === expected && !terminal.includes(state.journal.phase),
      'session_journal_cas_failed',
    );
    return state.journal;
  }
  function write(previous, next) {
    next = { ...next, revision: previous.revision + 1, updatedAt: timestamp() };
    validateSourceAbandonmentSessionJournal(next);
    validateEvidence(next, (reference) => evidence(directory, reference));
    fail(
      digest(next.manifest) === previous.manifestDigest && next.createdAt === previous.createdAt,
      'session_manifest_changed',
    );
    atomic(SOURCE_ABANDONMENT_SESSION_JOURNAL, next);
    return copy(next);
  }
  function liveBudget(journal) {
    fail(
      journal.coldStartedAt === null ||
        clock(timestamp()) - clock(journal.coldStartedAt) <= journal.manifest.budgets.durationMs,
      'session_duration_budget',
    );
  }
  function references(proofs, expected) {
    keys(proofs, expected);
    Object.values(proofs).forEach((reference) => evidence(directory, reference));
    return proofs;
  }
  function childCurrent(index, expected) {
    mutation();
    hash(expected);
    const journal = read().journal;
    fail(
      journal && ['STOPPED', 'PROCESSING'].includes(journal.phase),
      'session_child_phase_refused',
    );
    count(index, journal.children.length - 1);
    const child = journal.children[index];
    fail(digest(child) === expected, 'session_child_cas_failed');
    fail(
      journal.children.slice(0, index).every((row) => row.phase === 'MATERIALIZED'),
      'session_child_order_refused',
    );
    return { journal, child };
  }
  function updateChild(journal, child, phase, proofs, blockedReason = null) {
    const nextProofs = { ...child.proofs, ...proofs };
    fail(
      Object.entries(child.proofs).every(([key, reference]) => nextProofs[key] === reference),
      'session_child_proof_changed',
    );
    const updated = {
      ...child,
      phase,
      revision: child.revision + 1,
      proofs: nextProofs,
      blockedReason,
    };
    const children = journal.children.map((row) =>
      row.childIndex === child.childIndex ? updated : row,
    );
    const next = write(journal, { ...journal, phase: 'PROCESSING', children });
    return copy(next.children[child.childIndex]);
  }
  const api = {
    read,
    readEvidence: (reference) => evidence(directory, reference),
    recordProof(value) {
      mutation();
      const bytes = encode(value);
      fail(bytes.length <= limits.proofFileBytes, 'session_proof_budget');
      const reference = digest(bytes),
        proofDirectory = join(directory, 'evidence');
      ensureDirectory(proofDirectory);
      const { names, total } = proofBytes(directory);
      const existing = readBytes(proofDirectory, `${reference}.json`, limits.proofFileBytes);
      if (existing) {
        fail(existing.equals(bytes), 'session_proof_changed');
        return reference;
      }
      const existingJournal = read().journal;
      fail(
        names.length < limits.proofFiles &&
          total + bytes.length <=
            (existingJournal?.manifest.budgets.proofBytes ?? limits.proofBytes),
        'session_proof_budget',
      );
      atomic(`${reference}.json`, value, proofDirectory);
      return reference;
    },
    seed(rawManifest, hostAdmission) {
      mutation();
      const state = read();
      fail(!state.marker && !state.journal, 'session_already_admitted');
      const manifest = copy(validateSourceAbandonmentSessionManifest(rawManifest));
      const createdAt = timestamp();
      fail(clock(manifest.cutoff) <= clock(createdAt), 'session_future_cutoff');
      evidence(directory, hostAdmission);
      fail(proofBytes(directory).total <= manifest.budgets.proofBytes, 'session_proof_budget');
      const manifestDigest = digest(manifest);
      const journal = {
        version: 1,
        kind: 'source_abandonment_session_journal',
        revision: 1,
        phase: 'ADMITTED',
        createdAt,
        updatedAt: createdAt,
        coldStartedAt: null,
        manifest,
        manifestDigest,
        children: manifest.children.map((definition, childIndex) => ({
          version: 1,
          kind: 'source_abandonment_session_child',
          sessionId: manifest.sessionId,
          manifestDigest,
          childIndex,
          revision: 1,
          phase: 'PENDING',
          bindings: childBindings(manifest, definition),
          selection: definition.selection,
          proofs: {},
          blockedReason: null,
        })),
        used: Object.fromEntries(workKeys.map((key) => [key, 0])),
        proofs: { hostAdmission },
        blockedReason: null,
        resumeMode: null,
      };
      validateSourceAbandonmentSessionJournal(journal);
      validateEvidence(journal, (reference) => evidence(directory, reference));
      atomic(SOURCE_ABANDONMENT_SESSION_MARKER, {
        version: 1,
        kind: 'source_abandonment_session_marker',
        sessionId: manifest.sessionId,
        manifestDigest,
        admissionDigest: hostAdmission,
      });
      atomic(SOURCE_ABANDONMENT_SESSION_JOURNAL, journal);
      return copy(journal);
    },
    beginStopping(expected) {
      const journal = current(expected);
      fail(journal.phase === 'ADMITTED' && !journal.blockedReason);
      return write(journal, { ...journal, phase: 'STOPPING', coldStartedAt: timestamp() });
    },
    recordPreDrain(expected, proofs) {
      const journal = current(expected);
      fail(journal.phase === 'STOPPING' && !journal.blockedReason);
      references(proofs, ['preDrainInventory']);
      fail(
        !journal.proofs.preDrainInventory ||
          journal.proofs.preDrainInventory === proofs.preDrainInventory,
        'session_predrain_changed',
      );
      return write(journal, { ...journal, proofs: { ...journal.proofs, ...proofs } });
    },
    markStopped(expected, proofs) {
      const journal = current(expected);
      fail(journal.phase === 'STOPPING' && !journal.blockedReason);
      references(proofs, ['stoppedInventory', 'queueFence', 'frozenInventory']);
      return write(journal, {
        ...journal,
        phase: 'STOPPED',
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    reserveWork(expected, reservation) {
      const journal = current(expected);
      fail(['STOPPING', 'STOPPED', 'PROCESSING'].includes(journal.phase));
      keys(reservation, workKeys);
      const recoveryOnly =
        journal.phase === 'PROCESSING' &&
        journal.children.some((child) => child.phase === 'ATTEMPTED') &&
        reservation.materializationPages > 0 &&
        reservation.materializationPages <= 200 &&
        workKeys
          .filter((key) => key !== 'materializationPages')
          .every((key) => reservation[key] === 0);
      fail(!journal.blockedReason || recoveryOnly, 'session_blocked_reservation_refused');
      liveBudget(journal);
      const used = { ...journal.used };
      for (const key of workKeys) {
        count(reservation[key], journal.manifest.budgets[key]);
        used[key] += reservation[key];
        count(used[key], journal.manifest.budgets[key]);
      }
      return write(journal, { ...journal, used });
    },
    reviewChild(expected, index, proofs) {
      const journal = current(expected);
      fail(['STOPPED', 'PROCESSING'].includes(journal.phase) && !journal.blockedReason);
      liveBudget(journal);
      count(index, journal.children.length - 1);
      const child = journal.children[index];
      fail(
        child.phase === 'PENDING' &&
          journal.children.slice(0, index).every((row) => row.phase === 'MATERIALIZED'),
      );
      references(proofs, ['pendingInventory', 'reviewedPreview']);
      updateChild(journal, child, 'REVIEWED', proofs);
      return read().journal;
    },
    beginResume(expected, proofs, partial = false) {
      const journal = current(expected);
      fail(['STOPPED', 'PROCESSING'].includes(journal.phase) && typeof partial === 'boolean');
      references(proofs, ['aggregateReadback', 'stoppedInventory', 'queueFence', 'clientRemoval']);
      return write(journal, {
        ...journal,
        phase: 'RESUMING',
        resumeMode: partial ? 'partial' : 'complete',
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    beginAbortResume(expected, proofs) {
      const journal = current(expected);
      fail(['ADMITTED', 'STOPPING', 'STOPPED', 'PROCESSING'].includes(journal.phase));
      references(proofs, ['noAttemptLedger', 'stoppedInventory', 'queueFence', 'clientRemoval']);
      return write(journal, {
        ...journal,
        phase: 'ABORT_RESUMING',
        resumeMode: 'abort',
        coldStartedAt: journal.coldStartedAt ?? timestamp(),
        blockedReason: null,
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    reconcileStopped(expected, proofs) {
      const journal = current(expected);
      fail(['RESUMING', 'ABORT_RESUMING'].includes(journal.phase));
      references(proofs, ['stoppedInventory', 'queueFence', 'clientRemoval']);
      const phase =
        journal.phase === 'RESUMING'
          ? 'PROCESSING'
          : journal.proofs.frozenInventory
            ? 'STOPPED'
            : 'STOPPING';
      return write(journal, {
        ...journal,
        phase,
        resumeMode: null,
        blockedReason: 'session_proof_failed',
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    finish(expected, proofs) {
      const journal = current(expected);
      fail(['RESUMING', 'ABORT_RESUMING'].includes(journal.phase) && !journal.blockedReason);
      references(proofs, [
        'runtimeIdentity',
        'nativeIdentity',
        'strictSmokes',
        'auxiliaryRestoration',
      ]);
      return write(journal, {
        ...journal,
        phase: { complete: 'COMPLETE', partial: 'PARTIAL_COMPLETE', abort: 'ABORTED' }[
          journal.resumeMode
        ],
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    block(expected, reason = 'session_proof_failed', proofs = {}) {
      const journal = current(expected);
      fail(
        ['session_proof_failed', 'child_proof_failed', 'session_budget_exhausted'].includes(reason),
      );
      partialKeys(proofs, ['failureEvidence']);
      Object.values(proofs).forEach((reference) => evidence(directory, reference));
      return write(journal, {
        ...journal,
        blockedReason: reason,
        proofs: { ...journal.proofs, ...proofs },
      });
    },
    childStore(index) {
      count(index, limits.children - 1);
      return Object.freeze({
        read: () => {
          const journal = read().journal;
          fail(journal && journal.children[index]);
          return { child: copy(journal.children[index]) };
        },
        readProof: (name) => {
          fail(childProofNames.includes(name));
          const journal = read().journal;
          fail(journal?.children[index]?.proofs[name]);
          return evidence(directory, journal.children[index].proofs[name]);
        },
        recordProof: (value) => api.recordProof(value),
        markAttempted(expected, proofs) {
          const { journal, child } = childCurrent(index, expected);
          liveBudget(journal);
          fail(!journal.blockedReason && child.phase === 'REVIEWED' && !child.blockedReason);
          partialKeys(proofs, ['attemptEvidence', 'pendingRecheck']);
          fail(proofs.attemptEvidence);
          Object.values(proofs).forEach((reference) => evidence(directory, reference));
          fail(
            childEnvelope(
              evidence(directory, proofs.attemptEvidence),
              child,
              'source_abandonment_child_attempt',
            ).beforeChildDigest === expected,
            'session_attempt_origin_changed',
          );
          return updateChild(journal, child, 'ATTEMPTED', proofs);
        },
        markMaterialized(expected, proofs) {
          const { journal, child } = childCurrent(index, expected);
          fail(child.phase === 'ATTEMPTED');
          references(proofs, [
            'installedSeal',
            'materializedSeal',
            'stoppedInventory',
            'queueFence',
            'clientRemoval',
          ]);
          return updateChild(journal, child, 'MATERIALIZED', proofs);
        },
        block(expected, reason, proofs = {}) {
          const { journal, child } = childCurrent(index, expected);
          fail(reason === 'child_proof_failed');
          partialKeys(proofs, ['failureEvidence']);
          Object.values(proofs).forEach((reference) => evidence(directory, reference));
          if (child.phase === 'MATERIALIZED') {
            api.block(digest(journal), reason, proofs);
            return copy(child);
          }
          const updated = updateChild(journal, child, child.phase, proofs, reason);
          api.block(read().digest, reason, proofs);
          return updated;
        },
      });
    },
  };
  return Object.freeze(api);
}

export function summarizeSourceAbandonmentSession(journal) {
  validateSourceAbandonmentSessionJournal(journal);
  const ownerCount = (rows) =>
    rows.reduce((sum, child) => sum + child.selection.ownerWebhookEventIds.length, 0);
  const attempted = journal.children.filter((child) =>
    ['ATTEMPTED', 'MATERIALIZED'].includes(child.phase),
  );
  const materialized = journal.children.filter((child) => child.phase === 'MATERIALIZED');
  return {
    version: 1,
    phase: journal.phase,
    blocked: journal.blockedReason !== null,
    completeInventoryDigest: journal.manifest.enumerationDigest,
    selectedChildren: journal.children.length,
    attemptedChildren: attempted.length,
    materializedChildren: materialized.length,
    unattemptedChildren: journal.children.length - attempted.length,
    selectedOwners: ownerCount(journal.children),
    attemptedOwners: ownerCount(attempted),
    materializedOwners: ownerCount(materialized),
    unattemptedOwners: ownerCount(journal.children) - ownerCount(attempted),
    excluded: copy(journal.manifest.excludedCounts),
    selectedScopeComplete: journal.phase === 'COMPLETE',
    parentTerminal: terminal.includes(journal.phase),
    fleetRecoveryProven: false,
  };
}
