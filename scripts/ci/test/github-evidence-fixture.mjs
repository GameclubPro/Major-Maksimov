import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  GREEN_WORKFLOWS,
  GITHUB_ACTIONS_APP_ID,
  REPOSITORY,
  REPOSITORY_ID,
} from '../green-workflow-proof.mjs';

export function workflowRun(
  sha,
  {
    workflow = GREEN_WORKFLOWS[0],
    id = workflow.id,
    attempt = 1,
    event = 'push',
    branch = 'main',
    conclusion = 'success',
    status = 'completed',
  } = {},
) {
  const run = {
    id,
    workflow_id: workflow.id,
    path: workflow.path,
    head_sha: sha,
    head_branch: branch,
    event,
    run_attempt: attempt,
    check_suite_id: id + 10000,
    status,
    conclusion,
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
  };
  const job = {
    id: id + 20000,
    run_id: id,
    run_attempt: attempt,
    head_sha: sha,
    name: workflow.check,
    status,
    conclusion,
    check_run_url: `https://api.github.com/repos/${REPOSITORY}/check-runs/${id + 30000}`,
  };
  const check = {
    id: id + 30000,
    name: workflow.check,
    head_sha: sha,
    status,
    conclusion,
    app: { id: GITHUB_ACTIONS_APP_ID },
    check_suite: { id: run.check_suite_id },
    details_url: `https://github.com/${REPOSITORY}/actions/runs/${id}/job/${job.id}`,
  };
  return { run, jobs: [job], checks: [check] };
}

// Ordinary ZIP local header + central directory. CRC is irrelevant to the
// bounded in-memory JSON reader; the artifact SHA binds the whole archive.
export function jsonZip(filename, value, { method = 8 } = {}) {
  const name = Buffer.from(filename);
  const body = Buffer.from(JSON.stringify(value));
  const data = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

export function certificateArtifact(evidence, certificate, id = 50000) {
  const run = evidence.run;
  const name = `ci-main-green-${run.head_sha}-${run.id}-${run.run_attempt}`;
  const archive = jsonZip('main-green.json', certificate);
  return {
    archive,
    artifact: {
      id,
      name,
      expired: false,
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
      workflow_run: {
        id: run.id,
        head_sha: run.head_sha,
        head_branch: 'main',
        repository_id: REPOSITORY_ID,
        head_repository_id: REPOSITORY_ID,
      },
    },
  };
}

export function githubEvidence({ runs = [], artifacts = [] } = {}) {
  const calls = [];
  const page = (key, items, url) => ({
    total_count: items.length,
    [key]: items.slice(
      (Number(url.searchParams.get('page') || 1) - 1) * 100,
      Number(url.searchParams.get('page') || 1) * 100,
    ),
  });
  return {
    calls,
    json(endpoint) {
      calls.push(endpoint);
      const url = new URL(`https://api.github.com/${endpoint}`);
      const path = url.pathname.replace(`/repos/${REPOSITORY}`, '');
      let result;
      let match;
      if ((match = path.match(/^\/actions\/workflows\/(\d+)\/runs$/u))) {
        result = page(
          'workflow_runs',
          runs
            .map((entry) => entry.run)
            .filter(
              (run) =>
                run.workflow_id === Number(match[1]) &&
                run.head_sha === url.searchParams.get('head_sha'),
            ),
          url,
        );
      } else if ((match = path.match(/^\/actions\/runs\/(\d+)$/u))) {
        result = runs.find((entry) => entry.run.id === Number(match[1]))?.run;
      } else if ((match = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u))) {
        result = page(
          'jobs',
          runs.find(
            (entry) =>
              entry.run.id === Number(match[1]) && entry.run.run_attempt === Number(match[2]),
          )?.jobs ?? [],
          url,
        );
      } else if ((match = path.match(/^\/check-suites\/(\d+)\/check-runs$/u))) {
        result = page(
          'check_runs',
          runs.find((entry) => entry.run.check_suite_id === Number(match[1]))?.checks ?? [],
          url,
        );
      } else if ((match = path.match(/^\/actions\/runs\/(\d+)\/artifacts$/u))) {
        result = page(
          'artifacts',
          artifacts
            .map((entry) => entry.artifact)
            .filter((artifact) => artifact.workflow_run.id === Number(match[1])),
          url,
        );
      }
      if (!result) throw new Error(`Unexpected evidence request: ${endpoint}`);
      return structuredClone(result);
    },
    binary(endpoint) {
      calls.push(endpoint);
      const match = endpoint.match(/\/actions\/artifacts\/(\d+)\/zip$/u);
      const found = artifacts.find((entry) => entry.artifact.id === Number(match?.[1]));
      if (!found) throw new Error(`Unexpected archive request: ${endpoint}`);
      return found.archive;
    },
  };
}
