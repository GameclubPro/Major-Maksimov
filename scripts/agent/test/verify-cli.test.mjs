import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const source = 'source.ts';
const schema = 'apps/api/prisma/schema.prisma';

test('JSON dry-run reports the selected commands without executing checks', async (t) => {
  const fixture = await createFixture(t);
  const run = invoke(fixture, ['--dry-run', '--json']);
  const result = parseResult(run, 0);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.repo, 'major');
  assert.equal(result.root, fixture.repo);
  assert.equal(result.head, git(fixture.repo, ['rev-parse', 'HEAD']).trim());
  assert.equal(result.mode, 'worktree');
  assert.equal(result.status, 'planned');
  assert.equal(result.dryRun, true);
  assert.equal(result.requiresSubmissionAggregate, true);
  assert.equal(result.requiresExactShaCi, true);
  assert.equal(result.snapshotTree, null);
  assert.equal(result.error, null);
  assert.deepEqual(result.plan.changedFiles, [source]);
  assert.deepEqual(
    result.commands.map(({ id, status }) => ({ id, status })),
    [
      { id: 'first', status: 'planned' },
      { id: 'second', status: 'planned' },
    ],
  );
  assert.deepEqual(result.commands[0], {
    id: 'first',
    kind: 'npm-script',
    executable: 'npm',
    args: ['run', 'verify:first'],
    cwd: fixture.repo,
    resources: ['checkout'],
    status: 'planned',
    exitCode: null,
    signal: null,
  });
  await assertNotRun(fixture, 'first');
  await assertNotRun(fixture, 'second');
});

test('JSON commands use the existing aggregate selection and full browser coverage', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.repo, source), 'initial source\n');
  const path = join(fixture.repo, 'scripts/agent/example.mjs');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'export const example = true;\n');
  const selected = spawnSync(
    process.execPath,
    [cli, '--repo', fixture.repo, '--dry-run', '--json'],
    {
      encoding: 'utf8',
    },
  );
  const result = parseResult(selected, 0);
  assert.ok(result.plan.checks.includes('agent-tools'));
  assert.ok(result.plan.checks.includes('repo-static'));
  assert.equal(result.commands.filter(({ id }) => id === 'repo-static').length, 1);
  assert.equal(
    result.commands.some(({ id }) => id === 'agent-tools'),
    false,
  );

  const full = parseResult(invoke(fixture, ['--full', '--dry-run', '--format', 'json']), 0);
  assert.equal(full.mode, 'full');
  assert.equal(full.plan, null);
  assert.deepEqual(
    full.commands.map(({ id }) => id),
    ['full', 'miniapp-visual-local'],
  );
});

test('JSON run keeps actual npm stdout and stderr out of its single result document', async (t) => {
  const fixture = await createFixture(t);
  const run = invoke(fixture, ['--json'], { preflight: 'pass' });
  const result = parseResult(run, 0);
  assert.equal(result.status, 'passed');
  assert.deepEqual(
    result.commands.map(({ status, exitCode }) => ({ status, exitCode })),
    [
      { status: 'passed', exitCode: 0 },
      { status: 'passed', exitCode: 0 },
    ],
  );
  assert.match(run.stderr, /fixture preflight/u);
  assert.match(run.stderr, /child stdout first/u);
  assert.match(run.stderr, /child stderr first/u);
  assert.match(run.stderr, /child stdout second/u);
  assert.equal(await readFile(join(fixture.repo, '.git/second-ran'), 'utf8'), 'yes');
});

test('JSON run records a failed child exit and leaves subsequent commands unstarted', async (t) => {
  const fixture = await createFixture(t, { first: 'process.exit(7);\n' });
  const run = invoke(fixture, ['--json'], { preflight: 'pass' });
  const result = parseResult(run, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.stage, 'command');
  assert.equal(result.error.commandId, 'first');
  assert.equal(result.commands[0].status, 'failed');
  assert.equal(result.commands[0].exitCode, 7);
  assert.equal(result.commands[1].status, 'not-run');
  await assertNotRun(fixture, 'second');
});

