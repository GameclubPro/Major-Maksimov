import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  GREEN_WORKFLOWS,
  REPOSITORY,
  REPOSITORY_ID,
  UnprovedWorkflowError,
  listComplete,
  proveGreenWorkflow,
  proveGreenWorkflows,
  workflowIdentity,
} from './green-workflow-proof.mjs';

export const BASELINE_POLICY_ID = 'maxim-first-parent-main-v1';
export const MAX_BASELINE_ANCESTORS = 40;
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CERTIFICATE_FILE = 'main-green.json';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const evidenceDigest = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function baselinePolicy({ cwd, sha }) {
  const entries = git(cwd, [
    'ls-tree',
    '-r',
    '-z',
    sha,
    '--',
    '.github/workflows',
    'scripts/ci',
    'scripts/agent/impact-config.mjs',
    'scripts/agent/impact-plan.mjs',
    'scripts/agent/git-changes.mjs',
    'config/change-impact.json',
    'package.json',
    'package-lock.json',
  ])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [metadata, path] = entry.split('\t');
      return { path, object: metadata.split(' ')[2] };
    })
    .filter(({ path }) => !path.endsWith('.test.mjs'));
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/codeql.yml',
    'scripts/ci/impact.mjs',
    'scripts/ci/main-baseline.mjs',
    'scripts/ci/green-workflow-proof.mjs',
    'scripts/agent/impact-config.mjs',
    'scripts/agent/impact-plan.mjs',
    'config/change-impact.json',
  ]) {
    if (!entries.some((entry) => entry.path === path))
      throw new Error(`CI policy input is absent: ${path}.`);
  }
  return { id: BASELINE_POLICY_ID, fingerprint: evidenceDigest(entries) };
}

export function ciContext(env, event) {
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    String(env.GITHUB_REPOSITORY_ID) !== String(REPOSITORY_ID) ||
    !SHA.test(env.GITHUB_SHA ?? '') ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    typeof env.GITHUB_REF !== 'string' ||
    !env.GITHUB_REF.startsWith('refs/') ||
    (event.repository &&
      (event.repository.full_name !== REPOSITORY || event.repository.id !== REPOSITORY_ID))
  ) {
    throw new Error(
      'CI proof requires the exact repository, event ref and current run/attempt identity.',
    );
  }
  return {
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    sha: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    runId,
    runAttempt,
  };
}

export function freezeBaselineProof({
  context,
  policy,
  kind,
  base = null,
  reason,
  evidence = [],
  certificate = null,
}) {
  const proof = { schemaVersion: 1, context, policy, kind, base, reason, evidence, certificate };
  return { ...proof, digest: evidenceDigest(proof) };
}

