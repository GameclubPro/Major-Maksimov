import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PRIVATE_ROOT = '/var/lib/maxim-deploy/legacy-cold-private';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = /^[0-9a-f]{64}$/u;
const requireFact = (value) => {
  if (!value) throw new Error('source_preflight_completion_unproved');
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

function privateDirectory(path, uid) {
  const stat = lstatSync(path);
  requireFact(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === uid &&
      (stat.mode & 0o777) === 0o700,
  );
}

function privateJson(path, maximum, uid) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireFact(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === uid &&
        (before.mode & 0o777) === 0o600 &&
        before.size > 0 &&
        before.size <= maximum,
    );
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    requireFact(
      bytes.length === before.size &&
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
          (key) => before[key] === after[key] && after[key] === current[key],
        ) &&
        current.isFile() &&
        !current.isSymbolicLink(),
    );
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

// FLAG: Only a fully returned read-only preflight may nominate the reserved
// completion status. Preparation, generic collector refusals and uncertain cleanup
// remain failures; neither stdout nor an environment variable grants this authority.
export function assertSourceAbandonmentPreflightCompletion(
  request,
  result,
  { run = execFileSync, uid = process.getuid() } = {},
) {
  requireFact(
    request?.version === 1 &&
      request.operation === 'preflight' &&
      /^[0-9a-f]{40}$/u.test(request.targetSha ?? '') &&
      request.selection?.protocol === 'source-abandonment-v1',
  );
  requireFact(
    exactKeys(result, ['version', 'operation', 'decision', 'stopped', 'applied', 'evidencePath']) &&
      result.version === 1 &&
      result.operation === 'preflight' &&
      result.decision === 'DENY' &&
      result.stopped === false &&
      result.applied === false &&
      typeof result.evidencePath === 'string',
  );
  const operationDirectory = dirname(result.evidencePath);
  const nonce = operationDirectory.slice(PRIVATE_ROOT.length + 1);
  requireFact(
    uuid.test(nonce) &&
      operationDirectory === join(PRIVATE_ROOT, nonce) &&
      result.evidencePath === join(operationDirectory, 'admission.json'),
  );
  privateDirectory(PRIVATE_ROOT, uid);
  privateDirectory(operationDirectory, uid);
  const context = privateJson(join(operationDirectory, 'context.json'), 64 * 1024, uid);
  requireFact(
    exactKeys(context, [
      'version',
      'protocol',
      'selection',
      'publisherBotId',
      'networkId',
      'queueControlSha256',
    ]) &&
      context.version === 1 &&
      context.protocol === 'source-abandonment-v1' &&
      digest(context.selection) === digest(request.selection) &&
      /^[a-zA-Z0-9_-]{1,128}$/u.test(context.publisherBotId ?? '') &&
      hash.test(context.networkId ?? '') &&
      hash.test(context.queueControlSha256 ?? ''),
  );
  const admission = privateJson(result.evidencePath, 8 * 1024 * 1024, uid);
  requireFact(
    exactKeys(admission, [
      'version',
      'operation',
      'applied',
      'activationAuthorized',
      'stoppingAuthorized',
      'sourceSha',
      'imageId',
      'selectionSha256',
      'publisherCatalogSha256',
      'registrySha256',
      'decision',
      'sourceCoverageComplete',
      'selectedOwners',
      'sqlPlans',
      'queueCounts',
      'minimumEffectRowsForTwoReads',
      'issues',
      'cost',
      'redisCatalogs',
    ]) &&
      admission.version === 1 &&
      admission.operation === 'admission_preview' &&
      admission.decision === 'DENY' &&
      admission.applied === false &&
      admission.activationAuthorized === false &&
      admission.stoppingAuthorized === false &&
      admission.sourceCoverageComplete === false &&
      admission.sourceSha === request.targetSha &&
      /^sha256:[0-9a-f]{64}$/u.test(admission.imageId ?? '') &&
      admission.selectionSha256 === digest(request.selection) &&
      admission.publisherCatalogSha256 === digest({ publisherBotId: context.publisherBotId }) &&
      hash.test(admission.registrySha256 ?? '') &&
      ['selectedOwners', 'sqlPlans', 'queueCounts', 'redisCatalogs'].every((key) =>
        Array.isArray(admission[key]),
      ) &&
      Array.isArray(admission.issues) &&
      admission.issues.length > 0 &&
      record(admission.cost) &&
      Number.isSafeInteger(admission.minimumEffectRowsForTwoReads) &&
      admission.minimumEffectRowsForTwoReads >= 0,
  );
  try {
    lstatSync(join(operationDirectory, 'client.env'));
    requireFact(false);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // FLAG: Probe both identities after runLegacyColdHost's finally has returned.
  // This reader never removes a client or retries an uncertain Docker result.
  for (const filter of [
    `label=com.maxim.legacy-recovery-client=${nonce}`,
    `name=^/maxim-legacy-recovery-${nonce}$`,
  ]) {
    let output;
    try {
      output = run('docker', ['ps', '-aq', '--no-trunc', '--filter', filter], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 8192,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('source_preflight_completion_unproved');
    }
    requireFact(typeof output === 'string' && output.trim() === '');
  }
}
