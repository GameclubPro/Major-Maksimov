import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import sessionQueues from './source-abandonment-session-queues.cjs';
import {
  readLegacyColdStoreConnection,
  isLegacyColdStoreEnvironment,
} from './legacy-cold-host.mjs';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { createLegacyColdClient } from './legacy-cold-client.mjs';
import {
  canonicalLegacyColdDigest as canonical,
  createLegacyColdStoreAdapter,
} from './legacy-cold-store-adapter.mjs';
import { createLegacyColdSmokes } from './legacy-cold-smokes.mjs';
import { assertInheritedDeployLock, legacyColdDigest as digest } from './legacy-cold-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import {
  createSourceAbandonmentChildStoreView,
  validateSourceAbandonmentSessionChild,
} from './source-abandonment-session-child.mjs';
import { validateSourceAbandonmentSessionManifest } from './source-abandonment-session-journal.mjs';
import { sourceAbandonmentSessionRuntimeBindings } from './source-abandonment-session-protocol.mjs';
import { createSessionConnectionLedger } from './source-abandonment-session-connection-ledger.mjs';
import {
  createSourceAbandonmentSessionStoreBatchAdapter,
  sourceAbandonmentSessionStoreRequest,
  sourceAbandonmentSessionStoreSeal,
} from './source-abandonment-session-store-adapter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { isSupportedSourceAbandonmentQueueInventory } = sessionQueues;
const hash = /^[a-f0-9]{64}$/u;
const sha = /^[a-f0-9]{40}$/u;
const requireFact = (value, code) => {
  if (!value) throw new Error(code);
};
const bytesDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allServices = [
  ...LEGACY_COLD_API_SERVICES,
  'ocr-native-sandbox',
  'photo-native-sandbox',
].sort();
const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names, code) =>
  requireFact(
    record(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','),
    code,
  );
const identity = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.trim() === value &&
  Buffer.byteLength(value) <= 1024 &&
  [...value].every(
    (character) => character.codePointAt(0) > 31 && character.codePointAt(0) !== 127,
  );
const integer = (value, max, min = 0) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

