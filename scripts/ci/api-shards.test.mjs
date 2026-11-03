import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const jobs = parse(read('.github/workflows/ci.yml')).jobs;
const scripts = JSON.parse(read('apps/api/package.json')).scripts;
const require = createRequire(import.meta.url);
const Sequencer = require('@jest/test-sequencer').default;
const jestConfig = require(resolve(root, 'apps/api/jest.config.cjs'));

test('API matrix retains every public validation phase and waits for all parts', () => {
  const api = jobs.api;
  assert.deepEqual(api.strategy, {
    'fail-fast': false,
    matrix: { part: ['checks', '1/4', '2/4', '3/4', '4/4'] },
  });
  assert.equal(api['timeout-minutes'], 15);
  assert.equal(api.if, "needs.impact.outputs.api == 'true'");
  assert.equal(api['continue-on-error'], undefined);
  assert.ok(jobs.required.needs.includes('api'));
  const runs = api.steps.filter((step) => step.run?.startsWith('npm run'));
  assert.deepEqual(
    runs.map(({ run, if: condition }) => [run, condition]),
    [
      ['npm run check:ci:build --workspace @maxim/api', "matrix.part == 'checks'"],
      [
        'npm run test:ci --workspace @maxim/api -- -- -- --shard=${{ matrix.part }} --json --outputFile=api-tests.json',
        "matrix.part != 'checks'",
      ],
    ],
  );
  const redis = api.steps.find((step) => step.env?.MAXIM_TEST_REDIS_URL);
  assert.equal(redis.if, "matrix.part == 'checks'");
  for (const step of api.steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.if)
      assert.ok(
        [
          "matrix.part == 'checks'",
          "matrix.part != 'checks'",
          "always() && matrix.part != 'checks'",
        ].includes(step.if),
        `Unreviewed API selection: ${step.if}`,
      );
  }
  const report = api.steps.find((step) => step.name === 'Save API shard result');
  assert.equal(report.if, "always() && matrix.part != 'checks'");
  assert.equal(report.with.path, 'apps/api/api-tests.json');
});

test('split public commands keep locks, generation, types, storage tests and build', () => {
  for (const name of ['check:ci', 'check:ci:build', 'test:ci']) {
    assert.equal(
      scripts[name],
      `node ../../scripts/with-file-lock.mjs api-validation -- npm run ${name}:unlocked`,
    );
    assert.ok(scripts[`${name}:unlocked`].startsWith('npm run prepare:codegen && '));
  }
  assert.equal(scripts['test:ci:unlocked'], 'npm run prepare:codegen && npm run test:ci:source');
  const aggregate = scripts['check:ci:unlocked'].split(' && ');
  const compile = scripts['check:ci:build:unlocked'].split(' && ');
  assert.deepEqual(
    compile,
    aggregate.filter((command) => command !== 'npm run test:ci:source'),
  );
  assert.equal(aggregate.filter((command) => command === 'npm run test:ci:source').length, 1);
  assert.match(scripts['test:ci:source'], /--maxWorkers=1(?:\s|$)/u);
  assert.match(scripts['test:ci:source'], /--workerIdleMemoryLimit=768MB(?:\s|$)/u);
  assert.equal(jestConfig.testSequencer, undefined);
  assert.doesNotMatch(
    scripts['test:ci:source'],
    /--(?:forceExit|passWithNoTests|testNamePattern|shard|filter)(?:=|\s|$)/u,
  );
});

test('the default Jest partitions cover the tracked API test inventory once', async () => {
  const pattern = new RegExp(jestConfig.testRegex, 'u');
  const exclusions = [...scripts['test:ci:source'].matchAll(/--testPathIgnorePatterns=([^\s]+)/gu)];
  assert.deepEqual(
    exclusions.map((match) => match[1]),
    ['commercial-benchmark.spec.ts'],
  );
  const ignored = new RegExp(exclusions[0][1], 'u');
  const paths = execFileSync('git', ['ls-files', '-z', 'apps/api'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => pattern.test(path) && !ignored.test(path));
  assert.ok(paths.length > 1000, 'Guard against an empty or accidentally narrowed inventory');
  const context = { config: { rootDir: resolve(root, 'apps/api') } };
  const tests = paths.map((path) => ({ path: resolve(root, path), context }));
  const sequencer = new Sequencer({ contexts: [], globalConfig: {} });
  const shards = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      sequencer.shard(tests, { shardIndex: index + 1, shardCount: 4 }),
    ),
  );
  assert.ok(shards.every((part) => part.length > 0));
  assert.equal(shards.flat().length, tests.length);
  assert.deepEqual(new Set(shards.flat()), new Set(tests));
});

test('CodeQL cancels superseded PR runs while preserving main and scheduled security gates', () => {
  const codeql = parse(read('.github/workflows/codeql.yml'));
  assert.deepEqual(codeql.concurrency, {
    group: 'codeql-${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  assert.equal(codeql.jobs.analyze.name, 'Analyze JavaScript and TypeScript');
  assert.equal(codeql.jobs.analyze['continue-on-error'], undefined);
  assert.ok(
    codeql.jobs.analyze.steps.some(
      (step) => step.run === 'node scripts/ci/assert-codeql-alerts.mjs' && step.if === undefined,
    ),
  );
});
