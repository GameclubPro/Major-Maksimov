#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const BLOCKING_SEVERITIES = Object.freeze(['critical', 'high']);
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function requireValue(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${name} is required to verify CodeQL alerts.`);
  }
  return normalized;
}

function assertRepository(value) {
  const repository = requireValue(value, 'GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }
  return repository;
}

async function readResponseJson(response, requestUrl) {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GitHub code-scanning API failed with HTTP ${response.status} for ${requestUrl}: ${detail.slice(0, 500)}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`GitHub code-scanning API returned a non-array payload for ${requestUrl}.`);
  }
  return payload;
}

function codeScanningClient({ repository, token, fetchImpl = globalThis.fetch }) {
  const exactRepository = assertRepository(repository);
  const exactToken = requireValue(token, 'GITHUB_TOKEN');
  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch implementation is required to verify CodeQL alerts.');
  }
  return async (path, params) => {
    const requestUrl = new URL(
      `https://api.github.com/repos/${exactRepository}/code-scanning/${path}`,
    );
    requestUrl.search = new URLSearchParams(params);
    const response = await fetchImpl(requestUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${exactToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return readResponseJson(response, requestUrl);
  };
}

async function* pages(request, path, params) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await request(path, {
      ...params,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    yield batch;
    if (batch.length < PAGE_SIZE) return;
  }
  throw new Error(`CodeQL pagination for ${path} exceeded ${MAX_PAGES} pages.`);
}

export async function listBlockingCodeqlAlerts(options) {
  const ref = requireValue(options.ref, 'GITHUB_REF');
  const category = requireValue(options.category, 'CODEQL_ANALYSIS_CATEGORY');
  const request = codeScanningClient(options);
  const belongsToScan = (instance) =>
    instance?.state === 'open' && instance.ref === ref && instance.category === category;

  const alerts = [];
  for (const severity of BLOCKING_SEVERITIES) {
    const params = { state: 'open', tool_name: 'CodeQL', severity, ref };
    for await (const batch of pages(request, 'alerts', params)) {
      for (const alert of batch) {
        let instance = alert?.most_recent_instance;
        // FLAG: The most recent instance can come from a different scan category.
        // Check all instances for this ref before treating the alert as outside this gate.
        if (!belongsToScan(instance)) {
          if (!Number.isSafeInteger(alert?.number) || alert.number < 1) {
            throw new Error('GitHub returned an invalid CodeQL alert number.');
          }
          for await (const instances of pages(request, `alerts/${alert.number}/instances`, {
            ref,
          })) {
            instance = instances.find(belongsToScan);
            if (instance) break;
          }
        }
        if (instance) alerts.push({ ...alert, most_recent_instance: instance });
      }
    }
  }
  return alerts;
}

export async function assertExactCodeqlAnalysis(options) {
  const exactRef = requireValue(options.ref, 'GITHUB_REF');
  const exactSha = requireValue(options.sha, 'GITHUB_SHA');
  const category = requireValue(options.category, 'CODEQL_ANALYSIS_CATEGORY');
  const request = codeScanningClient(options);
  const analyses = await request('analyses', {
    ref: exactRef,
    tool_name: 'CodeQL',
    per_page: String(PAGE_SIZE),
  });
  const exactAnalysis = analyses.find(
    (analysis) =>
      analysis?.commit_sha === exactSha &&
      analysis?.ref === exactRef &&
      analysis?.category === category,
  );
  if (!exactAnalysis) {
    throw new Error(
      `No processed CodeQL analysis found for exact ref ${exactRef} at ${exactSha} in category ${category}.`,
    );
  }
  if (exactAnalysis.error) {
    throw new Error(`CodeQL analysis for ${exactSha} reported an error: ${exactAnalysis.error}`);
  }
  return exactAnalysis;
}

export async function assertNoBlockingCodeqlAlerts(options) {
  await assertExactCodeqlAnalysis(options);
  const alerts = await listBlockingCodeqlAlerts(options);
  if (alerts.length === 0) {
    return [];
  }

  const details = alerts
    .slice(0, 20)
    .map((alert) => {
      const number = alert?.number ?? 'unknown';
      const rule = alert?.rule?.id ?? 'unknown-rule';
      const path = alert?.most_recent_instance?.location?.path ?? 'unknown-path';
      return `#${number} ${rule} (${path})`;
    })
    .join(', ');
  throw new Error(
    `CodeQL found ${alerts.length} open high/critical alert(s) on ${options.ref}: ${details}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const alerts = await assertNoBlockingCodeqlAlerts({
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      category: process.env.CODEQL_ANALYSIS_CATEGORY,
      token: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(
      `Verified exact CodeQL analysis and 0 open high/critical alerts for ${process.env.GITHUB_SHA}.\n`,
    );
    process.exitCode = alerts.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
