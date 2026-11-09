import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';
import { parseLegacyColdStoreEnvironment } from './legacy-cold-environment.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^[0-9a-f]{64}$/u;
const execute = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();

function privateFile(path, maximum, uid) {
  if (!isAbsolute(path) || /[,\r\n\0]/u.test(path))
    throw new Error('private_client_input_required');
  const stat = lstatSync(path);
  const parent = lstatSync(dirname(path));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maximum ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== uid ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== uid
  )
    throw new Error('unsafe_client_input');
}

// FLAG: A single deterministic, labelled client belongs to one durable operation.
// Never use Compose run, automatic retries, MAX credentials or a general shell in
// this client. Its exact identity is removed and absence re-proven after any result.
export function createLegacyColdClient({
  protocol = 'legacy',
  sourceSha,
  imageId,
  networkId,
  controllerNonce,
  environmentFile,
  inventoryPath,
  queueControlPath,
  queueControlSha256,
  absenceProbePath,
  absenceProbeSha256,
  sourceBatchPath,
  sourceBatchSha256,
  sourceBatchInventoryPaths,
  sourceSessionCold = null,
  uid = process.getuid(),
  gid = process.getgid(),
  run = execute,
}) {
  if (
    !['legacy', 'source-abandonment-v1'].includes(protocol) ||
    !/^[0-9a-f]{40}$/u.test(sourceSha ?? '') ||
    !/^sha256:[0-9a-f]{64}$/u.test(imageId ?? '') ||
    !digest.test(networkId ?? '') ||
    !uuid.test(controllerNonce ?? '') ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0
  )
    throw new Error('invalid_client_binding');
  if (
    sourceSessionCold !== null &&
    (protocol !== 'source-abandonment-v1' ||
      typeof sourceSessionCold.readStoppedRuntime !== 'function' ||
      sourceSessionCold.bindings?.targetSha !== sourceSha ||
      sourceSessionCold.bindings?.targetImageId !== imageId ||
      sourceSessionCold.bindings?.controllerNonce !== controllerNonce)
  )
    throw new Error('source_session_cold_client_binding_unproved');
  // FLAG: Only the session host selects this fixed profile. Re-read all captured
  // generations immediately before each create/start; construction is not proof.
  const attestColdSession = () => {
    if (sourceSessionCold !== null)
      assertLegacyColdStopped(sourceSessionCold.readStoppedRuntime(), sourceSessionCold.bindings);
  };
  const name = `maxim-legacy-recovery-${controllerNonce}`;
  const label = `com.maxim.legacy-recovery-client=${controllerNonce}`;
  let ownedId = null;
  const discover = () => {
    const text = run(['ps', '-aq', '--no-trunc', '--filter', `label=${label}`]);
    const ids = text ? text.split('\n') : [];
    if (ids.length > 1 || ids.some((id) => !digest.test(id)))
      throw new Error('ambiguous_client_identity');
    return ids;
  };
  const inspectOwned = (id) => {
    const rows = JSON.parse(run(['inspect', id]));
    const row = rows?.[0];
    if (
      rows.length !== 1 ||
      row.Id !== id ||
      row.Name !== `/${name}` ||
      row.Image !== imageId ||
      row.Config?.Labels?.['com.maxim.legacy-recovery-client'] !== controllerNonce
    )
      throw new Error('client_ownership_unproved');
    return row;
  };
  const remove = () => {
    const ids = discover();
    if (ownedId && ids.length && ids[0] !== ownedId) throw new Error('client_identity_changed');
    for (const id of ids) {
      inspectOwned(id);
      try {
        run(['rm', '-f', id]);
      } catch {
        if (discover().length) throw new Error('client_removal_unproved');
      }
    }
    if (discover().length) throw new Error('client_removal_unproved');
    ownedId = null;
  };
  return {
    remove,
    invoke(kind, request) {
      if (
        !['store', 'inventory', 'admission', 'queues', 'absence', 'source-store-batch'].includes(
          kind,
        )
      )
        throw new Error('invalid_client_kind');
      if (
        sourceSessionCold !== null &&
        !['store', 'inventory', 'source-store-batch'].includes(kind)
      )
        throw new Error('source_session_cold_client_kind_refused');
      const batch = kind === 'source-store-batch';
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > (batch ? 256 : 64) * 1024 || request?.version !== 1)
        throw new Error('client_request_budget');
      privateFile(environmentFile, 16 * 1024, uid);
      let capturedEnvironment;
      try {
        capturedEnvironment = parseLegacyColdStoreEnvironment(
          readFileSync(environmentFile, 'utf8'),
        );
      } catch {
        throw new Error('client_environment_not_allowlisted');
      }
      // FLAG: Only installation synchronizes independent Lastik holds. Keep its
      // control pair out of every collector and readback, including ambient values.
      const credentialNames = ['DATABASE_URL', 'REDIS_URL'];
      if (
        ((kind === 'store' && request.operation === 'install') ||
          (batch && request.phase === 'install')) &&
        capturedEnvironment.ERASER_CONTROL_URL !== undefined
      )
        credentialNames.push('ERASER_CONTROL_URL', 'ERASER_CONTROL_TOKEN');
      const dockerEnvironment = { ...process.env };
      for (const key of ['DATABASE_URL', 'REDIS_URL', 'ERASER_CONTROL_URL', 'ERASER_CONTROL_TOKEN'])
        delete dockerEnvironment[key];
      for (const key of credentialNames) dockerEnvironment[key] = capturedEnvironment[key];
      if (kind === 'store') privateFile(inventoryPath, 8 * 1024 * 1024, uid);
      let batchTimeout;
      if (batch) {
        privateFile(sourceBatchPath, 128 * 1024, uid);
        if (
          protocol !== 'source-abandonment-v1' ||
          !digest.test(sourceBatchSha256 ?? '') ||
          createHash('sha256').update(readFileSync(sourceBatchPath)).digest('hex') !==
            sourceBatchSha256 ||
          request.kind !== 'source_abandonment_session_store_batch' ||
          !['install', 'materialize', 'readback'].includes(request.phase) ||
          !Array.isArray(request.items) ||
          !Array.isArray(sourceBatchInventoryPaths) ||
          request.items.length < 1 ||
          request.items.length > (request.phase === 'readback' ? 32 : 1) ||
          request.items.length !== sourceBatchInventoryPaths.length ||
          request.items.some((item, index) => item?.inventoryIndex !== index) ||
          !Number.isSafeInteger(request.deadlineAtMs)
        )
          throw new Error('source_batch_binding_unproved');
        batchTimeout = request.deadlineAtMs - Date.now();
        if (
          batchTimeout <= 0 ||
          batchTimeout > { install: 90_000, materialize: 120_000, readback: 300_000 }[request.phase]
        )
          throw new Error('source_batch_deadline_refused');
        for (const path of sourceBatchInventoryPaths) privateFile(path, 8 * 1024 * 1024, uid);
      }
      if (kind === 'absence') {
        privateFile(absenceProbePath, 16 * 1024, uid);
        if (
          protocol !== 'source-abandonment-v1' ||
          !digest.test(absenceProbeSha256 ?? '') ||
          createHash('sha256').update(readFileSync(absenceProbePath)).digest('hex') !==
            absenceProbeSha256 ||
          Object.keys(request).sort().join(',') !== 'certificateId,version' ||
          !uuid.test(request.certificateId ?? '')
        )
          throw new Error('absence_probe_binding_unproved');
      }
      if (kind === 'queues') {
        privateFile(queueControlPath, 64 * 1024, uid);
        if (
          !['pause', 'wait-drained', 'resume', 'status'].includes(request.operation) ||
          !digest.test(queueControlSha256 ?? '') ||
          createHash('sha256').update(readFileSync(queueControlPath)).digest('hex') !==
            queueControlSha256
        )
          throw new Error('queue_control_binding_unproved');
      }
      if (discover().length) throw new Error('previous_client_requires_cleanup');
      const images = JSON.parse(run(['image', 'inspect', imageId]));
      if (
        images.length !== 1 ||
        images[0].Id !== imageId ||
        images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== sourceSha
      )
        throw new Error('client_image_unproved');
      const modern = protocol === 'source-abandonment-v1';
      const command = modern
        ? kind === 'store'
          ? 'source-abandonment-store'
          : 'source-abandonment-collect'
        : kind === 'store'
          ? 'legacy-recovery-store'
          : 'legacy-recovery-effect-collect';
      const args = [
        'create',
        '--name',
        name,
        '--label',
        label,
        '--interactive',
        '--network',
        networkId,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '64',
        '--memory',
        '384m',
        '--memory-swap',
        '384m',
        '--cpus',
        sourceSessionCold === null ? '0.5' : '1',
        '--user',
        `${uid}:${gid}`,
        '--tmpfs',
        '/tmp:rw,size=16m,mode=1777',
        ...credentialNames.flatMap((key) => ['--env', key]),
        '--env',
        `APP_SOURCE_SHA=${sourceSha}`,
        '--env',
        `${modern ? 'MAXIM_SOURCE_ABANDONMENT' : 'MAXIM_LEGACY_RECOVERY'}_IMAGE_ID=${imageId}`,
        '--env',
        'TZ=UTC',
        '--env',
        `${modern ? 'MAXIM_SOURCE_ABANDONMENT' : 'MAXIM_LEGACY_RECOVERY'}_OFFLINE=1`,
      ];
      if (modern && kind !== 'store' && !batch)
        args.push('--env', 'MAXIM_SOURCE_ABANDONMENT_PROTOCOL=source-abandonment-v1');
      if (kind === 'store' || batch)
        args.push(
          '--env',
          `APP_SERVICE_NAME=${modern ? 'source-abandonment' : 'legacy-recovery'}-store`,
          '--env',
          modern
            ? 'MAXIM_SOURCE_ABANDONMENT_PROTOCOL=source-abandonment-v1'
            : 'MAXIM_LEGACY_RECOVERY_STORE_PROTOCOL=host-offline-v1',
          '--env',
          `${modern ? 'MAXIM_SOURCE_ABANDONMENT' : 'MAXIM_LEGACY_RECOVERY'}_STORE_MODE=${(batch ? request.phase : request.operation) === 'readback' ? 'readback' : 'writer'}`,
        );
      if (batch) {
        args.push(
          '--mount',
          `type=bind,source=${sourceBatchPath},target=/app/source-abandonment-session-store-batch.cjs,readonly`,
        );
        for (const [index, path] of sourceBatchInventoryPaths.entries())
          args.push(
            '--mount',
            `type=bind,source=${path},target=/run/maxim-source-session/inventory-${index}.json,readonly`,
          );
      } else if (kind === 'store')
        args.push(
          '--mount',
          `type=bind,source=${inventoryPath},target=/run/maxim-legacy-recovery/inventory.json,readonly`,
        );
      else if (kind === 'absence')
        args.push(
          '--mount',
          `type=bind,source=${absenceProbePath},target=/app/source-abandonment-absence.cjs,readonly`,
        );
      else if (kind === 'queues')
        args.push(
          '--env',
          `MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN=rollout:${createHash('sha256').update(controllerNonce).digest('hex')}`,
          '--env',
          'MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_MS=1000',
          '--mount',
          `type=bind,source=${queueControlPath},target=/app/legacy-recovery-queues.cjs,readonly`,
        );
      else
        args.push(
          '--env',
          `APP_SERVICE_NAME=${modern ? 'source-abandonment-collect' : 'legacy-recovery-live'}`,
        );
      args.push(
        '--entrypoint',
        'node',
        imageId,
        batch
          ? '/app/source-abandonment-session-store-batch.cjs'
          : kind === 'absence'
            ? '/app/source-abandonment-absence.cjs'
            : kind === 'queues'
              ? '/app/legacy-recovery-queues.cjs'
              : `apps/api/dist/apps/api/src/scripts/${command}.js`,
      );
      if (kind === 'queues') args.push(request.operation);
      let output;
      let failed = false;
      try {
        attestColdSession();
        const id = run(args, { env: dockerEnvironment });
        if (!digest.test(id)) throw new Error('client_create_identity_unproved');
        ownedId = id;
        const created = inspectOwned(id);
        if (
          sourceSessionCold !== null &&
          (created.HostConfig?.NanoCpus !== 1_000_000_000 ||
            created.HostConfig?.Memory !== 384 * 1024 * 1024 ||
            created.HostConfig?.MemorySwap !== 384 * 1024 * 1024)
        )
          throw new Error('source_session_cold_client_resources_unproved');
        try {
          attestColdSession();
          output = run(['start', '-ai', id], {
            input,
            timeout: batch ? Math.max(1, request.deadlineAtMs - Date.now()) : 55_000,
          });
        } catch (error) {
          // FLAG: A read-only collector uses exit 1 for a structured refusal. Preserve
          // its bounded evidence, never Docker stderr or an unverified writer result.
          if (
            !['inventory', 'admission'].includes(kind) ||
            error.status !== 1 ||
            typeof error.stdout !== 'string' ||
            Buffer.byteLength(error.stdout) > 8 * 1024 * 1024
          )
            throw error;
          const refusal = JSON.parse(error.stdout);
          if (
            refusal?.version !== 1 ||
            refusal.decision !== 'DENY' ||
            refusal.applied !== false ||
            refusal.activationAuthorized !== false
          )
            throw new Error('collector_refusal_unproved');
          output = error.stdout;
        }
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) throw new Error('client_output_budget');
        output = JSON.parse(output);
        if (kind === 'queues') {
          if (
            output?.queueCount !== 24 ||
            !Number.isSafeInteger(output.pausedCount) ||
            output.pausedCount < 0 ||
            output.pausedCount > 24 ||
            !Number.isSafeInteger(output.activeCount) ||
            output.activeCount < 0
          )
            throw new Error('queue_response_unproved');
          output = { version: 1, ...output };
        } else if (!output || output.version !== 1) throw new Error('client_response_unproved');
        if (
          batch &&
          (output.kind !== 'source_abandonment_session_store_batch_result' ||
            output.phase !== request.phase ||
            !Array.isArray(output.results) ||
            output.results.length !== request.items.length)
        )
          throw new Error('source_batch_response_unproved');
      } catch {
        // Do not surface Docker errors: they may contain private inventory bytes.
        failed = true;
      }
      try {
        remove();
      } catch {
        throw Object.assign(new Error('client_removal_unproved'), { outcomeUnknown: true });
      }
      if (failed) throw Object.assign(new Error('client_result_unknown'), { outcomeUnknown: true });
      return output;
    },
  };
}
