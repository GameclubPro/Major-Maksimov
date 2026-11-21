import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactCodeqlAnalysis,
  assertNoBlockingCodeqlAlerts,
  listBlockingCodeqlAlerts,
} from './assert-codeql-alerts.mjs';

const ref = 'refs/heads/main';
const category = '.github/workflows/codeql.yml:analyze';
const fullCategory = '.github/workflows/codeql-full.yml:analyze';
const sha = 'a'.repeat(40);
const options = { repository: 'GameclubPro/MAXIM', ref, category, sha, token: 'test-token' };

function instance(scanCategory = category, overrides = {}) {
  return { ref, category: scanCategory, state: 'open', ...overrides };
}

function response(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => payload,
    text: async () => options.text ?? JSON.stringify(payload),
  };
}

test('queries exact ref for both blocking severities with authenticated pagination', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    most_recent_instance: instance(category, { ref: 'refs/pull/18/merge' }),
  }));
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.searchParams.get('severity') === 'high' && url.searchParams.get('page') === '1') {
      return response(firstPage);
    }
    if (url.searchParams.get('severity') === 'high') {
      return response([{ ...firstPage[0], number: 101 }]);
    }
    return response([]);
  };

  const alerts = await listBlockingCodeqlAlerts({
    ...options,
    ref: 'refs/pull/18/merge',
    fetchImpl,
  });

  assert.equal(alerts.length, 101);
  assert.deepEqual(
    requests.map(({ url }) => [
      url.searchParams.get('severity'),
      url.searchParams.get('ref'),
      url.searchParams.get('page'),
    ]),
    [
      ['critical', 'refs/pull/18/merge', '1'],
      ['high', 'refs/pull/18/merge', '1'],
      ['high', 'refs/pull/18/merge', '2'],
    ],
  );
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, 'Bearer test-token');
    assert.equal(request.url.searchParams.get('tool_name'), 'CodeQL');
  }
});

test('rejects open alerts with actionable rule and path details', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/analyses')) {
      return response([{ commit_sha: sha, error: '', ref, category }]);
    }
    return response(
      url.searchParams.get('severity') === 'high'
        ? [
            {
              number: 15,
              rule: { id: 'js/polynomial-redos' },
              most_recent_instance: instance(category, {
                location: { path: 'apps/api/src/max/max-client.service.ts' },
              }),
            },
          ]
        : [],
    );
  };

  await assert.rejects(
    () => assertNoBlockingCodeqlAlerts({ ...options, fetchImpl }),
    /#15 js\/polynomial-redos \(apps\/api\/src\/max\/max-client\.service\.ts\)/u,
  );
});

test('requires a processed analysis for the exact ref, SHA and scan category', async () => {
  const exact = { commit_sha: sha, error: '', ref, category };
  const otherAnalyses = [
    { ...exact, category: fullCategory },
    { ...exact, commit_sha: 'b'.repeat(40) },
    { ...exact, ref: 'refs/heads/topic' },
  ];
  await assert.rejects(
    () =>
      assertExactCodeqlAnalysis({
        ...options,
        fetchImpl: async () => response(otherAnalyses),
      }),
    /No processed CodeQL analysis found.*a{40}/u,
  );
  assert.deepEqual(
    await assertExactCodeqlAnalysis({
      ...options,
      fetchImpl: async () => response([...otherAnalyses, exact]),
    }),
    exact,
  );
});

test('blocks a shared alert even when the most recent instance comes from the full scan', async () => {
  const fullInstance = instance(fullCategory, {
    location: { path: 'apps/api/src/__fixtures__/input.ts' },
  });
  const focusedInstance = instance(category, {
    location: { path: 'apps/api/src/max/max-client.service.ts' },
  });
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('ref'), ref);
    if (url.pathname.endsWith('/alerts/17/instances')) {
      return response([fullInstance]);
    }
    if (url.pathname.endsWith('/alerts/18/instances')) {
      return response([fullInstance, instance(category, { state: 'fixed' })]);
    }
    if (url.pathname.endsWith('/alerts/19/instances')) {
      return response(
        url.searchParams.get('page') === '1' ? Array(100).fill(fullInstance) : [focusedInstance],
      );
    }
    assert.ok(url.pathname.endsWith('/alerts'));
    return response(
      url.searchParams.get('severity') === 'high'
        ? [17, 18, 19].map((number) => ({ number, most_recent_instance: fullInstance }))
        : [],
    );
  };

  const alerts = await listBlockingCodeqlAlerts({ ...options, fetchImpl });
  assert.deepEqual(alerts, [{ number: 19, most_recent_instance: focusedInstance }]);
});

test('fails closed on missing configuration and GitHub API errors', async () => {
  await assert.rejects(
    () =>
      listBlockingCodeqlAlerts({
        ...options,
        repository: 'invalid',
      }),
    /Invalid GITHUB_REPOSITORY/u,
  );
  await assert.rejects(
    () =>
      listBlockingCodeqlAlerts({
        ...options,
        fetchImpl: async () => response({}, { ok: false, status: 403, text: 'forbidden' }),
      }),
    /HTTP 403.*forbidden/u,
  );
});