test('a release prefix regression blocks the staged submission before the aggregate runs', async (t) => {
  const fixture = await createFixture(t);
  const sourcePath = 'infra/scripts/lib/deploy-lock.sh';
  const earlyTest = 'infra/scripts/release-service-source-floor.test.mjs';
  await mkdir(join(fixture.repo, 'infra/scripts/lib'), { recursive: true });
  await writeFile(join(fixture.repo, sourcePath), '# Changed release boundary\n');
  await writeFile(
    join(fixture.repo, earlyTest),
    "import test from 'node:test'; test('prefix', () => { throw new Error('prefix changed'); });\n",
  );
  git(fixture.repo, ['add', source, sourcePath, earlyTest]);

  const dryRun = parseResult(invoke(fixture, ['--staged', '--dry-run', '--json']), 0);
  assert.equal(dryRun.commands[0].id, 'early-node-tests');
  assert.equal(dryRun.commands[0].status, 'planned');
  assert.ok(dryRun.commands[0].args.includes(earlyTest));

  const run = invoke(fixture, ['--staged', '--json'], { preflight: 'pass' });
  const result = parseResult(run, 2);
  assert.equal(result.error.commandId, 'early-node-tests');
  assert.equal(result.commands[0].status, 'failed');
  assert.ok(result.commands.slice(1).every(({ status }) => status === 'not-run'));
  assert.match(run.stderr, /prefix changed/u);
  await assertNotRun(fixture, 'first');
  await assertNotRun(fixture, 'second');
});

test('migration review blocks JSON execution and dry-run before running any checks', async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.repo, schema), 'model Example {\n id String @id\n age Int?\n}\n');
  for (const mode of [[], ['--dry-run']]) {
    const run = invoke(fixture, [...mode, '--json']);
    const result = parseResult(run, 2);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'MIGRATION_REVIEW_REQUIRED');
    assert.equal(result.plan.migration.reviewRequired, true);
    assert.deepEqual(result.commands, []);
    assert.doesNotMatch(run.stderr, /fixture preflight/u);
  }
  await assertNotRun(fixture, 'first');
});

test('staged drift fails before preflight and preserves both index and worktree', async (t) => {
  const fixture = await createFixture(t);
  git(fixture.repo, ['add', source]);
  const staged = git(fixture.repo, ['show', `:${source}`]);
  await writeFile(join(fixture.repo, source), 'unstaged drift\n');
  const run = invoke(fixture, ['--staged', '--json'], { preflight: 'pass' });
  const result = parseResult(run, 2);
  assert.equal(result.error.stage, 'snapshot');
  assert.equal(result.commands[0].status, 'not-run');
  assert.doesNotMatch(run.stderr, /fixture preflight/u);
  assert.equal(git(fixture.repo, ['show', `:${source}`]), staged);
  assert.equal(await readFile(join(fixture.repo, source), 'utf8'), 'unstaged drift\n');
  await assertNotRun(fixture, 'first');
});

test('index mutation after a successful command invalidates verification without the next command', async (t) => {
  const fixture = await createFixture(t, {
    first:
      "writeFileSync('source.ts', 'changed during verification\\n');\nexecFileSync('git', ['add', 'source.ts']);\n",
  });
  git(fixture.repo, ['add', source]);
  const run = invoke(fixture, ['--staged', '--json'], { preflight: 'pass' });
  const result = parseResult(run, 2);
  assert.equal(result.error.stage, 'snapshot-after-command');
  assert.equal(result.error.commandId, 'first');
  assert.equal(result.commands[0].status, 'passed');
  assert.equal(result.commands[1].status, 'not-run');
  assert.match(git(fixture.repo, ['show', `:${source}`]), /changed during verification/u);
  await assertNotRun(fixture, 'second');
});

test('range result keeps resolved plan refs distinct from checkout HEAD', async (t) => {
  const fixture = await createFixture(t);
  git(fixture.repo, ['add', source]);
  git(fixture.repo, ['commit', '-qm', 'change']);
  const run = invoke(fixture, ['--base', 'HEAD~1', '--head', 'HEAD', '--dry-run', '--json']);
  const result = parseResult(run, 0);
  assert.equal(result.mode, 'range');
  assert.equal(result.plan.source.base, git(fixture.repo, ['rev-parse', 'HEAD~1']).trim());
  assert.equal(result.plan.source.head, result.head);
  assert.deepEqual(result.plan.changedFiles, [source]);
});

test('since planning and execution include committed A and dirty B in one owned selection', async (t) => {
  const fixture = await createFixture(t);
  const base = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
  git(fixture.repo, ['add', source]);
  git(fixture.repo, ['commit', '-qm', 'committed source']);
  await writeFile(join(fixture.repo, 'README.md'), 'dirty documentation\n');
  const args = ['--since', base, '--json'];
  const planned = parseResult(invoke(fixture, [...args, '--dry-run']), 0);
  assert.equal(planned.mode, 'since');
  assert.equal(planned.plan.source.base, base);
  assert.deepEqual(planned.plan.changedFiles, ['README.md', source]);
  assert.equal(planned.commands.filter(({ id }) => id === 'first').length, 1);
  const executed = parseResult(invoke(fixture, args, { preflight: 'pass' }), 0);
  assert.equal(executed.status, 'passed');
  assert.deepEqual(executed.plan, planned.plan);
});