function ancestors(cwd, sha) {
  if (git(cwd, ['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('Shallow main history cannot establish a green baseline.');
  }
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).split(' ');
  if (parents.length === 1) return [];
  return git(cwd, [
    'rev-list',
    '--first-parent',
    `--max-count=${MAX_BASELINE_ANCESTORS + 1}`,
    parents[1],
  ])
    .split('\n')
    .filter(Boolean);
}

export const certificateArtifactName = ({ sha, runId, runAttempt }) =>
  `ci-main-green-${sha}-${runId}-${runAttempt}`;

// FLAG: Read exactly one bounded JSON file in memory. Never extract an artifact's
// paths or execute a command from its content.
export function readSingleJsonZip(archive, filename) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/u.test(filename))
    throw new Error('Invalid JSON artifact filename.');
  if (!Buffer.isBuffer(archive) || archive.length > 1024 * 1024)
    throw new Error('Oversized certificate archive.');
  let end = -1;
  for (
    let offset = archive.length - 22;
    offset >= Math.max(0, archive.length - 65557);
    offset -= 1
  ) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== 1 ||
    archive.readUInt16LE(end + 10) !== 1 ||
    end + 22 + archive.readUInt16LE(end + 20) !== archive.length
  )
    throw new Error('Invalid certificate ZIP directory.');
  const central = archive.readUInt32LE(end + 16);
  const centralSize = archive.readUInt32LE(end + 12);
  if (
    central + centralSize !== end ||
    centralSize < 46 ||
    central < 0 ||
    central + 46 > end ||
    archive.readUInt32LE(central) !== 0x02014b50
  )
    throw new Error('Invalid certificate ZIP entry.');
  const flags = archive.readUInt16LE(central + 8);
  const method = archive.readUInt16LE(central + 10);
  const compressed = archive.readUInt32LE(central + 20);
  const size = archive.readUInt32LE(central + 24);
  const nameSize = archive.readUInt16LE(central + 28);
  const extraSize = archive.readUInt16LE(central + 30);
  const commentSize = archive.readUInt16LE(central + 32);
  const local = archive.readUInt32LE(central + 42);
  if (
    centralSize !== 46 + nameSize + extraSize + commentSize ||
    flags & 1 ||
    ![0, 8].includes(method) ||
    size > 65536 ||
    compressed > 65536 ||
    archive.subarray(central + 46, central + 46 + nameSize).toString('utf8') !== filename ||
    local + 30 > central ||
    archive.readUInt32LE(local) !== 0x04034b50 ||
    archive.readUInt16LE(local + 8) !== method ||
    archive.readUInt16LE(local + 6) !== flags
  ) {
    throw new Error('Unsupported certificate ZIP entry.');
  }
  const localNameSize = archive.readUInt16LE(local + 26);
  const start = local + 30 + localNameSize + archive.readUInt16LE(local + 28);
  if (
    archive.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== filename ||
    start + compressed > central
  )
    throw new Error('Invalid certificate ZIP content.');
  const data = archive.subarray(start, start + compressed);
  const body = method === 8 ? inflateRawSync(data, { maxOutputLength: 65536 }) : data;
  if (body.length !== size) throw new Error('Truncated certificate ZIP content.');
  return JSON.parse(body.toString('utf8'));
}

export const readCertificateZip = (archive) => readSingleJsonZip(archive, CERTIFICATE_FILE);

function readCertificate({ github, ci, policy }) {
  const artifacts = listComplete(
    github,
    `repos/${REPOSITORY}/actions/runs/${ci.runId}/artifacts`,
    'artifacts',
  );
  const named = artifacts.filter((artifact) => artifact.name === certificateArtifactName(ci));
  if (named.length !== 1 || named[0].expired)
    throw new Error('Missing, duplicate or expired main-green certificate.');
  const artifact = named[0];
  if (
    artifact.workflow_run?.id !== ci.runId ||
    artifact.workflow_run?.repository_id !== REPOSITORY_ID ||
    artifact.workflow_run?.head_repository_id !== REPOSITORY_ID ||
    artifact.workflow_run?.head_sha !== ci.sha ||
    artifact.workflow_run?.head_branch !== 'main'
  )
    throw new Error('Certificate artifact source does not match the CI run.');
  const archive = github.binary(`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`);
  if (
    artifact.digest &&
    artifact.digest !== `sha256:${createHash('sha256').update(archive).digest('hex')}`
  ) {
    throw new Error('Certificate artifact digest mismatch.');
  }
  const certificate = readCertificateZip(archive);
  if (
    certificate.schemaVersion !== 1 ||
    canonicalJson(certificate.policy) !== canonicalJson(policy) ||
    certificate.context?.repository !== REPOSITORY ||
    certificate.context?.repositoryId !== REPOSITORY_ID ||
    certificate.context?.sha !== ci.sha ||
    certificate.context?.event !== 'push' ||
    certificate.context?.ref !== 'refs/heads/main' ||
    certificate.context?.runId !== ci.runId ||
    certificate.context?.runAttempt !== ci.runAttempt ||
    !HASH.test(certificate.planDigest ?? '') ||
    !['full', 'scoped'].includes(certificate.coverageMode)
  ) {
    throw new Error('Missing or incompatible main-green policy certificate.');
  }
  return { artifactId: artifact.id, name: artifact.name, digest: evidenceDigest(certificate) };
}