function privateDirectory(path) {
  requireFact(isAbsolute(path) && !/[\r\n\0,]/u.test(path), 'session_host_directory_refused');
  const stat = lstatSync(path);
  requireFact(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o700,
    'session_host_directory_refused',
  );
}
function readPrivate(path, maximum) {
  requireFact(
    typeof path === 'string' && isAbsolute(path) && !/[\r\n\0,]/u.test(path),
    'session_host_private_file_refused',
  );
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireFact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= maximum,
      'session_host_private_file_refused',
    );
    const bytes = readFileSync(fd);
    requireFact(bytes.length === stat.size, 'session_host_private_file_changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function immutablePrivate(path, bytes) {
  privateDirectory(dirname(path));
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireFact(
      readPrivate(path, bytes.length).equals(Buffer.from(bytes)),
      'session_host_context_changed',
    );
    return;
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function readSourceAbandonmentSessionQueueRegistry(sourceSha, run = execute) {
  requireFact(sha.test(sourceSha ?? ''), 'session_host_source_unproved');
  const text = run('git', [
    'show',
    `${sourceSha}:apps/api/src/scripts/legacy-recovery-live-registry.ts`,
  ]);
  requireFact(
    typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024,
    'session_host_registry_unproved',
  );
  const matches = [
    ...text.matchAll(
      /export const LEGACY_RECOVERY_LIVE_QUEUE_NAMES = Object\.freeze\(\[([\s\S]*?)\] as const\);/gu,
    ),
  ];
  requireFact(
    matches.length === 1 && /^\s*(?:'[a-z0-9-]+',\s*)+$/u.test(matches[0][1]),
    'session_host_registry_unproved',
  );
  const queueNames = [...matches[0][1].matchAll(/'([a-z0-9-]+)'/gu)]
    .map((match) => match[1])
    .sort();
  requireFact(
    isSupportedSourceAbandonmentQueueInventory(queueNames),
    'session_host_registry_unproved',
  );
  return { queueNames, queueRegistrySha256: bytesDigest(text) };
}
export function sourceAbandonmentSessionHostTopology({
  baseline,
  networkId,
  publisherBotId,
  queueBundleSha256,
  queueRegistrySha256,
}) {
  return {
    protocol: 'source-abandonment-v1',
    networkId,
    queueBundleSha256,
    queueRegistrySha256,
    publisherCatalogSha256: canonical({ publisherBotId }),
    serviceNames: [...baseline.services, ...baseline.auxiliaries]
      .map((row) => row.serviceName)
      .sort(),
  };
}

// FLAG: Resolve only the captured Compose network's Redis alias. Preserve the
// private credentials and logical database; never use a DNS or host fallback.
export function resolveSourceAbandonmentSessionRedisUrl(connection, run = execute) {
  try {
    const value = new URL(connection.environment.split('\n')[1].slice('REDIS_URL='.length));
    const rows = JSON.parse(
      run('docker', ['inspect', '--type', 'container', 'infra-redis-1'], {
        timeout: 2_000,
        maxBuffer: 128 * 1024,
      }),
    );
    const redis = rows?.[0],
      network = redis?.NetworkSettings?.Networks?.infra_default;
    const healthTest = redis?.Config?.Healthcheck?.Test;
    const noHealthcheck =
      !Object.hasOwn(redis?.Config ?? {}, 'Healthcheck') ||
      (Array.isArray(healthTest) && healthTest.length === 1 && healthTest[0] === 'NONE');
    requireFact(
      rows.length === 1 &&
        hash.test(redis?.Id ?? '') &&
        redis.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        redis.Config?.Labels?.['com.docker.compose.service'] === 'redis' &&
        redis.State?.Running === true &&
        redis.State?.Paused === false &&
        redis.State?.Restarting === false &&
        redis.State?.Dead === false &&
        (redis.State?.Health?.Status === 'healthy' ||
          (!Object.hasOwn(redis?.State ?? {}, 'Health') && noHealthcheck)) &&
        network?.NetworkID === connection.networkId &&
        isIP(network?.IPAddress ?? '') === 4 &&
        value.protocol === 'redis:' &&
        ['redis', network.IPAddress].includes(value.hostname) &&
        (!value.port || value.port === '6379'),
      'session_host_redis_route_unproved',
    );
    value.hostname = network.IPAddress;
    return value.toString();
  } catch {
    throw new Error('session_host_redis_route_unproved');
  }
}

// FLAG: A complete census authenticates both namespace coverage and measured cost.
// This mirrors the fixed source-v1 installer limits; a digest alone grants no scope.
// Online admission permits active counts to move within the same known namespaces;
// cold inventory still requires identical raw counts before any installation.
function catalogs(value, queueNames, { online = false } = {}) {
  requireFact(Array.isArray(value) && value.length === 2, 'session_host_catalog_unproved');
  for (const proof of value) {
    exact(
      proof,
      ['version', 'complete', 'namespaceKeyCounts', 'cost', 'issue'],
      'session_host_catalog_unproved',
    );
    requireFact(
      proof.version === 2 &&
        proof.complete === true &&
        proof.issue === null &&
        record(proof.namespaceKeyCounts),
      'session_host_catalog_unproved',
    );
    const counts = Object.entries(proof.namespaceKeyCounts),
      cost = proof.cost;
    requireFact(
      counts.every(([name, count]) => queueNames.includes(name) && integer(count, 300_000, 1)),
      'session_host_catalog_unproved',
    );
    exact(
      cost,
      [
        'pages',
        'scanCountHints',
        'matchedKeys',
        'keyBytes',
        'bytes',
        'measurementBytes',
        'databaseKeysMax',
        'serverDurationUs',
        'maxCallDurationUs',
        'durationMs',
      ],
      'session_host_catalog_cost_unproved',
    );
    requireFact(
      Object.values(cost).every((n) => integer(n, Number.MAX_SAFE_INTEGER)) &&
        integer(cost.pages, 4096, 1) &&
        cost.scanCountHints === cost.pages * 4096 &&
        cost.databaseKeysMax <= 12_000_000 &&
        cost.matchedKeys <= 300_000 &&
        cost.matchedKeys === counts.reduce((sum, [, count]) => sum + count, 0) &&
        cost.keyBytes <= 64 * 1024 * 1024 &&
        (cost.keyBytes === 0) === (cost.matchedKeys === 0) &&
        cost.bytes <= 4 * 1024 * 1024 &&
        cost.bytes <= cost.pages * 16 * 1024 &&
        integer(cost.measurementBytes, 16 * 1024 * 1024, 1) &&
        cost.durationMs <= 20_000 &&
        cost.maxCallDurationUs <= 50_000 &&
        cost.serverDurationUs >= cost.maxCallDurationUs &&
        cost.serverDurationUs <= cost.pages * 50_000,
      'session_host_catalog_cost_unproved',
    );
  }
  const identity = (proof) =>
    online ? Object.keys(proof.namespaceKeyCounts).sort() : proof.namespaceKeyCounts;
  requireFact(
    canonical(identity(value[0])) === canonical(identity(value[1])),
    'session_host_catalog_changed',
  );
}
function effectCost(value) {
  exact(value, ['pages', 'rows', 'probes', 'bytes'], 'session_host_effect_cost_unproved');
  requireFact(
    integer(value.pages, 512) &&
      integer(value.rows, 10_000) &&
      integer(value.probes, 50_000) &&
      integer(value.bytes, 8 * 1024 * 1024),
    'session_host_effect_cost_unproved',
  );
}
function authority(row) {
  return {
    ownerId: row.ownerWebhookEventId,
    claimId: row.claimId,
    semanticKey: row.semanticKey,
    chatId: row.chatId,
    messageId: row.messageId,
  };
}
function owners(rows, expected, cutoff) {
  requireFact(
    Array.isArray(rows) && rows.length === expected.length,
    'session_host_authority_unproved',
  );
  for (const row of rows) {
    exact(
      row,
      [
        'ownerWebhookEventId',
        'semanticKey',
        'claimId',
        'chatId',
        'messageId',
        'userId',
        'sourceAt',
        'rawPayloadSha256',
        'normalizedPayloadSha256',
        'ownerSnapshotSha256',
        'claimSnapshotSha256',
        ...(Object.hasOwn(row, 'sourceProfile') ? ['sourceProfile'] : []),
      ],
      'session_host_owner_unproved',
    );
    requireFact(
      ['ownerWebhookEventId', 'semanticKey', 'claimId', 'chatId', 'messageId'].every((key) =>
        identity(row[key]),
      ) &&
        // FLAG: A null subject is permitted only by the explicit channel profile.
        // Human evidence keeps its original nonempty user identity and byte shape.
        (Object.hasOwn(row, 'sourceProfile')
          ? row.sourceProfile === 'CHANNEL_AUTHORLESS_V1' && row.userId === null
          : identity(row.userId)) &&
        [
          'rawPayloadSha256',
          'normalizedPayloadSha256',
          'ownerSnapshotSha256',
          'claimSnapshotSha256',
        ].every((key) => hash.test(row[key] ?? '')) &&
        typeof row.sourceAt === 'string' &&
        Number.isFinite(Date.parse(row.sourceAt)) &&
        new Date(row.sourceAt).toISOString() === row.sourceAt &&
        Date.parse(row.sourceAt) < Date.parse(cutoff),
      'session_host_owner_unproved',
    );
  }
  const byId = (a, b) => a.ownerId.localeCompare(b.ownerId);
  requireFact(
    canonical(rows.map(authority).sort(byId)) === canonical([...expected].sort(byId)),
    'session_host_authority_unproved',
  );
}
function exactBaseline(baseline, manifest) {
  requireFact(
    baseline?.version === 1 &&
      baseline.complete === true &&
      baseline.compatible === true &&
      baseline.singletonCount === 14 &&
      baseline.nativeCount === 2 &&
      baseline.unreviewedProducers === 0 &&
      baseline.sourceSha === manifest.sourceSha &&
      baseline.imageId === manifest.imageId &&
      baseline.selectionDigest === manifest.enumerationDigest &&
      baseline.controllerNonce === manifest.controllerNonce &&
      digest(baseline) === manifest.baselineDigest &&
      Array.isArray(baseline.services) &&
      baseline.services.length === 14 &&
      Array.isArray(baseline.auxiliaries) &&
      baseline.auxiliaries.length === 2,
    'session_host_baseline_unproved',
  );
  const rows = [...baseline.services, ...baseline.auxiliaries];
  requireFact(
    canonical(rows.map((row) => row.serviceName).sort()) === canonical(allServices) &&
      new Set(rows.map((row) => row.containerId)).size === 16 &&
      rows.every(
        (row) =>
          hash.test(row.containerId ?? '') &&
          row.sourceSha === manifest.sourceSha &&
          row.imageId === manifest.imageId &&
          row.exactGeneration === true &&
          row.restartPolicy === 'unless-stopped',
      ),
    'session_host_baseline_unproved',
  );
}

export function validateSourceAbandonmentSessionAdmission({
  admission,
  selection,
  authorities,
  sourceSha,
  imageId,
  registryDigest,
  publisherCatalogDigest,
  queueNames,
}) {
  requireFact(
    admission?.version === 1 &&
      admission.operation === 'admission_preview' &&
      admission.sourceSha === sourceSha &&
      admission.imageId === imageId &&
      admission.applied === false &&
      admission.activationAuthorized === false &&
      admission.stoppingAuthorized === false &&
      admission.decision === 'READY_FOR_COLD_REVIEW' &&
      admission.sourceCoverageComplete === true &&
      Array.isArray(admission.issues) &&
      admission.issues.length === 0 &&
      admission.selectionSha256 === canonical(selection) &&
      hash.test(admission.registrySha256 ?? '') &&
      (registryDigest === undefined || admission.registrySha256 === registryDigest) &&
      admission.publisherCatalogSha256 === publisherCatalogDigest,
    'session_host_admission_unproved',
  );
  owners(admission.selectedOwners, authorities, selection.abandonBefore);
  catalogs(admission.redisCatalogs, queueNames, { online: true });
  effectCost(admission.cost);
  return admission;
}

export function reviewSourceAbandonmentSessionPending({
  child,
  pending,
  manifest,
  baseline,
  admission,
  queueNames,
  publisherBotId,
  inventoryPath,
}) {
  validateSourceAbandonmentSessionManifest(manifest);
  exactBaseline(baseline, manifest);
  validateSourceAbandonmentSessionChild(child);
  const selected = manifest.children[child.childIndex],
    bindings = child.bindings,
    inv = pending?.inventory;
  requireFact(
    selected &&
      child.phase === 'PENDING' &&
      child.sessionId === manifest.sessionId &&
      child.manifestDigest === digest(manifest) &&
      canonical(bindings) ===
        canonical({
          ...sourceAbandonmentSessionRuntimeBindings(manifest),
          certificateId: selected.certificateId,
          selectionDigest: selected.selectionDigest,
        }) &&
      digest(child.selection) === selected.selectionDigest &&
      child.selection.abandonBefore === manifest.cutoff,
    'session_host_child_context_changed',
  );
  requireFact(
    pending?.version === 1 &&
      pending.complete === true &&
      pending.sourceSha === manifest.sourceSha &&
      pending.imageId === manifest.imageId &&
      pending.controllerNonce === manifest.controllerNonce &&
      pending.selectionDigest === selected.selectionDigest &&
      pending.unknownSources === 0 &&
      pending.saturated === false &&
      ['previewDigest', 'inventoryDigest', 'inventoryArtifactSha256'].every((key) =>
        hash.test(pending[key] ?? ''),
      ),
    'session_host_pending_unproved',
  );
  requireFact(
    bytesDigest(`${JSON.stringify(admission)}\n`) === selected.admissionDigest,
    'session_host_admission_unproved',
  );
  validateSourceAbandonmentSessionAdmission({
    admission,
    selection: child.selection,
    authorities: selected.authorities,
    sourceSha: manifest.sourceSha,
    imageId: manifest.imageId,
    registryDigest: manifest.registryDigest,
    publisherCatalogDigest: manifest.botCatalogDigest,
    queueNames,
  });
  exact(
    inv,
    [
      'version',
      'operation',
      'applied',
      'activationAuthorized',
      'decision',
      'binding',
      'selectionSha256',
      'registrySha256',
      'inventorySha256',
      'previewSha256',
      'selectedOwners',
      'children',
      'sqlPlans',
      'issues',
      'cost',
      'sqlEvidenceSha256',
      'redisEvidenceSha256',
      'redisCatalogs',
    ],
    'session_host_inventory_unproved',
  );
  requireFact(
    inv.version === 1 &&
      inv.operation === 'inventory_preview' &&
      inv.applied === false &&
      inv.activationAuthorized === false &&
      inv.decision === 'READY_TO_INSTALL' &&
      Array.isArray(inv.issues) &&
      inv.issues.length === 0 &&
      inv.selectionSha256 === canonical(child.selection) &&
      inv.registrySha256 === manifest.registryDigest &&
      inv.previewSha256 === pending.previewDigest &&
      inv.inventorySha256 === pending.inventoryDigest &&
      [inv.sqlEvidenceSha256, inv.redisEvidenceSha256].every((item) => hash.test(item ?? '')),
    'session_host_inventory_unproved',
  );
  const bound = inv.binding;
  exact(
    bound,
    [
      'maintenanceId',
      'queueFenceNonce',
      'transitionJournalSha256',
      'sourceSha',
      'imageId',
      'publisherBotId',
      'stoppedGenerations',
    ],
    'session_host_inventory_binding_unproved',
  );
  requireFact(
    bound.maintenanceId === manifest.controllerNonce &&
      bound.queueFenceNonce === digest(manifest.controllerNonce) &&
      bound.transitionJournalSha256 === digest(child) &&
      bound.sourceSha === manifest.sourceSha &&
      bound.imageId === manifest.imageId &&
      bound.publisherBotId === publisherBotId &&
      canonical({ publisherBotId }) === manifest.botCatalogDigest &&
      !child.selection.majorBotIds.includes(publisherBotId),
    'session_host_inventory_binding_unproved',
  );
  const generations = [...baseline.services, ...baseline.auxiliaries]
    .map(({ serviceName, containerId, sourceSha, imageId }) => ({
      serviceName,
      containerId,
      sourceSha,
      imageId,
      stopped: true,
    }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  requireFact(
    Array.isArray(bound.stoppedGenerations) &&
      bound.stoppedGenerations.length === 16 &&
      canonical(bound.stoppedGenerations) === canonical(generations),
    'session_host_stopped_generations_changed',
  );
  owners(inv.selectedOwners, selected.authorities, manifest.cutoff);
  catalogs(inv.redisCatalogs, queueNames);
  effectCost(inv.cost);
  requireFact(
    Array.isArray(inv.sqlPlans) &&
      inv.sqlPlans.length <= 50_000 &&
      Array.isArray(inv.children) &&
      inv.children.length <= 10_000,
    'session_host_children_unproved',
  );
  const childKeys = new Set(),
    allowed = [
      'moderation-actions',
      'max-actions-critical',
      'max-actions-interactive',
      'max-actions-background',
      'sql:spammer-observation',
      'sql:channel-auto-post',
    ];
  for (const row of inv.children) {
    exact(
      row,
      [
        'jobKey',
        'queueName',
        'jobPayloadDigest',
        'chatId',
        'messageId',
        ...(Object.hasOwn(row, 'userId') ? ['userId'] : []),
      ],
      'session_host_children_unproved',
    );
    const key = `${row.queueName === 'sql:spammer-observation' ? 'observation' : row.queueName === 'sql:channel-auto-post' ? 'channel-marker' : 'action'}:${row.jobKey}`;
    requireFact(
      ['jobKey', 'queueName', 'chatId', 'messageId'].every((field) => identity(row[field])) &&
        (!Object.hasOwn(row, 'userId') || identity(row.userId)) &&
        hash.test(row.jobPayloadDigest ?? '') &&
        allowed.includes(row.queueName) &&
        !childKeys.has(key) &&
        inv.selectedOwners.filter(
          (owner) =>
            owner.chatId === row.chatId &&
            owner.messageId === row.messageId &&
            (row.queueName !== 'sql:channel-auto-post' ||
              owner.sourceProfile === 'CHANNEL_AUTHORLESS_V1') &&
            (row.userId === undefined || row.userId === owner.userId),
        ).length === 1,
      'session_host_children_unproved',
    );
    childKeys.add(key);
  }
  requireFact(
    inv.previewSha256 ===
      canonical({
        operation: 'MODERN_SOURCE_ABANDONMENT_V1',
        selection: child.selection,
        registrySha256: inv.registrySha256,
        selectedOwners: [...inv.selectedOwners].sort((a, b) =>
          a.ownerWebhookEventId.localeCompare(b.ownerWebhookEventId),
        ),
        children: [...inv.children].sort(
          (a, b) => a.queueName.localeCompare(b.queueName) || a.jobKey.localeCompare(b.jobKey),
        ),
      }) &&
      inv.inventorySha256 ===
        canonical({
          version: 1,
          operation: 'MODERN_SOURCE_ABANDONMENT_V1',
          binding: bound,
          selectionSha256: inv.selectionSha256,
          registrySha256: inv.registrySha256,
          sql: inv.sqlEvidenceSha256,
          redis: inv.redisEvidenceSha256,
          previewSha256: inv.previewSha256,
        }),
    'session_host_inventory_digest_unproved',
  );
  const artifact = readPrivate(inventoryPath, 8 * 1024 * 1024);
  requireFact(
    artifact.equals(Buffer.from(`${JSON.stringify(inv)}\n`)) &&
      bytesDigest(artifact) === pending.inventoryArtifactSha256,
    'session_host_inventory_artifact_changed',
  );
  return {
    version: 1,
    previewDigest: pending.previewDigest,
    inventoryDigest: pending.inventoryDigest,
    selectionDigest: selected.selectionDigest,
    admissionDigest: selected.admissionDigest,
    sourceSelectionComplete: true,
    descendantsComplete: true,
  };
}

// FLAG: One host context owns the only queue FIFO and one exact credential file.
// Child adapters share the captured generations but retain their own certificate,
// selection and immutable inventory; they never stop/start or alter parent queues.
export async function createSourceAbandonmentSessionHostContext({
  manifest: inputManifest,
  baseline: inputBaseline,
  controllerSha,
  operationDir,
  store,
  queueBundlePath,
  queueBundleSha256,
  admissionPreview,
  snapshotFrozenInventory,
  now = Date.now,
  report,
  dependencies = {},
}) {
  const manifest = structuredClone(inputManifest),
    baseline = structuredClone(inputBaseline);
  validateSourceAbandonmentSessionManifest(manifest);
  exactBaseline(baseline, manifest);
  const assertLock = dependencies.assertLock ?? assertInheritedDeployLock;
  assertLock();
  privateDirectory(operationDir);
  requireFact(
    typeof admissionPreview === 'function' &&
      typeof snapshotFrozenInventory === 'function' &&
      typeof store?.read === 'function' &&
      typeof store.readEvidence === 'function' &&
      sha.test(controllerSha ?? '') &&
      hash.test(queueBundleSha256 ?? ''),
    'session_host_context_unproved',
  );
  const run = dependencies.run ?? execute;
  requireFact(
    run('git', ['rev-parse', 'HEAD']) === controllerSha &&
      run('git', ['status', '--porcelain', '--untracked-files=all']) === '',
    'session_host_controller_unproved',
  );
  const registry = readSourceAbandonmentSessionQueueRegistry(manifest.sourceSha, run);
  const bundle = readPrivate(queueBundlePath, 16 * 1024 * 1024);
  requireFact(bytesDigest(bundle) === queueBundleSha256, 'session_host_queue_bundle_changed');
  const connection = (dependencies.readConnection ?? readLegacyColdStoreConnection)(baseline);
  requireFact(
    hash.test(connection.networkId ?? '') &&
      /^[a-zA-Z0-9_-]{1,128}$/u.test(connection.publisherBotId ?? '') &&
      Array.isArray(connection.majorBotIds) &&
      connection.majorBotIds.length > 0 &&
      manifest.children.every(
        (row) => canonical(row.selection.majorBotIds) === canonical(connection.majorBotIds),
      ) &&
      canonical({ publisherBotId: connection.publisherBotId }) === manifest.botCatalogDigest,
    'session_host_catalog_changed',
  );
  const environment = connection.environment;
  requireFact(isLegacyColdStoreEnvironment(environment), 'session_host_environment_refused');
  const topology = sourceAbandonmentSessionHostTopology({
    baseline,
    ...connection,
    queueBundleSha256,
    queueRegistrySha256: registry.queueRegistrySha256,
  });
  requireFact(digest(topology) === manifest.topologyDigest, 'session_host_topology_changed');
  const sourceBatchPath = join(operationDir, 'source-abandonment-session-store-batch.cjs');
  const sourceBatchBytes = readFileSync(
    new URL('./source-abandonment-session-store-batch.cjs', import.meta.url),
  );
  requireFact(sourceBatchBytes.length <= 128 * 1024, 'session_host_batch_budget');
  immutablePrivate(sourceBatchPath, sourceBatchBytes);
  const sourceBatchSha256 = bytesDigest(sourceBatchBytes);
  const context = {
    version: 1,
    kind: 'source_abandonment_session_host',
    controllerSha,
    runtimeSha: manifest.sourceSha,
    runtimeImageId: manifest.imageId,
    sessionId: manifest.sessionId,
    manifestDigest: digest(manifest),
    baselineDigest: manifest.baselineDigest,
    topologyDigest: manifest.topologyDigest,
    networkId: connection.networkId,
    publisherBotId: connection.publisherBotId,
    majorBotIds: connection.majorBotIds,
    queueBundlePath,
    queueBundleSha256,
    queueRegistrySha256: registry.queueRegistrySha256,
    sourceBatchPath,
    sourceBatchSha256,
  };
  immutablePrivate(join(operationDir, 'context.json'), `${JSON.stringify(context)}\n`);
  const environmentFile = join(operationDir, 'store.env');
  immutablePrivate(environmentFile, environment);
  let queue = null,
    parentClient = null,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let failure;
    try {
      parentClient?.remove();
    } catch {
      failure = new Error('session_host_client_cleanup_unproved');
    }
    try {
      await queue?.close();
    } catch {
      failure ??= new Error('session_host_queue_cleanup_unproved');
    }
    try {
      requireFact(
        readPrivate(environmentFile, 16 * 1024).equals(Buffer.from(environment)),
        'session_host_environment_changed',
      );
      unlinkSync(environmentFile);
    } catch {
      failure ??= new Error('session_host_environment_cleanup_unproved');
    }
    if (failure) throw failure;
  };
  try {
    const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
    const makeRuntime = dependencies.createRuntime ?? createLegacyColdRuntime;
    const runtime = makeRuntime({ bindings, baseline, report });
    const queueModule = dependencies.loadQueueBundle
      ? dependencies.loadQueueBundle(queueBundlePath)
      : createRequire(import.meta.url)(queueBundlePath);
    requireFact(
      typeof queueModule?.createSessionQueueAdapters === 'function',
      'session_host_queue_bundle_unproved',
    );
    const queueRedisUrl = dependencies.resolveQueueRedisUrl
      ? await dependencies.resolveQueueRedisUrl(connection, baseline)
      : resolveSourceAbandonmentSessionRedisUrl(connection, run);
    queue = queueModule.createSessionQueueAdapters({
      redisUrl: queueRedisUrl,
      queueNames: registry.queueNames,
      manifest,
      connectionLedger: createSessionConnectionLedger({
        directory: operationDir,
        connectionName: `maxim-source-session:${manifest.controllerNonce}`,
        assertLock,
      }),
      now,
    });
    let activeDeadline = null;
    const workDeadline = () => {
      const journal = store.read().journal;
      if (!journal?.coldStartedAt) return null;
      const admission = store.readEvidence(journal.proofs.hostAdmission);
      requireFact(
        integer(admission?.admission?.startupReserveMs, manifest.budgets.durationMs, 1),
        'session_host_work_window_unproved',
      );
      return (
        Date.parse(journal.coldStartedAt) +
        manifest.budgets.durationMs -
        admission.admission.startupReserveMs
      );
    };
    const clientRun = (args, options = {}) => {
      const mutating = ['create', 'start'].includes(args[0]);
      const timeout =
        activeDeadline === null || !mutating
          ? (options.timeout ?? 15_000)
          : Math.min(options.timeout ?? 15_000, activeDeadline - now());
      requireFact(timeout > 0, 'session_host_work_window_exhausted');
      return run('docker', args, { ...options, timeout });
    };
    const makeClient = (inventoryPath, sourceBatchInventoryPaths = [inventoryPath]) => {
      const raw = (dependencies.createClient ?? createLegacyColdClient)({
        protocol: 'source-abandonment-v1',
        sourceSha: manifest.sourceSha,
        imageId: manifest.imageId,
        networkId: connection.networkId,
        controllerNonce: manifest.controllerNonce,
        environmentFile,
        inventoryPath,
        sourceBatchPath,
        sourceBatchSha256,
        sourceBatchInventoryPaths,
        sourceSessionCold: {
          bindings,
          readStoppedRuntime: () => runtime.readStoppedRuntime(),
        },
        run: clientRun,
      });
      return {
        remove: () => raw.remove(),
        invoke(kind, request) {
          requireFact(
            ['store', 'inventory', 'source-store-batch'].includes(kind),
            'session_host_old_queue_transport_refused',
          );
          requireFact(activeDeadline === null, 'session_host_concurrent_store_client_refused');
          const heavy =
            kind === 'inventory' ||
            (kind === 'store' && request.operation !== 'readback') ||
            (kind === 'source-store-batch' && request.phase !== 'readback');
          const deadline = heavy ? workDeadline() : null;
          if (deadline !== null)
            requireFact(now() < deadline, 'session_host_work_window_exhausted');
          activeDeadline = deadline;
          try {
            return raw.invoke(kind, request);
          } finally {
            activeDeadline = null;
          }
        },
      };
    };
    parentClient = makeClient(join(operationDir, 'parent-inventory.json'));
    let queueBaseline = null;
    const originalQueues = () =>
      queueBaseline ?? store.readEvidence(store.read().journal.proofs.hostAdmission).queueBaseline;
    const fence = async (bound) => {
      const value = await queue.readWebhookFence(manifest);
      requireFact(
        value.ownerPresent === true && value.ownerMatches === true,
        'session_host_queue_owner_unproved',
      );
      return {
        version: 1,
        complete: true,
        sourceSha: bound.targetSha,
        imageId: bound.targetImageId,
        selectionDigest: bound.selectionDigest,
        controllerNonce: bound.controllerNonce,
        ...value,
        ownerNonce: bound.controllerNonce,
      };
    };
    const smokes = (dependencies.createSmokes ?? createLegacyColdSmokes)({
      bindings,
      runtime,
      client: {
        invoke: async (kind, request) => {
          requireFact(
            kind === 'queues' && request?.version === 1 && request.operation === 'status',
            'session_host_smoke_transport_refused',
          );
          return queue.readWebhookFence(manifest);
        },
      },
      now,
    });
    const paths = new Map();
    const adapters = {
      inspectRuntime: () => runtime.inspectRuntime(),
      inspectQueueBaseline: async () => {
        queueBaseline = await queue.inspectQueueBaseline(manifest);
        return queueBaseline;
      },
      admissionPreview: (...args) => admissionPreview(...args),
      preDrainRuntime: (_, original) => queue.preDrainRuntime(manifest, original),
      stopRuntime: () => runtime.stopRuntime(),
      readStoppedRuntime: () => runtime.readStoppedRuntime(),
      pauseQueues: () => queue.pauseAllQueues(manifest, originalQueues()),
      readQueueFence: () => fence(bindings),
      snapshotFrozenInventory: (...args) => {
        const deadlineAtMs = workDeadline();
        requireFact(
          deadlineAtMs !== null && now() < deadlineAtMs,
          'session_host_work_window_exhausted',
        );
        return snapshotFrozenInventory(...args, { deadlineAtMs });
      },
      removeStoreClients: () => parentClient.remove(),
      readFreshMaterializedChildren(children) {
        requireFact(
          Array.isArray(children) && children.length > 0 && children.length <= 32,
          'session_host_readback_scope_refused',
        );
        const items = children.map((child, inventoryIndex) => {
          validateSourceAbandonmentSessionChild(child);
          const current = store.childStore(child.childIndex).read().child;
          requireFact(
            child.phase === 'MATERIALIZED' &&
              digest(child) === digest(current) &&
              child.manifestDigest === digest(manifest) &&
              child.bindings.certificateId === manifest.children[child.childIndex]?.certificateId,
            'session_host_readback_child_changed',
          );
          const pending = store.childStore(child.childIndex).readProof('pendingInventory');
          return {
            child,
            pending,
            request: sourceAbandonmentSessionStoreRequest(child.bindings, child.selection, pending),
            inventoryIndex,
          };
        });
        requireFact(
          new Set(items.map(({ child }) => child.childIndex)).size === items.length,
          'session_host_readback_scope_refused',
        );
        const inventoryPaths = items.map(({ child }) =>
          join(operationDir, `child-${child.childIndex}-inventory.json`),
        );
        const client = makeClient(inventoryPaths[0], inventoryPaths);
        const rawBatches = [];
        // FLAG: Both fresh observations use separately removed read-only clients.
        // No writer or materialization is permitted between these aggregate seals.
        for (let pass = 0; pass < 2; pass += 1) {
          client.remove();
          const journal = store.read().journal;
          const admission = store.readEvidence(journal.proofs.hostAdmission).admission;
          const restoreReserveMs =
            admission.runtimeRestoreAndSmokesMs ?? admission.startupReserveMs;
          requireFact(
            integer(restoreReserveMs, admission.startupReserveMs, 1),
            'session_host_restore_reserve_unproved',
          );
          const deadlineAtMs = Math.min(
            now() + 300_000,
            Date.parse(journal.coldStartedAt) + manifest.budgets.durationMs - restoreReserveMs,
          );
          requireFact(
            Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > now(),
            'session_host_readback_deadline_exhausted',
          );
          const output = client.invoke('source-store-batch', {
            version: 1,
            kind: 'source_abandonment_session_store_batch',
            phase: 'readback',
            deadlineAtMs,
            items: items.map(({ inventoryIndex, request }) => ({ inventoryIndex, request })),
          });
          requireFact(
            output?.version === 1 &&
              output.kind === 'source_abandonment_session_store_batch_result' &&
              output.phase === 'readback' &&
              output.results?.length === items.length,
            'session_host_readback_response_unproved',
          );
          for (const [index, item] of items.entries()) {
            const row = output.results[index];
            requireFact(
              row.inventoryIndex === index &&
                row.certificateId === item.child.bindings.certificateId,
              'session_host_readback_response_changed',
            );
            const seal = sourceAbandonmentSessionStoreSeal(
              item.child.bindings,
              item.pending,
              item.request,
              row.result,
            );
            requireFact(seal.reviewedChatCursorsComplete, 'session_host_readback_incomplete');
          }
          client.remove();
          rawBatches.push(output);
        }
        return {
          version: 1,
          kind: 'source_abandonment_session_fresh_readbacks',
          complete: true,
          sessionId: manifest.sessionId,
          manifestDigest: digest(manifest),
          rawBatches,
          readbacks: items.map((item, index) => ({
            childIndex: item.child.childIndex,
            certificateId: item.child.bindings.certificateId,
            first: sourceAbandonmentSessionStoreSeal(
              item.child.bindings,
              item.pending,
              item.request,
              rawBatches[0].results[index].result,
            ),
            second: sourceAbandonmentSessionStoreSeal(
              item.child.bindings,
              item.pending,
              item.request,
              rawBatches[1].results[index].result,
            ),
          })),
        };
      },
      createChildAdapters(index, childStore, child) {
        validateSourceAbandonmentSessionChild(child);
        const selected = manifest.children[index];
        requireFact(
          index === child.childIndex &&
            selected &&
            child.sessionId === manifest.sessionId &&
            child.manifestDigest === digest(manifest) &&
            canonical(child.bindings) ===
              canonical({
                ...bindings,
                certificateId: selected.certificateId,
                selectionDigest: selected.selectionDigest,
              }) &&
            digest(child.selection) === selected.selectionDigest,
          'session_host_child_context_changed',
        );
        const inventoryPath = join(operationDir, `child-${index}-inventory.json`);
        paths.set(index, inventoryPath);
        const childRuntime = makeRuntime({ bindings: child.bindings, baseline, report });
        const childClient = makeClient(inventoryPath);
        const stockAdapter = (dependencies.createStoreAdapter ?? createLegacyColdStoreAdapter)({
          store: createSourceAbandonmentChildStoreView(childStore),
          client: childClient,
          runtime: childRuntime,
          bindings: child.bindings,
          selection: child.selection,
          publisherBotId: connection.publisherBotId,
          inventoryPath,
          now,
          report,
        });
        const adapter = (
          dependencies.createBatchAdapter ?? createSourceAbandonmentSessionStoreBatchAdapter
        )({
          stockAdapter,
          client: childClient,
          bindings: child.bindings,
          selection: child.selection,
          now,
        });
        return {
          snapshotPending: (...args) => adapter.snapshotPending(...args),
          installDispositions: (...args) => adapter.installDispositions(...args),
          materializeReceipts: (...args) => adapter.materializeReceipts(...args),
          readSeal: (...args) => adapter.readSeal(...args),
          removeStoreClient: () => childClient.remove(),
          readStoppedRuntime: () => childRuntime.readStoppedRuntime(),
          readQueueFence: () => fence(child.bindings),
        };
      },
      reviewPendingInventory: (child, pending) =>
        reviewSourceAbandonmentSessionPending({
          child,
          pending,
          manifest,
          baseline,
          admission: store.readEvidence(manifest.children[child.childIndex].admissionDigest),
          queueNames: registry.queueNames,
          publisherBotId: connection.publisherBotId,
          inventoryPath:
            paths.get(child.childIndex) ??
            join(operationDir, `child-${child.childIndex}-inventory.json`),
        }),
      startBoundRuntime: () => runtime.startBoundRuntime(),
      readRuntimeIdentity: () => runtime.readRuntimeIdentity(),
      readNativeIdentity: () => smokes.readNativeIdentity(),
      resumeQueues: () => queue.resumeWebhookQueues(manifest),
      restoreAuxiliaryQueues: (_, original) => queue.restoreAuxiliaryQueues(manifest, original),
      strictSmokes: () => smokes.strictSmokes(),
    };
    return { adapters, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function withSourceAbandonmentSessionHostContext(options, callback) {
  const host = await createSourceAbandonmentSessionHostContext(options);
  try {
    return await callback(host);
  } finally {
    await host.close();
  }
}