test('since scope never counts a committed migration deleted from the current worktree', async (t) => {
  const fixture = await createFixture(t);
  const base = git(fixture.repo, ['rev-parse', 'HEAD']).trim();
  const migration = 'apps/api/prisma/migrations/20261031_example/migration.sql';
  await mkdir(dirname(join(fixture.repo, migration)), { recursive: true });
  await writeFile(join(fixture.repo, migration), 'ALTER TABLE example ADD COLUMN age INT;\n');
  await writeFile(join(fixture.repo, schema), 'model Example {\n id String @id\n age Int?\n}\n');
  git(fixture.repo, ['add', '.']);
  git(fixture.repo, ['commit', '-qm', 'model and migration']);
  await rm(join(fixture.repo, migration));
  const result = parseResult(invoke(fixture, ['--since', base, '--dry-run', '--json']), 2);
  assert.equal(result.error.code, 'MIGRATION_REVIEW_REQUIRED');
  assert.equal(result.plan.migration.required, true);
  assert.deepEqual(result.plan.migration.migrationFiles, []);
  await assertNotRun(fixture, 'first');
});

test('preflight and invalid arguments produce failed JSON with nonzero exit', async (t) => {
  const fixture = await createFixture(t);
  const preflight = parseResult(invoke(fixture, ['--json'], { preflight: 'fail' }), 2);
  assert.equal(preflight.error.stage, 'preflight');
  assert.equal(preflight.commands[0].status, 'not-run');
  await assertNotRun(fixture, 'first');
  const invalid = parseResult(invoke(fixture, ['--staged', '--worktree', '--json']), 2);
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.error.stage, 'arguments');
});

async function createFixture(t, { first = '' } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'maxim-agent-verify-cli-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = join(repo, 'impact.json');
  const checks = [
    { id: 'first', label: 'First', script: 'verify:first' },
    { id: 'second', label: 'Second', script: 'verify:second' },
    { id: 'full', label: 'Full', script: 'verify:full' },
    { id: 'miniapp-visual-local', label: 'Browser', script: 'verify:browser' },
  ];
  const config = {
    schemaVersion: 1,
    checks,
    deployComponents: [{ id: 'api-shared', label: 'API' }],
    manualOperations: [{ id: 'review', label: 'Review' }],
    forbiddenRoutineTargetFragments: [],
    rules: [
      { id: 'source', include: [source], checks: ['first', 'second'], deployComponents: [] },
      {
        id: 'schema',
        include: [schema],
        checks: ['first'],
        deployComponents: [],
        migrationImpact: 'schema',
      },
    ],
    fallback: {
      checks: ['first'],
      deployComponents: ['api-shared'],
      warning: 'Unknown fixture path',
    },
  };
  const files = {
    'impact.json': JSON.stringify(config),
    'package.json': JSON.stringify({
      private: true,
      scripts: {
        'verify:first': 'node first.mjs',
        'verify:second': 'node second.mjs',
        'verify:full': 'node first.mjs',
        'verify:browser': 'node second.mjs',
        'check:static:ci': 'node first.mjs',
        check: 'node first.mjs',
        'screenshots:miniapp:smoke': 'node second.mjs',
      },
    }),
    [source]: 'initial source\n',
    [schema]: 'model Example {\n id String @id\n}\n',
    'first.mjs': command('first', first),
    'second.mjs': command('second', ''),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'verify@example.invalid']);
  git(repo, ['config', 'user.name', 'Verification Tests']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  await writeFile(join(repo, source), 'changed source\n');
  return { repo, configPath };
}

function command(name, extra) {
  return `import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
writeFileSync('.git/${name}-ran', 'yes');
console.log('child stdout ${name}');
console.error('child stderr ${name}');
${extra}`;
}

function invoke(fixture, args, { preflight } = {}) {
  const options = ['--repo', fixture.repo, '--config', fixture.configPath, ...args];
  if (!preflight) return spawnSync(process.execPath, [cli, ...options], { encoding: 'utf8' });
  // Exercise real npm processes and Git snapshots; only unrelated repository-wide preflight is replaced.
  const loader = `import { runVerifyCli } from ${JSON.stringify(new URL('../verify.mjs', import.meta.url).href)};
const code = await runVerifyCli(process.argv.slice(1), undefined, {
  runPreflight(root, log) { log('fixture preflight'); ${preflight === 'fail' ? "throw new Error('fixture refused');" : ''} }
});
process.exitCode = code;`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--input-type=module', '-e', loader, '--', ...options], {
    encoding: 'utf8',
    env,
  });
}

function parseResult(run, exitCode) {
  assert.equal(run.status, exitCode, run.stderr);
  return JSON.parse(run.stdout);
}

async function assertNotRun(fixture, name) {
  await assert.rejects(readFile(join(fixture.repo, `.git/${name}-ran`)), { code: 'ENOENT' });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