export function discoverMainBaseline({ cwd, context, policy, github }) {
  const full = (reason) => freezeBaselineProof({ context, policy, kind: 'full', reason });
  if (context.event !== 'push' || context.ref !== 'refs/heads/main')
    return full('unsupported-main-baseline-event');
  try {
    const history = ancestors(cwd, context.sha);
    for (const base of history.slice(0, MAX_BASELINE_ANCESTORS)) {
      let proofs;
      try {
        proofs = proveGreenWorkflows({ github, sha: base });
      } catch (error) {
        if (error instanceof UnprovedWorkflowError) continue;
        throw error;
      }
      const certificate = readCertificate({ github, ci: proofs[0], policy });
      return freezeBaselineProof({
        context,
        policy,
        kind: 'green-main',
        base,
        reason: 'proven-first-parent-main',
        evidence: proofs.map(workflowIdentity),
        certificate,
      });
    }
    return full(
      history.length > MAX_BASELINE_ANCESTORS
        ? 'green-main-search-limit'
        : 'no-compatible-green-main',
    );
  } catch {
    return full('unavailable-green-main-evidence');
  }
}

// FLAG: Required validates this frozen base, never rediscovers a newer one.
// A failed-jobs rerun retaining an earlier impact attempt must rerun all jobs.
export function validateFrozenBaseline({ proof, cwd, context, policy, github }) {
  if (!proof || canonicalJson(proof).length > 32768)
    throw new Error('Missing or oversized frozen CI proof.');
  const { digest, ...body } = proof;
  if (
    proof.schemaVersion !== 1 ||
    digest !== evidenceDigest(body) ||
    canonicalJson(proof.context) !== canonicalJson(context) ||
    canonicalJson(proof.policy) !== canonicalJson(policy)
  ) {
    throw new Error(
      'Frozen CI proof differs from the current repository/policy/run attempt; rerun all jobs.',
    );
  }
  if (
    proof.kind === 'full' &&
    proof.base === null &&
    proof.evidence?.length === 0 &&
    proof.certificate === null &&
    [
      'unsupported-main-baseline-event',
      'green-main-search-limit',
      'no-compatible-green-main',
      'unavailable-green-main-evidence',
      'unavailable-ci-policy',
      'unproved-base',
      'manual-scheduled-or-unsupported-event',
    ].includes(proof.reason)
  )
    return;
  if (
    proof.kind === 'pull-request' &&
    context.event === 'pull_request' &&
    SHA.test(proof.base ?? '') &&
    proof.evidence?.length === 0 &&
    proof.certificate === null &&
    proof.reason === 'recorded-pull-request-base'
  )
    return;
  if (
    proof.kind !== 'green-main' ||
    context.event !== 'push' ||
    context.ref !== 'refs/heads/main' ||
    !SHA.test(proof.base ?? '') ||
    !ancestors(cwd, context.sha).slice(0, MAX_BASELINE_ANCESTORS).includes(proof.base) ||
    proof.reason !== 'proven-first-parent-main' ||
    !Array.isArray(proof.evidence) ||
    proof.evidence.length !== GREEN_WORKFLOWS.length
  ) {
    throw new Error('Frozen CI baseline is not a proven first-parent ancestor of main.');
  }
  const fresh = GREEN_WORKFLOWS.map((workflow) =>
    workflowIdentity(proveGreenWorkflow({ github, sha: proof.base, workflow })),
  );
  if (canonicalJson(fresh) !== canonicalJson(proof.evidence))
    throw new Error('Frozen workflow evidence was substituted or superseded.');
  const certificate = readCertificate({ github, ci: fresh[0], policy });
  if (canonicalJson(certificate) !== canonicalJson(proof.certificate))
    throw new Error('Frozen main-green certificate was substituted.');
}

export function createMainGreenCertificate(plan) {
  const { context, policy } = plan.baselineProof;
  if (
    context.event !== 'push' ||
    context.ref !== 'refs/heads/main' ||
    !HASH.test(policy.fingerprint ?? '')
  )
    return null;
  return {
    schemaVersion: 1,
    context,
    policy,
    coverageMode: plan.mode,
    planDigest: evidenceDigest(plan),
  };
}
