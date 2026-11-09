import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statfsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLegacyDispositionSource } from './assert-legacy-disposition-source.mjs';
import { createLegacyColdClient } from './legacy-cold-client.mjs';
import {
  isLegacyColdStoreEnvironment,
  legacyColdStoreEnvironment,
} from './legacy-cold-environment.mjs';
import { readSourceAbandonmentCorrectiveIdentity } from './source-abandonment-corrective-identity.mjs';
import { refreezeSourceAbandonmentPreview } from './source-abandonment-refreeze.mjs';
import { readSourceAbandonmentAbortIdentity } from './source-abandonment-abort-identity.mjs';
import { abortSourceAbandonmentPreinstall } from './source-abandonment-abort.mjs';
import {
  assertInheritedDeployLock,
  assertNoActiveLegacyColdMaintenance,
  createLegacyColdJournalStore,
  LEGACY_COLD_STATE_DIR,
  legacyColdDigest,
} from './legacy-cold-journal.mjs';
import { createLegacyColdRuntime } from './legacy-cold-runtime.mjs';
import { createLegacyColdSmokes } from './legacy-cold-smokes.mjs';
import {
  canonicalLegacyColdDigest,
  createLegacyColdStoreAdapter,
} from './legacy-cold-store-adapter.mjs';
import {
  prepareLegacyColdRecovery,
  applyLegacyColdRecovery,
  retryLegacyColdPreview,
  observeLegacyColdAdapters,
} from './legacy-cold-protocol.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = /^[0-9a-f]{64}$/u;
const source = /^[0-9a-f]{40}$/u;
const id = /^[a-zA-Z0-9_-]{1,128}$/u;
const execute = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('request_object_required');
  return value;
}
function keys(value, allowed) {
  if (Object.keys(object(value)).some((key) => !allowed.includes(key)))
    throw new Error('unknown_request_field');
}
export function parseLegacyColdHostRequest(text) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('host_request_budget');
  const value = object(JSON.parse(text));
  if (
    value.version !== 1 ||
    ![
      'status',
      'preflight',
      'prepare',
      'apply',
      'reconcile',
      'retry-preview',
      'abort-before-install',
    ].includes(value.operation)
  )
    throw new Error('host_operation_required');
  if (value.operation === 'status') {
    keys(value, ['version', 'operation']);
    return value;
  }
  if (!source.test(value.targetSha ?? '')) throw new Error('exact_target_required');
  if (['retry-preview', 'abort-before-install'].includes(value.operation)) {
    keys(value, ['version', 'operation', 'targetSha', 'expectedJournalDigest']);
    if (!hash.test(value.expectedJournalDigest ?? '')) throw new Error('exact_review_required');
    return value;
  }
  if (['apply', 'reconcile'].includes(value.operation)) {
    keys(value, [
      'version',
      'operation',
      'targetSha',
      'expectedJournalDigest',
      'reviewedPreviewDigest',
      'reviewedInventoryDigest',
    ]);
    if (
      ['expectedJournalDigest', 'reviewedPreviewDigest', 'reviewedInventoryDigest'].some(
        (key) => !hash.test(value[key] ?? ''),
      )
    )
      throw new Error('exact_review_required');
    return value;
  }
  keys(value, ['version', 'operation', 'targetSha', 'selection']);
  keys(value.selection, ['ownerWebhookEventIds', 'majorBotIds']);
  const selection = {};
  for (const [key, maximum] of [
    ['ownerWebhookEventIds', 200],
    ['majorBotIds', 100],
  ]) {
    const values = value.selection[key];
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > maximum ||
      values.some((entry) => typeof entry !== 'string' || !id.test(entry)) ||
      new Set(values).size !== values.length
    )
      throw new Error('finite_selection_required');
    selection[key] = [...values].sort();
  }
  return { ...value, selection };
}

