#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectGitChanges } from '../agent/git-changes.mjs';
import { loadImpactConfig } from '../agent/impact-config.mjs';
import { createImpactPlan } from '../agent/impact-plan.mjs';
import { createGitHubClient } from './green-workflow-proof.mjs';
import {
  BASELINE_POLICY_ID,
  baselinePolicy,
  ciContext,
  createMainGreenCertificate,
  discoverMainBaseline,
  freezeBaselineProof,
  validateFrozenBaseline,
} from './main-baseline.mjs';

export const CI_LANES = Object.freeze([
  'static',
  'contracts',
  'api',
  'postgres-races',
  'commercial-benchmark',
  'miniapp',
  'admin',
  'eraser',
  'docker',
  'registry',
]);

export const DOCKER_COMPONENTS = Object.freeze([
  {
    component: 'eraser',
    dockerfile: 'apps/eraser/Dockerfile',
    image_repository: 'maxim-eraser',
    vite_api_base: '',
  },
  {
    component: 'api',
    dockerfile: 'apps/api/Dockerfile',
    image_repository: 'maxim-api',
    vite_api_base: '',
  },
  {
    component: 'miniapp',
    dockerfile: 'apps/miniapp/Dockerfile',
    image_repository: 'maxim-miniapp-major',
    vite_api_base: 'https://major-maksimov.ru/api/v1',
  },
  {
    component: 'admin',
    dockerfile: 'apps/admin/Dockerfile',
    image_repository: 'maxim-admin',
    vite_api_base: '',
  },
]);

const SHA = /^[a-f0-9]{40}$/u;
const KNOWN_CHECKS = new Set([
  'repo-static',
  'agent-tools',
  'docs',
  'infra',
  'contracts',
  'api',
  'prisma',
  'miniapp-css',
  'miniapp',
  'miniapp-production-build',
  'miniapp-visual-local',
  'admin',
  'eraser',
  'full',
]);
const COMPONENT_LANES = {
  'api-shared': 'api',
  'miniapp-major-static': 'miniapp',
  'admin-static': 'admin',
  eraser: 'eraser',
};

// FLAG: Exact local-only entrypoints and their tests; shared helpers, impact policy,
// locks, generators and unknown additions still exercise the complete CI graph.
// Static owns every listed test and check:docs. Review callers before extending.
const LOCAL_TOOLING_PATHS = new Set([
  'scripts/agent/context.mjs',
  'scripts/agent/doctor.mjs',
  'scripts/agent/focused.mjs',
  'scripts/agent/task-worktree.mjs',
  'scripts/agent/test/context.test.mjs',
  'scripts/agent/test/focused.test.mjs',
  'scripts/agent/test/task-worktree.test.mjs',
  'scripts/check-docs.mjs',
  'scripts/check-docs.test.mjs',
]);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isAncestor(cwd, base, head) {
  return (
    spawnSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd,
      stdio: 'ignore',
    }).status === 0
  );
}

function fullPlan(head, reason, base = null, changedFileCount = null) {
  return {
    schemaVersion: 1,
    mode: 'full',
    reason,
    base,
    head,
    changedFileCount,
    lanes: Object.fromEntries(CI_LANES.map((lane) => [lane, true])),
    dockerComponents: DOCKER_COMPONENTS.map(({ component }) => component),
  };
}

