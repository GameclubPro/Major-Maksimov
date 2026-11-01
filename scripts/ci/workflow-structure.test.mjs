import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test('browser setup avoids slow HTTP mirror retries in both browser lanes', () => {
  const jobs = parse(workflow).jobs;
  for (const id of ['miniapp', 'admin']) {
    const steps = jobs[id].steps;
    const index = steps.findIndex((step) => step.name === 'Use HTTPS for browser dependencies');
    assert.ok(index > 0, `${id} must prepare apt before installing Chromium`);
    const setup = steps[index];
    assert.equal(setup.if, undefined);
    assert.equal(setup['continue-on-error'], undefined);
    assert.match(setup.run, /Acquire::Languages "none"/u);
    assert.match(setup.run, /APT::Update::Error-Mode "any"/u);
    assert.equal(steps[index + 1].run, 'npx playwright install --with-deps chromium');
    assert.equal(steps[index + 1]['timeout-minutes'], 3);
    const expression = setup.run.match(/sudo sed -i -E '([^']+)'/u)?.[1];
    assert.ok(expression, 'Expected a literal, reviewable apt source rewrite');
    const input = [
      'http://azure.archive.ubuntu.com/ubuntu/',
      'https://azure.archive.ubuntu.com/ubuntu/',
      'deb http://archive.ubuntu.com/ubuntu noble main',
      'URIs: http://security.ubuntu.com/ubuntu/',
      'URIs: https://archive.ubuntu.com/ubuntu/',
      'URIs: https://packages.microsoft.com/ubuntu/24.04/prod',
      'URIs: mirror+file:/etc/apt/apt-mirrors.txt',
    ].join('\n');
    const expected = [
      'https://archive.ubuntu.com/ubuntu/',
      'https://archive.ubuntu.com/ubuntu/',
      'deb https://archive.ubuntu.com/ubuntu noble main',
      'URIs: https://security.ubuntu.com/ubuntu/',
      'URIs: https://archive.ubuntu.com/ubuntu/',
      'URIs: https://packages.microsoft.com/ubuntu/24.04/prod',
      'URIs: mirror+file:/etc/apt/apt-mirrors.txt',
    ].join('\n');
    assert.equal(execFileSync('sed', ['-E', expression], { input, encoding: 'utf8' }), expected);
  }
});

function jobBody(id, nextId) {
  const start = workflow.indexOf(`  ${id}:\n`);
  const end = workflow.indexOf(`  ${nextId}:\n`, start + 1);
  assert.notEqual(start, -1, `Missing CI job ${id}`);
  assert.notEqual(end, -1, `Missing CI job following ${id}: ${nextId}`);
  return workflow.slice(start, end);
}

test('keeps the functional API lane separate from the median commercial benchmark', () => {
  const api = jobBody('api', 'postgres-races');
  const benchmark = jobBody('commercial-benchmark', 'miniapp');

  assert.match(api, /npm run check:ci --workspace @maxim\/api/u);
  assert.match(api, /NODE_OPTIONS:\s*--max-old-space-size=6144/u);
  assert.doesNotMatch(api, /check:api|commercial-benchmark/u);
  assert.match(benchmark, /COMMERCIAL_BENCHMARK_PROFILE: github-hosted/u);
  assert.match(benchmark, /npm run test:api:commercial-benchmark:ci/u);
});

test('requires duplicate, interval, Publisher, OCR, retention and workstation Redis flows in the blocking API lane', () => {
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /redis:\s*image: redis:7-alpine/u);
  assert.match(api, /127\.0\.0\.1:6379:6379/u);
  assert.match(api, /--health-cmd "redis-cli ping"/u);
  assert.match(api, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(
    api,
    /run: npm test --workspace @maxim\/api -- 'message-duplicate\|photo-duplicate-history\.redis\|rule-engine-media-cooldown\.redis\|traffic-protection\.redis\|publisher-dispatch-health\.redis\|chat-context-cache\.redis\|publisher-refresh-operation\.redis\|publisher-access-refresh\.redis\|publisher-auto-reply-\(backlog-quota\|flood-gate\)\\\.redis-integration\\\.spec\\\.ts\$\|commercial-ocr-admission\.redis\|marketplace-publisher-access\.redis\|statistics-access-demand\.redis-integration\|retention-priority-admission\.redis-integration\|message-retention-admission\.redis-integration\|commercial-llm-workstation'/u,
  );
  assert.doesNotMatch(api, /continue-on-error|^ {6,}(?:- )?if:/mu);
  assert.equal(parse(workflow).jobs.api.if, "needs.impact.outputs.api == 'true'");
});

