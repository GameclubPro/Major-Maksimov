#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createGitHubClient,
  GITHUB_ACTIONS_APP_ID,
  GREEN_WORKFLOWS,
  proveGreenWorkflow,
  proveGreenWorkflows,
  REPOSITORY,
} from './green-workflow-proof.mjs';
export { GITHUB_ACTIONS_APP_ID } from './green-workflow-proof.mjs';

export const PRODUCTION_REQUIRED_CHECK = 'Required';
export const PRODUCTION_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: PRODUCTION_REQUIRED_CHECK, appId: GITHUB_ACTIONS_APP_ID }),
  Object.freeze({ name: 'Analyze JavaScript and TypeScript', appId: GITHUB_ACTIONS_APP_ID }),
]);

export function parseGitHubRepository(remoteUrl) {
  const match = String(remoteUrl)
    .trim()
    .match(/github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Cannot derive a GitHub repository from origin URL: ${remoteUrl}`);
  }
  return `${match[1]}/${match[2]}`;
}

export function findLatestRequiredCheck(checkRuns, sha, requiredCheck) {
  return checkRuns
    .filter(
      (run) =>
        run.name === requiredCheck.name &&
        run.head_sha === sha &&
        Number(run.app?.id) === requiredCheck.appId,
    )
    .sort((left, right) => {
      const idOrder = Number(right.id ?? 0) - Number(left.id ?? 0);
      if (idOrder !== 0) {
        return idOrder;
      }
      const startedOrder = String(right.started_at ?? '').localeCompare(
        String(left.started_at ?? ''),
      );
      return startedOrder;
    })[0];
}

export function assertGreenCheckRuns(payload, sha, requiredChecks = PRODUCTION_REQUIRED_CHECKS) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const verified = [];

  for (const requiredCheck of requiredChecks) {
    const latest = findLatestRequiredCheck(runs, sha, requiredCheck);
    if (latest?.status === 'completed' && latest.conclusion === 'success') {
      verified.push(latest);
      continue;
    }

    const named = runs.filter((run) => run.name === requiredCheck.name);
    const detail = latest
      ? `${latest.status}/${latest.conclusion ?? 'pending'}`
      : named.length
        ? named
            .map(
              (run) =>
                `head=${run.head_sha ?? 'unknown'} app=${run.app?.id ?? 'unknown'} ${run.status}/${run.conclusion ?? 'pending'}`,
            )
            .join(', ')
        : 'not found';
    throw new Error(
      `Commit ${sha} does not have a successful ${requiredCheck.name} check from app ${requiredCheck.appId} (${detail}).`,
    );
  }

  return verified;
}

export function assertCommitHasGreenCi({
  cwd = process.cwd(),
  sha,
  purpose = process.env.MAXIM_CI_PURPOSE || 'review',
  expectedCiRun,
  github = createGitHubClient({ cwd }),
}) {
  if (expectedCiRun && purpose !== 'production') {
    throw new Error('Image publication proof requires the independent production gates.');
  }
  const exactSha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
    { cwd, encoding: 'utf8' },
  ).trim();
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' });
  const repository = parseGitHubRepository(remote);
  if (
    repository !== REPOSITORY ||
    (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository)
  ) {
    throw new Error('CI evidence requires this exact GitHub repository and origin.');
  }
  // FLAG: Named green checks alone are not deployment authority. Bind both
  // gates to their approved workflow, source, current run and current attempt.
  const proofs = proveGreenWorkflows({ github, sha: exactSha, purpose });
  let publication;
  if (expectedCiRun) {
    publication = proveGreenWorkflow({
      github,
      sha: exactSha,
      workflow: GREEN_WORKFLOWS[0],
      purpose: 'publication',
      expectedRun: expectedCiRun,
    });
  }
  return {
    repository,
    sha: exactSha,
    checks: proofs.map((proof) => proof.check),
    proofs,
    ...(publication ? { publication } : {}),
  };
}

export function parseCiArguments(args, env = process.env) {
  let sha = 'HEAD';
  let hasSha = false;
  let purpose = env.MAXIM_CI_PURPOSE || 'review';
  let runId;
  let runAttempt;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (['--purpose', '--run-id', '--run-attempt'].includes(value)) {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}.`);
      if (value === '--purpose') purpose = next;
      else if (value === '--run-id') runId = Number(next);
      else runAttempt = Number(next);
    } else if (value.startsWith('-') || hasSha) {
      throw new Error(`Unknown CI assertion argument: ${value}.`);
    } else {
      sha = value;
      hasSha = true;
    }
  }
  if (!['production', 'review'].includes(purpose))
    throw new Error('Expected production or review CI purpose.');
  if (runId !== undefined || runAttempt !== undefined) {
    if (
      purpose !== 'production' ||
      !Number.isSafeInteger(runId) ||
      runId < 1 ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt < 1
    ) {
      throw new Error(
        'Image publication requires production purpose and a positive run ID/attempt pair.',
      );
    }
  }
  return {
    sha,
    purpose,
    ...(runId !== undefined ? { expectedCiRun: { id: runId, attempt: runAttempt } } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseCiArguments(process.argv.slice(2));
    const result = assertCommitHasGreenCi({ cwd: resolve(process.cwd()), ...options });
    const names = result.checks.map((check) => check.name).join(', ');
    const urls = result.checks
      .map((check) => check.html_url ?? check.details_url ?? 'success')
      .join(', ');
    process.stdout.write(`Verified ${names} for ${result.repository}@${result.sha}: ${urls}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