export function selectCiLanes(impact, { base, head }) {
  const count = impact.changedFiles.length;
  // FLAG: Shared CI/workflow/tooling changes must exercise the whole graph.
  // Unknown paths or newly introduced check kinds cannot silently reduce coverage.
  if (impact.unknownPaths.length || impact.checks.some((check) => !KNOWN_CHECKS.has(check))) {
    return fullPlan(head, 'unknown-impact', base, count);
  }
  if (
    impact.checks.includes('full') ||
    impact.changedFiles.some(
      (path) =>
        !path.endsWith('.md') &&
        !LOCAL_TOOLING_PATHS.has(path) &&
        (/^(?:\.github|scripts|config|infra)\//u.test(path) || !path.includes('/')),
    )
  ) {
    return fullPlan(head, 'shared-tooling-or-build-input', base, count);
  }
  if (impact.deploy.components.some((component) => !Object.hasOwn(COMPONENT_LANES, component))) {
    return fullPlan(head, 'unknown-component', base, count);
  }
  const checks = new Set(impact.checks);
  const dockerComponents = DOCKER_COMPONENTS.map(({ component }) => component).filter((lane) =>
    impact.deploy.components.some((component) => COMPONENT_LANES[component] === lane),
  );
  const api = checks.has('api') || checks.has('prisma') || dockerComponents.includes('api');
  return {
    schemaVersion: 1,
    mode: 'scoped',
    reason: 'classified-changes',
    base,
    head,
    changedFileCount: count,
    lanes: {
      static: true,
      contracts: checks.has('contracts'),
      api,
      'postgres-races': api,
      'commercial-benchmark': api,
      miniapp:
        [...checks].some((check) => check.startsWith('miniapp')) ||
        dockerComponents.includes('miniapp'),
      admin: checks.has('admin') || dockerComponents.includes('admin'),
      eraser: checks.has('eraser') || dockerComponents.includes('eraser'),
      docker: dockerComponents.length > 0,
    },
    dockerComponents,
  };
}

// FLAG: Only the impact job discovers a baseline. Required reuses its frozen
// evidence and computes the same range, even when other main runs finish later.
export async function createCiPlan({
  cwd = process.cwd(),
  eventName,
  event,
  sha,
  context,
  github,
  frozenProof,
}) {
  if (!SHA.test(sha ?? '') || git(cwd, ['rev-parse', 'HEAD']) !== sha) {
    throw new Error('CI checkout must match the exact event SHA.');
  }
  if (!context || context.sha !== sha || context.event !== eventName) {
    throw new Error('CI plan requires the exact current workflow context.');
  }
  let policy;
  try {
    policy = baselinePolicy({ cwd, sha });
  } catch {
    policy = { id: BASELINE_POLICY_ID, fingerprint: null };
  }
  let proof;
  let base;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    const requestedHead = event.pull_request?.head?.sha;
    if (!SHA.test(requestedHead ?? '') || !isAncestor(cwd, requestedHead, sha)) {
      throw new Error('CI checkout does not contain the pull request head.');
    }
    proof =
      SHA.test(base ?? '') && !/^0+$/u.test(base) && isAncestor(cwd, base, sha)
        ? freezeBaselineProof({
            context,
            policy,
            kind: 'pull-request',
            base,
            reason: 'recorded-pull-request-base',
          })
        : freezeBaselineProof({ context, policy, kind: 'full', reason: 'unproved-base' });
  } else if (eventName === 'push') {
    if (event.after !== sha) throw new Error('Push event and checked-out SHA disagree.');
    proof =
      frozenProof ??
      (policy.fingerprint
        ? discoverMainBaseline({
            cwd,
            context,
            policy,
            github: github ?? createGitHubClient({ cwd }),
          })
        : freezeBaselineProof({ context, policy, kind: 'full', reason: 'unavailable-ci-policy' }));
    base = proof.base;
  } else {
    proof = freezeBaselineProof({
      context,
      policy,
      kind: 'full',
      reason: 'manual-scheduled-or-unsupported-event',
    });
  }
  if (frozenProof) {
    validateFrozenBaseline({
      proof: frozenProof,
      cwd,
      context,
      policy,
      github: github ?? createGitHubClient({ cwd }),
    });
    if (JSON.stringify(proof) !== JSON.stringify(frozenProof)) {
      throw new Error('Frozen CI proof disagrees with the recorded event base.');
    }
  }
  let plan;
  if (proof.kind === 'full') {
    plan = fullPlan(sha, proof.reason);
  } else if (!SHA.test(base ?? '') || /^0+$/u.test(base) || !isAncestor(cwd, base, sha)) {
    plan = fullPlan(sha, 'unproved-base');
  } else {
    const config = await loadImpactConfig();
    const changeSet = collectGitChanges({ cwd, mode: 'range', base, head: sha });
    const impact = createImpactPlan({ config, changeSet });
    plan = selectCiLanes(impact, { base, head: sha });
  }
  // FLAG: Publishing permissions are restricted to trusted main push/manual preparation;
  // pull requests and scheduled validation must never acquire registry credentials.
  plan.lanes.registry =
    ['push', 'workflow_dispatch'].includes(context.event) &&
    context.ref === 'refs/heads/main' &&
    plan.dockerComponents.length > 0;
  plan.baselineProof = proof;
  return plan;
}