test('selects Publisher auto-reply native Redis suites without widening their filenames', () => {
  const steps = parse(workflow).jobs.api.steps;
  const step = steps.find((value) => value.env?.MAXIM_TEST_REDIS_URL);
  const pattern = step?.run.match(/^npm test --workspace @maxim\/api -- '([^']+)'$/u)?.[1];
  assert.ok(pattern, 'Expected the public Redis test command');
  const selection = new RegExp(pattern, 'u');
  for (const family of ['backlog-quota', 'flood-gate']) {
    const path = resolve(
      root,
      `apps/api/src/publisher/publisher-auto-reply-${family}.redis-integration.spec.ts`,
    );
    assert.ok(selection.test(path), `Missing native Publisher suite: ${family}`);
    assert.equal(selection.test(`${path}.disabled`), false);
    assert.equal(selection.test(path.replace('.redis-integration', '')), false);
  }
});

test('requires traffic revision and activation checks against local PostgreSQL', () => {
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(postgres, /MAXIM_TEST_POSTGRES_URL: \$\{\{ env\.DATABASE_URL \}\}/u);
  assert.match(
    postgres,
    /npm test --workspace @maxim\/api -- traffic-protection\.migration-integration\.spec\.ts/u,
  );
  assert.doesNotMatch(postgres, /continue-on-error/u);
});

test('requires native quarantine isolation and delayed Redis reply coverage before release', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.match(
    pkg.scripts['test:postgres-races:unlocked'],
    /webhook-dependency-quarantine-postgres\.spec\.ts/u,
  );
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(postgres, /npm run test:postgres-races --workspace @maxim\/api/u);
  assert.doesNotMatch(postgres, /continue-on-error/u);
  const required = workflow.slice(workflow.indexOf('  required:'));
  assert.match(required, /postgres-races/u);
  const api = jobBody('api', 'postgres-races');
  assert.match(api, /MAXIM_TEST_REDIS_URL:/u);
  assert.match(api, /npm test --workspace @maxim\/api -- 'message-duplicate\|/u);
});

test('native race coverage cannot silently skip its required stores or blocking lane', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  assert.ok(
    pkg.scripts['test:postgres-races:unlocked'].startsWith(
      'node ../../scripts/require-postgres-race-env.mjs && ',
    ),
  );
  const postgres = jobBody('postgres-races', 'commercial-benchmark');
  assert.match(
    postgres,
    /CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: postgresql:\/\/[^\s]+@127\.0\.0\.1:5432\//u,
  );
  assert.match(postgres, /MAXIM_TEST_REDIS_URL: redis:\/\/127\.0\.0\.1:6379/u);
  assert.match(postgres, /run: npm run test:postgres-races --workspace @maxim\/api/u);
  assert.doesNotMatch(postgres, /continue-on-error/u);
  const required = workflow.slice(workflow.indexOf('  required:'));
  assert.match(required, /postgres-races/u);
});

test('native race lane lists existing literal test paths without shell operators', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
  const command = pkg.scripts['test:postgres-races:unlocked'];
  const sections = command.split('--runTestsByPath ');
  assert.equal(sections.length, 2, 'Expected one explicit native test list');
  const paths = sections[1].trim().split(/\s+/u);
  assert.equal(new Set(paths).size, paths.length, 'Native test list contains duplicates');
  for (const path of paths) {
    assert.match(path, /^src\/[a-z0-9./-]+\.spec\.ts$/u, `Invalid native test path: ${path}`);
    assert.ok(statSync(resolve(root, 'apps/api', path)).isFile(), `Missing native test: ${path}`);
  }
  for (const path of [
    'src/max/max-fixed-moderator-assignment-postgres.spec.ts',
    'src/max/max-moderation-api-budget.redis-integration.spec.ts',
    'src/max/max-fixed-moderator-preservation-postgres.spec.ts',
    'src/webhook/webhook-multibot-fixed-fullpath.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-postgres.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-history-postgres.spec.ts',
    'src/scripts/cancel-webhook-backlog-v2-operation-plan-postgres.spec.ts',
    'src/admin/publication-admin-access-postgres.spec.ts',
    'src/publisher/publisher-binding-refresh-postgres.spec.ts',
    'src/admin/safety-desk-commercial-ai.redis-integration.spec.ts',
    'src/admin/safety-desk-commercial-ai-pool.redis-integration.spec.ts',
  ]) {
    assert.ok(paths.includes(path), `Missing critical native regression: ${path}`);
  }
});

