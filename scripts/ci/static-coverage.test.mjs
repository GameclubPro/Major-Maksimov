import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_LANES } from './impact.mjs';
import { validateImpactConfig } from '../agent/impact-config.mjs';
import { selectVerificationScripts } from '../agent/verify.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts;
const impactConfig = validateImpactConfig(JSON.parse(read('config/change-impact.json')));
const workflow = read('.github/workflows/ci.yml');
const testPrefix = 'node --test --test-concurrency=2 ';
const staticPrefix = 'npm run lint && npm run check:refactor-guards && ';
const fullGlobs = [
  'scripts/*.test.mjs',
  'scripts/agent/test/*.test.mjs',
  'scripts/ci/*.test.mjs',
  'infra/scripts/*.test.mjs',
];

function parseTestGlobs(command) {
  assert.equal(typeof command, 'string');
  assert.equal(command, command.trim(), 'Unsupported command whitespace');
  assert.ok(command.startsWith(testPrefix), 'Expected the bounded public Node test command');
  const globs = command.slice(testPrefix.length).split(' ');
  for (const glob of globs) {
    assert.match(glob, /^(?:[a-z0-9-]+\/)+\*\.test\.mjs$/u, 'Unsupported test command grammar');
  }
  assert.equal(new Set(globs).size, globs.length, 'Duplicate test glob');
  return globs;
}

function expandTestGlobs(globs) {
  const files = globs.flatMap((glob) => {
    const directory = glob.slice(0, -'/*.test.mjs'.length);
    const entries = readdirSync(resolve(root, directory), { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith('.') && entry.name.endsWith('.test.mjs'),
    );
    assert.ok(entries.length > 0, `Empty test glob: ${glob}`);
    return entries.map((entry) => {
      assert.ok(entry.isFile(), `Test glob selects a non-file: ${directory}/${entry.name}`);
      return `${directory}/${entry.name}`;
    });
  });
  assert.equal(new Set(files).size, files.length, 'A test file is selected more than once');
  return files.sort();
}

function jobBody(id) {
  const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)];
  const indexes = jobs.flatMap((entry, index) => (entry[1] === id ? [index] : []));
  assert.equal(indexes.length, 1, `Expected exactly one CI job: ${id}`);
  const index = indexes[0];
  return workflow.slice(jobs[index].index, jobs[index + 1]?.index ?? workflow.length);
}

test('preserves full public aggregates and the bounded core selection', () => {
  assert.equal(scripts['test:agent-tools'], `${testPrefix}${fullGlobs.join(' ')}`);
  assert.equal(scripts['check:static'], `${staticPrefix}npm run test:agent-tools`);
  assert.equal(scripts['check:static:ci'], `${staticPrefix}npm run test:agent-tools:core`);
  assert.equal(scripts['check:infra'], 'bash infra/scripts/check-infra.sh');
  assert.deepEqual(parseTestGlobs(scripts['test:agent-tools:core']), fullGlobs.slice(0, -1));
});

test('Static gives core and infrastructure independent bounded jobs without dropping full coverage', () => {
  const job = parse(workflow).jobs.static;
  assert.deepEqual(job.strategy, {
    'fail-fast': false,
    matrix: {
      include:
        '${{ fromJSON(needs.impact.outputs.plan).mode == \'full\' && fromJSON(\'[{"part":"core"},{"part":"infra","shard":"1/2"},{"part":"infra","shard":"2/2"}]\') || fromJSON(\'[{"part":"core"}]\') }}',
    },
  });
  assert.equal(job['timeout-minutes'], 12);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.if, undefined);
});

test('CI core and standalone infrastructure select the full inventory exactly once', () => {
  const infra = read('infra/scripts/check-infra.sh');
  assert.match(infra, /^set -euo pipefail$/mu);
  const commands = infra.split(/\r?\n/u).filter((line) => /^node --test(?: |$)/u.test(line));
  assert.equal(commands.length, 1, 'Expected one standalone infrastructure test invocation');
  assert.equal(commands[0], testPrefix + '"${infra_test_args[@]}" infra/scripts/*.test.mjs');
  const infraGlobs = parseTestGlobs(commands[0].replace(' "${infra_test_args[@]}"', ''));
  assert.deepEqual(infraGlobs, ['infra/scripts/*.test.mjs']);
  const full = expandTestGlobs(parseTestGlobs(scripts['test:agent-tools']));
  const core = expandTestGlobs(parseTestGlobs(scripts['test:agent-tools:core']));
  const infrastructure = expandTestGlobs(infraGlobs);
  const infrastructureSet = new Set(infrastructure);
  assert.deepEqual(
    core.filter((file) => infrastructureSet.has(file)),
    [],
    'Infrastructure tests must not also execute in the CI core aggregate',
  );
  assert.deepEqual([...core, ...infrastructure].sort(), full);
  assert.ok(core.includes('scripts/ci/static-coverage.test.mjs'), 'This guard must run in CI');
});