export function ciOutputs(plan) {
  return {
    plan: JSON.stringify(plan),
    ...Object.fromEntries(
      CI_LANES.map((lane) => [lane.replaceAll('-', '_'), String(plan.lanes[lane])]),
    ),
    docker_matrix: JSON.stringify({
      include: DOCKER_COMPONENTS.filter(({ component }) =>
        plan.dockerComponents.includes(component),
      ),
    }),
  };
}

export function verifyCiResults(plan, needs) {
  const expectedJobs = ['impact', ...CI_LANES].sort();
  if (!needs || JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(expectedJobs)) {
    throw new Error('Required must receive every CI lane and the impact job.');
  }
  if (needs.impact.result !== 'success')
    throw new Error('CI impact classification did not succeed.');
  // FLAG: Recompute from the exact event and Git tree, including the image
  // matrix. A green aggregate cannot stand in for an omitted selected image.
  for (const [name, value] of Object.entries(ciOutputs(plan))) {
    if (needs.impact.outputs?.[name] !== value) {
      throw new Error(`CI impact output disagrees with the independently computed plan: ${name}.`);
    }
  }
  for (const lane of CI_LANES) {
    const expected = plan.lanes[lane] ? 'success' : 'skipped';
    if (needs[lane]?.result !== expected) {
      throw new Error(
        `CI lane ${lane}: expected ${expected}, received ${needs[lane]?.result ?? 'missing'}.`,
      );
    }
  }
}

export async function runCiImpact(command, env = process.env) {
  if (!['plan', 'verify'].includes(command)) throw new Error('Expected plan or verify.');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const context = ciContext(env, event);
  const needs = command === 'verify' ? JSON.parse(env.CI_NEEDS) : null;
  const frozen = needs?.impact?.outputs?.plan;
  if (command === 'verify' && (typeof frozen !== 'string' || frozen.length > 65536)) {
    throw new Error('Required did not receive a bounded frozen impact plan.');
  }
  const recordedPlan = frozen ? JSON.parse(frozen) : null;
  if (command === 'verify' && !recordedPlan?.baselineProof) {
    throw new Error('Required did not receive the frozen baseline proof.');
  }
  const plan = await createCiPlan({
    eventName: env.GITHUB_EVENT_NAME,
    event,
    sha: env.GITHUB_SHA,
    context,
    frozenProof: recordedPlan?.baselineProof,
  });
  if (command === 'verify') {
    verifyCiResults(plan, needs);
    if (env.CI_CERTIFICATE_PATH) {
      const certificate = createMainGreenCertificate(plan);
      if (certificate)
        writeFileSync(env.CI_CERTIFICATE_PATH, `${JSON.stringify(certificate)}\n`, { mode: 0o600 });
    }
    process.stdout.write(
      'Required: every selected lane passed; every skip matches the frozen baseline and verified impact.\n',
    );
  } else {
    if (env.CI_PLAN_PATH) writeFileSync(env.CI_PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`);
    if (env.GITHUB_OUTPUT) {
      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(ciOutputs(plan))
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCiImpact(process.argv[2]).catch((error) => {
    process.stderr.write(`CI impact failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