test('isolates every native shard and keeps all compatibility checks blocking', () => {
  const jobs = parse(workflow).jobs;
  const postgres = jobs['postgres-races'];
  const shards = Array.from({ length: 8 }, (_, index) => `${index + 1}/8`);
  assert.deepEqual(postgres.strategy.matrix.shard, [...shards, 'compatibility']);
  assert.equal(postgres.strategy['fail-fast'], false);
  assert.equal(postgres['timeout-minutes'], 10);
  assert.ok(postgres.services.postgres);
  assert.ok(postgres.services.redis);
  assert.equal(postgres.needs, 'impact', 'Shards only wait for the impact plan');
  assert.equal(postgres.if, "needs.impact.outputs.postgres_races == 'true'");
  const native = postgres.steps.find((step) => step.name === 'Native race shard');
  assert.equal(native.if, "matrix.shard != 'compatibility'");
  assert.equal(
    native.run,
    'npm run test:postgres-races --workspace @maxim/api -- -- --shard=${{ matrix.shard }} --json --outputFile=postgres-races.json',
  );
  const compatibility = postgres.steps.filter(
    (step) => step.if === "matrix.shard == 'compatibility'",
  );
  assert.deepEqual(
    compatibility.map((step) => step.name),
    [
      'Outcome cohort online migrations with native PostgreSQL',
      'Selected Publisher target cancellation with native PostgreSQL',
      'Quarantine proof bounds with native PostgreSQL',
      'Shared statistics with native PostgreSQL',
      'Check traffic policy revision and activation guards',
      'Participant report SQL, shared executor, journal and retention',
      'Retention admission and receipt recovery with PostgreSQL',
      'Conservative moderation rollup compatibility with PostgreSQL',
    ],
  );
  const cancellation = compatibility.find(
    (step) => step.name === 'Selected Publisher target cancellation with native PostgreSQL',
  );
  assert.equal(cancellation.env.MAXIM_TEST_POSTGRES_URL, '${{ env.DATABASE_URL }}');
  assert.equal(cancellation.env.TZ, 'UTC');
  assert.equal(
    cancellation.run,
    'node --test --test-concurrency=1 infra/scripts/publisher-cancel-selected-targets.native.test.mjs',
  );
  for (const step of postgres.steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.if) {
      assert.ok(
        [
          "matrix.shard == 'compatibility'",
          "matrix.shard != 'compatibility'",
          "always() && matrix.shard != 'compatibility'",
        ].includes(step.if),
        `Unexpected native coverage condition: ${step.if}`,
      );
    }
  }
  assert.ok(jobs.required.needs.includes('postgres-races'));
  const gate = jobs.required.steps.find((step) => step.run === 'node scripts/ci/impact.mjs verify');
  assert.equal(gate.env.CI_NEEDS, '${{ toJSON(needs) }}');
  const report = postgres.steps.find((step) => step.name === 'Save native shard result');
  assert.equal(report.if, "always() && matrix.shard != 'compatibility'");
  assert.equal(report.with.path, 'apps/api/postgres-races.json');
});

test('shared statistics native coverage runs against required stores in the blocking compatibility shard', () => {
  const jobs = parse(workflow).jobs;
  const postgres = jobs['postgres-races'];
  const step = postgres.steps.find(
    (candidate) => candidate.name === 'Shared statistics with native PostgreSQL',
  );
  assert.ok(step, 'Missing required native statistics step');
  assert.equal(step.if, "matrix.shard == 'compatibility'");
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(step.env.MAXIM_TEST_POSTGRES_URL, '${{ env.DATABASE_URL }}');
  assert.equal(step.env.TZ, 'UTC');
  assert.equal(postgres.services.postgres.image, 'postgres:16');
  assert.equal(postgres.services.redis.image, 'redis:7-alpine');
  assert.match(postgres.env.DATABASE_URL, /@127\.0\.0\.1:5432\/race_test\?/u);
  assert.equal(postgres.env.MAXIM_TEST_REDIS_URL, 'redis://127.0.0.1:6379');
  const commands = step.run.trim().split('\n');
  assert.deepEqual(commands, [
    "npm test --workspace @maxim/api -- 'integrations/(marketplace|karavan-marketplace)/.*postgres|statistics/.*postgres'",
    'node --test --test-concurrency=1 infra/scripts/statistics-exchange-audit.test.mjs infra/scripts/central-statistics-audit.test.mjs',
  ]);
  const selector = commands[0].match(/-- '([^']+)'$/u)?.[1];
  assert.ok(selector);
  const nativePath = 'src/integrations/marketplace/statistics-exchange-postgres.spec.ts';
  assert.ok(new RegExp(selector, 'u').test(nativePath), 'Exchange cases must be selected');
  assert.ok(statSync(resolve(root, 'apps/api', nativePath)).isFile());
  const centralPaths = readdirSync(resolve(root, 'apps/api/src/statistics'))
    .filter((name) => name.endsWith('-postgres.spec.ts'))
    .map((name) => `src/statistics/${name}`);
  assert.ok(
    centralPaths.length >= 3,
    'Expected central store, native adapter and exact counter suites',
  );
  for (const path of centralPaths)
    assert.ok(new RegExp(selector, 'u').test(path), `Missing native statistics suite: ${path}`);
  const karavanPaths = readdirSync(resolve(root, 'apps/api/src/integrations/karavan-marketplace'))
    .filter((name) => name.endsWith('-postgres.spec.ts'))
    .map((name) => `src/integrations/karavan-marketplace/${name}`);
  assert.ok(karavanPaths.length >= 2, 'Expected marketplace authority and private choice suites');
  for (const path of karavanPaths)
    assert.ok(new RegExp(selector, 'u').test(path), `Missing native marketplace suite: ${path}`);
  assert.ok(jobs.required.needs.includes('postgres-races'));
});