test('infrastructure shard selection fails closed before preflight and preserves Node partitions', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-infra-shard-'));
  try {
    const script = resolve(root, 'infra/scripts/check-infra.sh');
    for (const shard of ['0/2', '3/2', '1/3', '1', '1/2 extra', '../1/2']) {
      const invalid = spawnSync('/bin/bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: directory, MAXIM_INFRA_TEST_SHARD: shard },
        timeout: 1000,
      });
      assert.equal(
        invalid.status,
        2,
        `Reject unsupported shard before external commands: ${shard}`,
      );
      assert.match(invalid.stderr, /Invalid MAXIM_INFRA_TEST_SHARD/u);
      assert.doesNotMatch(invalid.stderr, /command not found/u);
    }
    const files = Array.from({ length: 8 }, (_, index) => `fixture-${index}.test.mjs`);
    for (const file of files)
      writeFileSync(resolve(directory, file), `console.log('SHARD_FIXTURE:${file}');\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const selected = (shard) => {
      const run = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-concurrency=2',
          '--test-reporter=tap',
          ...(shard ? [`--test-shard=${shard}`] : []),
          ...files,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env,
          timeout: 10000,
        },
      );
      assert.equal(run.status, 0, run.stderr);
      return [...run.stdout.matchAll(/SHARD_FIXTURE:(fixture-\d\.test\.mjs)/gu)]
        .map((match) => match[1])
        .sort();
    };
    const full = selected();
    const first = selected('1/2');
    const second = selected('2/2');
    assert.deepEqual(full, files);
    assert.equal(first.length, 4);
    assert.equal(second.length, 4);
    assert.deepEqual(
      first.filter((file) => second.includes(file)),
      [],
    );
    assert.deepEqual([...first, ...second].sort(), full);
    const infra = read('infra/scripts/check-infra.sh');
    assert.match(infra, /infra_test_args=\(\)/u);
    assert.match(
      infra,
      /1\/2\|2\/2\) infra_test_args\+=\("--test-shard=\$\{MAXIM_INFRA_TEST_SHARD\}"\)/u,
    );
    assert.ok(
      infra.indexOf('Invalid MAXIM_INFRA_TEST_SHARD') <
        infra.indexOf('generate-deploy-impact-bash.mjs'),
    );
    const steps = parse(workflow).jobs.static.steps;
    assert.equal(
      steps.find((step) => step.run === 'npm run check:infra').env.MAXIM_INFRA_TEST_SHARD,
      '${{ matrix.shard }}',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('local selection covers core tooling and adds the complete selected infrastructure once', () => {
  const full = expandTestGlobs(parseTestGlobs(scripts['test:agent-tools']));
  const core = expandTestGlobs(parseTestGlobs(scripts['test:agent-tools:core']));
  const infrastructure = expandTestGlobs(['infra/scripts/*.test.mjs']);
  const inventories = new Map([
    ['check:static', full],
    ['check:static:ci', core],
    ['test:agent-tools', full],
    ['test:agent-tools:core', core],
    ['check:infra', infrastructure],
  ]);
  for (const [checks, expected] of [
    [['repo-static'], core],
    [['agent-tools'], core],
    [['repo-static', 'agent-tools'], core],
    [['repo-static', 'infra'], full],
    [['repo-static', 'agent-tools', 'infra'], full],
    [['agent-tools', 'infra'], full],
  ]) {
    const selected = selectVerificationScripts({ config: impactConfig, plan: { checks } });
    const files = selected.flatMap(({ script }) => {
      assert.ok(inventories.has(script), `Unreviewed local tooling aggregate: ${script}`);
      return inventories.get(script);
    });
    assert.equal(new Set(files).size, files.length, `${checks}: repeated test files`);
    assert.deepEqual(files.sort(), expected, checks.join(', '));
  }
});

test('inventory parser rejects shell wrappers, skip flags and unsupported globs', () => {
  for (const command of [
    `env ${testPrefix}scripts/*.test.mjs`,
    `${testPrefix}scripts/*.test.mjs || true`,
    `${testPrefix}--test-skip-pattern=slow scripts/*.test.mjs`,
    `${testPrefix}scripts/**/*.test.mjs`,
    `${testPrefix}../scripts/*.test.mjs`,
    `${testPrefix}scripts/*.test.mjs scripts/*.test.mjs`,
    `${testPrefix}scripts/*.test.mjs\n`,
  ]) {
    assert.throws(() => parseTestGlobs(command));
  }
});

test('Static runs mandatory ShellCheck once through the infrastructure owner', () => {
  const steps = parse(workflow).jobs.static.steps;
  assert.equal(
    steps.filter((step) => typeof step.run === 'string' && /shellcheck/u.test(step.run)).length,
    0,
    'The workflow must not repeat ShellCheck already owned by check:infra',
  );
  assert.equal(steps.filter((step) => step.run === 'npm run check:infra').length, 1);
  const infra = read('infra/scripts/check-infra.sh');
  assert.match(infra, /if command -v shellcheck >/u);
  assert.match(infra, /find infra\/scripts -type f -name '\*\.sh' -print0 \| xargs -0 shellcheck/u);
  assert.match(infra, /npx --yes --package=shellcheck@4\.1\.0 -- shellcheck/u);
  assert.match(infra, /shellcheck is required for infrastructure validation\.[\s\S]*?exit 1/u);
  assert.doesNotMatch(infra, /shellcheck[^\n]*\|\|\s*(?:true|:)/u);
});

test('Static keeps its budget, core checks and infrastructure coverage for full plans', () => {
  const job = jobBody('static');
  assert.match(
    job,
    /^ {4}name: Static \(\$\{\{ matrix\.part \}\}\$\{\{ matrix\.shard && format\(' \{0\}', matrix\.shard\) \|\| '' \}\}\)$/mu,
  );
  assert.deepEqual(
    [...job.matchAll(/^ {4}timeout-minutes: (.+)$/gmu)].map((entry) => entry[1]),
    ['12'],
  );
  assert.doesNotMatch(job, /^\s*(?:-\s*)?(?:continue-on-error|shell|working-directory):/mu);
  const parsed = parse(workflow).jobs.static;
  assert.equal(parsed.needs, 'impact');
  assert.equal(parsed.if, undefined);
  const redisSetup = parsed.steps.find(
    (step) => step.name === 'Prepare private Redis infrastructure fixtures',
  );
  assert.match(redisSetup.run, /command -v redis-server/u);
  assert.match(redisSetup.run, /apt-get install -y --no-install-recommends redis-server/u);
  assert.ok(
    parsed.steps.indexOf(redisSetup) <
      parsed.steps.findIndex((step) => step.run === 'npm run check:infra'),
    'Native Redis must be available before the infrastructure race fixtures',
  );
  const infrastructure = new Set([
    'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7',
    redisSetup.run,
    'npm run check:infra',
  ]);
  const core = new Set([
    'npm audit --omit=dev --audit-level=high',
    'npm run check:static:ci',
    'npm run check:docs',
  ]);
  for (const step of parsed.steps) {
    assert.equal(
      step.if,
      infrastructure.has(step.run)
        ? "matrix.part == 'infra'"
        : core.has(step.run)
          ? "matrix.part == 'core'"
          : undefined,
    );
    assert.equal(step['continue-on-error'], undefined);
  }
  const runs = [...job.matchAll(/^ {6}(?:- | {2})run: (.+)$/gmu)].map((entry) => entry[1]);
  assert.deepEqual(runs, [
    'npm ci --no-audit',
    'node scripts/agent/preflight.mjs',
    'npm audit --omit=dev --audit-level=high',
    'npm run check:static:ci',
    'npm run check:docs',
    'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7',
    '|',
    'npm run check:infra',
  ]);
});

test('CI installation jobs leave dependency auditing to the required Static gate', () => {
  const installs = [...workflow.matchAll(/^ {6}- run: (npm ci(?: .*)?)$/gmu)].map(
    (entry) => entry[1],
  );
  assert.deepEqual(installs, Array(8).fill('npm ci --no-audit'));
  const audits = [...workflow.matchAll(/^ {6}(?:- | {2})run: (npm audit(?: .*)?)$/gmu)].map(
    (entry) => entry[1],
  );
  assert.deepEqual(audits, ['npm audit --omit=dev --audit-level=high']);
});

test('Required still rejects any non-successful Static result', () => {
  const job = parse(workflow).jobs.required;
  assert.equal(job.name, 'Required');
  assert.equal(job.if, 'always()');
  assert.deepEqual([...job.needs].sort(), ['impact', ...CI_LANES].sort());
  assert.equal(job['continue-on-error'], undefined);
  for (const step of job.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
  const commands = job.steps.filter((step) => step.run);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].run, 'node scripts/ci/impact.mjs verify');
  assert.equal(commands[0].env.CI_NEEDS, '${{ toJSON(needs) }}');
});