function directory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('private_directory_required');
}
function writePrivate(path, bytes) {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readPrivate(path, maximum = 128 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error('private_file_required');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function sourceIdentity(targetSha) {
  const head = execute('git', ['rev-parse', 'HEAD']);
  if (head !== targetSha || execute('git', ['status', '--porcelain', '--untracked-files=no']))
    throw new Error('clean_exact_host_source_required');
  assertLegacyDispositionSource(head);
  const rows = JSON.parse(execute('docker', ['image', 'inspect', `maxim-api:${head}`]));
  if (
    rows.length !== 1 ||
    !/^sha256:[0-9a-f]{64}$/u.test(rows[0].Id) ||
    rows[0].Config?.Labels?.['org.opencontainers.image.revision'] !== head
  )
    throw new Error('immutable_runtime_image_required');
  return { sourceSha: head, imageId: rows[0].Id };
}

// FLAG: The host derives this receiver only from two captured same-image role
// generations. Caller input, a fallback default and Major membership cannot attest it.
export function readLegacyColdPublisherCatalog(
  adminEnvironment,
  publisherEnvironment,
  majorBotIds,
) {
  const field = (environment, key) => {
    if (!Array.isArray(environment)) throw new Error('publisher_catalog_unproved');
    const matches = environment.filter(
      (value) => typeof value === 'string' && value.startsWith(`${key}=`),
    );
    if (matches.length !== 1) throw new Error('publisher_catalog_unproved');
    const value = matches[0].slice(key.length + 1);
    if (!id.test(value)) throw new Error('publisher_catalog_unproved');
    return value;
  };
  const publisherBotId = field(adminEnvironment, 'MAX_PUBLISHER_BOT_ID');
  if (
    majorBotIds.includes(publisherBotId) ||
    field(publisherEnvironment, 'MAX_PUBLISHER_BOT_ID') !== publisherBotId ||
    field(publisherEnvironment, 'MAX_BOT_ID') !== publisherBotId ||
    field(publisherEnvironment, 'APP_ROLE') !== 'publisher'
  )
    throw new Error('publisher_catalog_unproved');
  return publisherBotId;
}

export { isLegacyColdStoreEnvironment, legacyColdStoreEnvironment };

export function readLegacyColdStoreConnection(baseline) {
  const admin = baseline.services.find((row) => row.serviceName === 'api-admin');
  const rows = JSON.parse(execute('docker', ['inspect', admin.containerId]));
  const row = rows[0];
  if (rows.length !== 1 || row.Id !== admin.containerId || row.Image !== baseline.imageId)
    throw new Error('credential_generation_changed');
  const env = (key) => {
    const values = row.Config.Env.filter((entry) => entry.startsWith(`${key}=`));
    if (values.length > 1) throw new Error('ambiguous_catalog_environment');
    return values[0]?.slice(key.length + 1);
  };
  const extra = JSON.parse(env('MAX_BOTS_JSON') || '[]');
  if (!Array.isArray(extra)) throw new Error('major_catalog_unproved');
  const majorBotIds = [env('MAX_BOT_ID'), ...extra.map((bot) => bot.id)]
    .map((value) => (typeof value === 'string' ? value.trim() : null))
    .sort();
  if (
    majorBotIds.length > 100 ||
    majorBotIds.some((value) => !value || !id.test(value)) ||
    new Set(majorBotIds).size !== majorBotIds.length ||
    majorBotIds.includes(env('MAX_PUBLISHER_BOT_ID'))
  )
    throw new Error('major_catalog_unproved');
  const publisher = baseline.services.find((service) => service.serviceName === 'api-publisher');
  const publisherRows = JSON.parse(execute('docker', ['inspect', publisher.containerId]));
  if (
    publisherRows.length !== 1 ||
    publisherRows[0].Id !== publisher.containerId ||
    publisherRows[0].Image !== baseline.imageId
  )
    throw new Error('publisher_generation_changed');
  const publisherBotId = readLegacyColdPublisherCatalog(
    row.Config.Env,
    publisherRows[0].Config?.Env,
    majorBotIds,
  );
  const environment = legacyColdStoreEnvironment(row.Config.Env);
  const network = row.NetworkSettings?.Networks?.infra_default;
  if (!hash.test(network?.NetworkID ?? '')) throw new Error('store_network_unproved');
  const inspected = JSON.parse(execute('docker', ['network', 'inspect', network.NetworkID]));
  if (
    inspected.length !== 1 ||
    inspected[0].Name !== 'infra_default' ||
    inspected[0].Labels?.['com.docker.compose.project'] !== 'infra'
  )
    throw new Error('store_network_changed');
  return {
    networkId: network.NetworkID,
    environment,
    majorBotIds,
    publisherBotId,
  };
}

export function assertColdProtocolContext(protocol, context) {
  if (!['legacy', 'source-abandonment-v1'].includes(protocol))
    throw new Error('unsupported_cold_protocol');
  if ((context.protocol ?? 'legacy') !== protocol) throw new Error('cold_protocol_context_changed');
  if ((context.selection?.protocol ?? 'legacy') !== protocol)
    throw new Error('cold_protocol_selection_changed');
}

export function legacyColdInventoryArtifactName(pending, continuing = true) {
  if (!continuing || !pending || !Object.hasOwn(pending, 'inventoryArtifactName'))
    return 'inventory.json';
  if (
    !hash.test(pending.inventoryArtifactSha256 ?? '') ||
    pending.inventoryArtifactName !== `inventory-${pending.inventoryArtifactSha256}.json`
  )
    throw new Error('inventory_artifact_name_unproved');
  return pending.inventoryArtifactName;
}

export async function runLegacyColdHost(
  request,
  { protocol = 'legacy', controllerSha = null } = {},
) {
  // FLAG: Both controllers share one maintenance journal and lock. A modern exact-source
  // operation must never resume a legacy installation or inherit its member-wide authority.
  if (!['legacy', 'source-abandonment-v1'].includes(protocol))
    throw new Error('unsupported_cold_protocol');
  if (request.operation === 'refreeze-preview' && controllerSha === null)
    throw new Error('corrective_continuation_required');
  if (
    request.operation === 'abort-before-install' &&
    (controllerSha === null || protocol !== 'source-abandonment-v1')
  )
    throw new Error('corrective_continuation_required');
  if (
    controllerSha !== null &&
    (protocol !== 'source-abandonment-v1' ||
      !['apply', 'reconcile', 'retry-preview', 'refreeze-preview', 'abort-before-install'].includes(
        request.operation,
      ))
  )
    throw new Error('corrective_continuation_required');
  // FLAG: A pre-drain can precede the cold journal. Stock continuations must
  // wait for its bound controller to restore auxiliary queues and clear the fence.
  if (request.operation !== 'status') {
    let pending = false;
    try {
      lstatSync('/var/lib/maxim-deploy/queue-predrain-pending.json');
      pending = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (pending) throw new Error('queue_predrain_restoration_required');
  }
  assertInheritedDeployLock();
  const store = createLegacyColdJournalStore();
  const state = store.read();
  if (request.operation === 'status')
    return {
      version: 1,
      operation: 'status',
      phase: state.journal?.phase ?? 'NEVER_ADMITTED',
      blockedReason: state.journal?.blockedReason ?? null,
      journalDigest: state.journal ? legacyColdDigest(state.journal) : null,
    };
  const identity =
    controllerSha === null
      ? sourceIdentity(request.targetSha)
      : (request.operation === 'abort-before-install'
          ? readSourceAbandonmentAbortIdentity
          : readSourceAbandonmentCorrectiveIdentity)(
          { controllerSha, targetSha: request.targetSha, protocol, operation: request.operation },
          execute,
        );
  const privateRoot = join(LEGACY_COLD_STATE_DIR, 'legacy-cold-private');
  directory(privateRoot);
  let bindings;
  let baseline;
  let selection;
  let context;
  const continuing = [
    'apply',
    'reconcile',
    'retry-preview',
    'refreeze-preview',
    'abort-before-install',
  ].includes(request.operation);
  if (continuing) {
    if (
      (request.operation === 'abort-before-install'
        ? !['STOPPED', 'INVENTORIED', 'ABORTING'].includes(state.journal?.phase)
        : request.operation === 'refreeze-preview'
          ? !['STOPPED', 'INVENTORIED'].includes(state.journal?.phase)
          : request.operation === 'retry-preview'
            ? !['ADMITTED', 'STOPPING', 'STOPPED', 'INVENTORIED'].includes(state.journal?.phase)
            : request.operation === 'reconcile'
              ? !['INSTALLING', 'SEALED', 'RESUMING'].includes(state.journal?.phase)
              : state.journal?.phase !== 'INVENTORIED' || state.journal.blockedReason) ||
      state.journal.bindings.targetSha !== identity.sourceSha ||
      state.journal.bindings.targetImageId !== identity.imageId ||
      legacyColdDigest(state.journal) !== request.expectedJournalDigest
    )
      throw new Error('reviewed_journal_required');
    bindings = state.journal.bindings;
    baseline = store.readProof('hostAdmission');
    context = JSON.parse(readPrivate(join(privateRoot, bindings.controllerNonce, 'context.json')));
    assertColdProtocolContext(protocol, context);
    selection = context.selection;
  } else {
    assertNoActiveLegacyColdMaintenance();
    selection = request.selection;
    assertColdProtocolContext(protocol, { protocol, selection });
    bindings = {
      clusterIdentity: state.marker?.clusterIdentity ?? randomUUID(),
      epoch: (state.marker?.epoch ?? 0) + 1,
      controllerNonce: randomUUID(),
      certificateId: randomUUID(),
      baselineDigest: '0'.repeat(64),
      sourceSha: identity.sourceSha,
      targetSha: identity.sourceSha,
      targetImageId: identity.imageId,
      topologyDigest: '0'.repeat(64),
      selectionDigest: legacyColdDigest(selection),
    };
  }
  const operationDir = join(privateRoot, bindings.controllerNonce);
  directory(operationDir);
  const report = (value) => process.stderr.write(`${JSON.stringify(value)}\n`);
  const runtime = createLegacyColdRuntime({ bindings, baseline, report });
  baseline ??= runtime.inspectRuntime();
  bindings.baselineDigest = legacyColdDigest(baseline);
  const connection = readLegacyColdStoreConnection(baseline);
  if (
    canonicalLegacyColdDigest(selection.majorBotIds) !==
    canonicalLegacyColdDigest(connection.majorBotIds)
  )
    throw new Error('reviewed_major_catalog_changed');
  const queueBytes = readFileSync(join(root, 'infra/scripts/webhook-queue-rollout-control.cjs'));
  const queueControlSha256 = legacyColdDigest(queueBytes.toString('utf8'));
  const topology = {
    ...(protocol === 'legacy' ? {} : { protocol }),
    networkId: connection.networkId,
    queueControlSha256,
    publisherCatalogSha256: canonicalLegacyColdDigest({
      publisherBotId: connection.publisherBotId,
    }),
    serviceNames: [...baseline.services, ...baseline.auxiliaries]
      .map((row) => row.serviceName)
      .sort(),
  };
  if (
    context &&
    (legacyColdDigest(selection) !== bindings.selectionDigest ||
      legacyColdDigest(topology) !== bindings.topologyDigest ||
      context.networkId !== connection.networkId ||
      context.publisherBotId !== connection.publisherBotId ||
      context.queueControlSha256 !== queueControlSha256)
  )
    throw new Error('operation_context_changed');
  bindings.topologyDigest = legacyColdDigest(topology);
  if (controllerSha !== null) {
    // FLAG: Attest the distinct controller before any collector or writer call.
    // This immutable evidence never rewrites the original journal/runtime binding.
    const controllerReceipt = {
      version: 1,
      kind: 'source-abandonment-corrective-controller',
      protocol,
      operation: request.operation,
      controllerSha,
      runtimeSha: identity.sourceSha,
      runtimeImageId: identity.imageId,
      expectedJournalDigest: request.expectedJournalDigest,
      currentJournalDigest: legacyColdDigest(state.journal),
      requestDigest: canonicalLegacyColdDigest({
        version: 1,
        controllerSha,
        runtimeRequest: request,
      }),
      selectionDigest: bindings.selectionDigest,
      adapterSha256: createHash('sha256')
        .update(readFileSync(join(root, 'infra/scripts/legacy-cold-store-adapter.mjs')))
        .digest('hex'),
    };
    const controllerReceiptSha256 = store.recordProof(controllerReceipt);
    process.stderr.write(
      `${JSON.stringify({
        stage: 'correctiveController',
        event: 'attested',
        controllerSha,
        runtimeSha: identity.sourceSha,
        controllerReceiptSha256,
      })}\n`,
    );
  }
  const environmentFile = join(operationDir, 'client.env');
  const queueControlPath = join(operationDir, 'queue-control.cjs');
  try {
    writePrivate(environmentFile, connection.environment);
  } catch (error) {
    // FLAG: A killed controller can leave its exact private environment file. It may
    // only be reused for the same journal and unchanged captured credentials.
    if (
      !continuing ||
      error.code !== 'EEXIST' ||
      readPrivate(environmentFile) !== connection.environment
    )
      throw error;
  }
  try {
    if (!context) {
      writePrivate(queueControlPath, queueBytes);
      context = {
        version: 1,
        ...(protocol === 'legacy' ? {} : { protocol }),
        selection,
        publisherBotId: connection.publisherBotId,
        networkId: connection.networkId,
        queueControlSha256,
      };
      writePrivate(join(operationDir, 'context.json'), `${JSON.stringify(context)}\n`);
    } else if (legacyColdDigest(readPrivate(queueControlPath)) !== queueControlSha256)
      throw new Error('queue_control_changed');
    const existingPending =
      continuing && state.journal?.proofs.pendingInventory
        ? store.readProof('pendingInventory')
        : null;
    const inventoryPath = join(
      operationDir,
      legacyColdInventoryArtifactName(existingPending, continuing),
    );
    let absenceProbePath;
    let absenceProbeSha256;
    if (request.operation === 'abort-before-install') {
      const bytes = readFileSync(join(root, 'infra/scripts/source-abandonment-absence.cjs'));
      absenceProbeSha256 = createHash('sha256').update(bytes).digest('hex');
      absenceProbePath = join(operationDir, `absence-${absenceProbeSha256}.cjs`);
      try {
        writePrivate(absenceProbePath, bytes);
      } catch (error) {
        if (error.code !== 'EEXIST' || readPrivate(absenceProbePath) !== bytes.toString('utf8'))
          throw error;
      }
    }
    const client = createLegacyColdClient({
      protocol,
      sourceSha: identity.sourceSha,
      imageId: identity.imageId,
      networkId: connection.networkId,
      controllerNonce: bindings.controllerNonce,
      environmentFile,
      inventoryPath,
      queueControlPath,
      queueControlSha256,
      absenceProbePath,
      absenceProbeSha256,
    });
    const smokes = createLegacyColdSmokes({ bindings, runtime, client });
    const adapters = observeLegacyColdAdapters(
      {
        ...runtime,
        ...createLegacyColdStoreAdapter({
          store,
          client,
          runtime,
          bindings,
          selection,
          publisherBotId: connection.publisherBotId,
          inventoryPath,
          report,
        }),
        ...smokes,
        readAbortCertificateAbsent: () =>
          client.invoke('absence', { version: 1, certificateId: bindings.certificateId }),
      },
      report,
    );
    if (!continuing) {
      const capacity = statfsSync('/var/lib/docker', { bigint: true });
      const reserveGiB = protocol === 'source-abandonment-v1' ? 20n : 10n;
      if (capacity.bavail * capacity.bsize < reserveGiB * 1024n ** 3n)
        throw new Error('cold_disk_reserve_required');
      if (request.operation === 'prepare') await smokes.readNativeIdentity();
      const admissionStartedAt = Date.now();
      const admission = client.invoke('admission', {
        version: 1,
        operation: 'admission_preview',
        sourceSha: identity.sourceSha,
        imageId: identity.imageId,
        selection,
        publisherBotId: connection.publisherBotId,
      });
      writePrivate(join(operationDir, 'admission.json'), `${JSON.stringify(admission)}\n`);
      const admitted =
        admission.operation === 'admission_preview' &&
        admission.applied === false &&
        admission.activationAuthorized === false &&
        admission.stoppingAuthorized === false &&
        admission.sourceSha === identity.sourceSha &&
        admission.imageId === identity.imageId &&
        admission.selectionSha256 === canonicalLegacyColdDigest(selection) &&
        admission.publisherCatalogSha256 === topology.publisherCatalogSha256 &&
        admission.decision === 'READY_FOR_COLD_REVIEW' &&
        admission.sourceCoverageComplete === true &&
        hash.test(admission.registrySha256 ?? '') &&
        Array.isArray(admission.issues) &&
        admission.issues.length === 0;
      if (request.operation === 'preflight' || !admitted)
        return {
          version: 1,
          operation: request.operation,
          decision: admitted ? 'READY_FOR_COLD_REVIEW' : 'DENY',
          stopped: false,
          applied: false,
          evidencePath: join(operationDir, 'admission.json'),
        };
      const queues = client.invoke('queues', { version: 1, operation: 'status' });
      if (queues.queueCount !== 24 || queues.pausedCount !== 0 || queues.ownerPresent !== false)
        throw new Error('existing_queue_fence_refused');
      if (legacyColdDigest(runtime.inspectRuntime()) !== bindings.baselineDigest)
        throw new Error('baseline_changed_during_admission');
      if (Date.now() - admissionStartedAt > 60_000) throw new Error('admission_evidence_expired');
      if (!state.marker)
        store.seed({
          version: 1,
          clusterIdentity: bindings.clusterIdentity,
          epoch: 0,
          phase: 'NEVER_ADMITTED',
          complete: true,
        });
      return await prepareLegacyColdRecovery({ store, bindings, adapters });
    }
    if (request.operation === 'abort-before-install')
      return await abortSourceAbandonmentPreinstall({
        store,
        adapters,
        expectedJournalDigest: request.expectedJournalDigest,
      });
    if (request.operation === 'refreeze-preview')
      return await refreezeSourceAbandonmentPreview({ store, adapters, request });
    if (request.operation === 'retry-preview')
      return await retryLegacyColdPreview({
        store,
        adapters,
        expectedJournalDigest: request.expectedJournalDigest,
      });
    return await applyLegacyColdRecovery({
      store,
      adapters,
      expectedJournalDigest: request.expectedJournalDigest,
      reviewedPreviewDigest: request.reviewedPreviewDigest,
      reviewedInventoryDigest: request.reviewedInventoryDigest,
      reconcile: request.operation === 'reconcile',
    });
  } finally {
    unlinkSync(environmentFile);
  }
}

async function main() {
  let text = '';
  const timer = setTimeout(() => process.stdin.destroy(new Error('stdin_deadline')), 5_000);
  try {
    if (process.argv.length !== 2) throw new Error('stdin_only');
    for await (const part of process.stdin) {
      text += part;
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('stdin_budget');
    }
    clearTimeout(timer);
    const result = await runLegacyColdHost(parseLegacyColdHostRequest(text));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.decision === 'DENY') process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Legacy cold operation refused; inspect its private evidence and durable journal.\n',
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
