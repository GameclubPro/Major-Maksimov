import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseFocusedArgs, selectFocusedCommands } from '../focused.mjs';

const cli = fileURLToPath(new URL('../focused.mjs', import.meta.url));

test('focused parsing requires explicit tests and rejects unknown arguments', () => {
  assert.throws(() => parseFocusedArgs(['--json']), /at least one/u);
  assert.throws(() => parseFocusedArgs(['--test', '--json']), /requires a value/u);
  assert.throws(() => parseFocusedArgs(['--full']), /Unknown/u);
  assert.equal(
    parseFocusedArgs(['--test', 'scripts/a.test.mjs', '--format', 'json']).format,
    'json',
  );
});

test('focused selection groups supported families and keeps public API generation locks', async (t) => {
  const repo = await fixture(t);
  const tests = [
    'scripts/a.test.mjs',
    'scripts/a.test.mjs',
    'infra/scripts/b.test.mjs',
    'apps/miniapp/test/a.test.ts',
    'apps/admin/test/a.test.ts',
    'apps/api/src/a.spec.ts',
    'packages/contracts/test/a.spec.ts',
  ];
  const commands = await selectFocusedCommands(repo, tests);
  assert.deepEqual(
    commands.map(({ id }) => id),
    ['node-tests', 'miniapp-tests', 'admin-tests', 'api-tests', 'contracts-tests'],
  );
  assert.deepEqual(commands[0].args, [
    '--test',
    '--test-concurrency=2',
    'scripts/a.test.mjs',
    'infra/scripts/b.test.mjs',
  ]);
  assert.deepEqual(commands[1].args, [
    'exec',
    '--offline',
    '--no',
    '--workspace',
    '@maxim/miniapp',
    '--',
    'tsx',
    '--test',
    'test/a.test.ts',
  ]);
  assert.deepEqual(commands[3].args, [
    'run',
    'test',
    '--workspace',
    '@maxim/api',
    '--',
    '--',
    '--',
    '--runTestsByPath',
    'src/a.spec.ts',
  ]);
  for (const command of commands) {
    assert.equal(command.cwd, repo);
    assert.equal(command.status, 'not-run');
    assert.equal(
      command.args.some((arg) => /:(?:unlocked|source)$/u.test(arg)),
      false,
    );
  }
});

test('unsupported, missing, traversing and externally linked tests fail closed', async (t) => {
  const repo = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'maxim-focused-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'test.mjs'), '');
  await symlink(join(outside, 'test.mjs'), join(repo, 'scripts/link.test.mjs'));
  for (const path of [
    'scripts/unknown.mjs',
    'scripts/missing.test.mjs',
    '../outside.test.mjs',
    '/tmp/test.mjs',
    'scripts/link.test.mjs',
  ]) {
    await assert.rejects(selectFocusedCommands(repo, [path]));
  }
  const run = invoke(repo, ['--test', 'scripts/unknown.mjs', '--dry-run', '--json']);
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.commands, []);
});

test('focused JSON dry-run does not execute and actual child logs stay in stderr', async (t) => {
  const repo = await fixture(t);
  const args = ['--test', 'scripts/a.test.mjs', '--json'];
  const planned = invoke(repo, [...args, '--dry-run']);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.mode, 'focused');
  assert.equal(plan.status, 'planned');
  assert.equal(plan.commands[0].status, 'planned');
  assert.equal(plan.requiresSubmissionAggregate, true);
  assert.deepEqual(plan.tests, ['scripts/a.test.mjs']);
  await assert.rejects(readFile(join(repo, '.git/ran')));
  const run = invoke(repo, args);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'passed');
  assert.match(run.stderr, /selected test output/u);
  assert.match(run.stderr, /selected test error/u);
  assert.equal(await readFile(join(repo, '.git/ran'), 'utf8'), 'yes');
});

test('an API type failure stops a typed focused run before Jest', async (t) => {
  const repo = await fixture(t);
  await writeFile(join(repo, 'apps/api/typecheck.cjs'), 'process.exitCode = 8;');
  const run = invoke(repo, ['--typecheck', '--test', 'apps/api/src/a.spec.ts', '--json']);
  assert.equal(run.status, 2, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(
    result.commands.map(({ id, status }) => [id, status]),
    [
      ['api-typecheck', 'failed'],
      ['api-tests', 'not-run'],
    ],
  );
  await assert.rejects(readFile(join(repo, '.git/argv.json')), { code: 'ENOENT' });
});

test('public API npm chain forwards only the selected Jest paths after preparation', async (t) => {
  const repo = await fixture(t);
  const run = invoke(repo, ['--test', 'apps/api/src/a.spec.ts', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'passed');
  assert.equal(await readFile(join(repo, '.git/prepared'), 'utf8'), 'yes');
  assert.deepEqual(JSON.parse(await readFile(join(repo, '.git/argv.json'), 'utf8')), [
    '--runTestsByPath',
    'src/a.spec.ts',
  ]);
});

test('public contracts npm chain retains its build owner and selected Vitest paths', async (t) => {
  const repo = await fixture(t);
  const run = invoke(repo, ['--test', 'packages/contracts/test/a.spec.ts', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'passed');
  assert.equal(await readFile(join(repo, '.git/contracts-built'), 'utf8'), 'yes');
  assert.deepEqual(JSON.parse(await readFile(join(repo, '.git/contracts-argv.json'), 'utf8')), [
    'test/a.spec.ts',
  ]);
});

test('native selection exposes required stores and refuses missing or mismatched environment', async (t) => {
  const repo = await fixture(t);
  await writeFile(
    join(repo, 'apps/api/src/a.spec.ts'),
    'const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL; const redisUrl = process.env.MAXIM_TEST_REDIS_URL;\n',
  );
  const args = ['--test', 'apps/api/src/a.spec.ts', '--json'];
  const planned = JSON.parse(invoke(repo, [...args, '--dry-run']).stdout);
  assert.equal(planned.requiresTestStores, true);
  assert.deepEqual(planned.commands[0].resources, ['checkout', 'postgres', 'redis']);
  const env = { ...process.env };
  for (const name of [
    'NODE_TEST_CONTEXT',
    'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL',
    'MAXIM_TEST_REDIS_URL',
  ])
    delete env[name];
  const run = spawnSync(process.execPath, [cli, '--repo', repo, ...args], {
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.error.stage, 'native-environment');
  assert.equal(result.commands[0].status, 'not-run');
  await assert.rejects(readFile(join(repo, '.git/prepared')));
  await writeFile(
    join(repo, 'apps/api/src/a.spec.ts'),
    'const reference = "process.env.DATABASE_URL"; // process.env.MAXIM_TEST_REDIS_URL\n',
  );
  assert.equal(JSON.parse(invoke(repo, [...args, '--dry-run']).stdout).requiresTestStores, false);
});

test('literal membership in the maintained native lane also requires stores', async (t) => {
  const repo = await fixture(t);
  const packagePath = join(repo, 'apps/api/package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  manifest.scripts['test:postgres-races:unlocked'] =
    'node guard.mjs && npm run prepare:codegen && jest --runTestsByPath src/a.spec.ts';
  await writeFile(packagePath, JSON.stringify(manifest));
  const result = JSON.parse(
    invoke(repo, ['--test', 'apps/api/src/a.spec.ts', '--dry-run', '--json']).stdout,
  );
  assert.equal(result.requiresTestStores, true);
});

test('focused failure reports the failed command and never executes another family', async (t) => {
  const repo = await fixture(t);
  await writeFile(
    join(repo, 'scripts/a.test.mjs'),
    "import test from 'node:test'; test('failure', () => { throw new Error('expected fixture failure'); });\n",
  );
  const run = invoke(repo, [
    '--test',
    'scripts/a.test.mjs',
    '--test',
    'apps/api/src/a.spec.ts',
    '--json',
  ]);
  assert.equal(run.status, 2);
  const result = JSON.parse(run.stdout);
  assert.equal(result.commands[0].status, 'failed');
  assert.equal(result.commands[1].status, 'not-run');
  await assert.rejects(readFile(join(repo, '.git/prepared')));
});

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'maxim-focused-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({
      private: true,
      workspaces: ['apps/api', 'apps/miniapp', 'apps/admin', 'packages/contracts'],
      scripts: { 'typecheck:api': 'npm run typecheck --workspace @maxim/api' },
    }),
    'apps/miniapp/package.json': JSON.stringify({
      name: '@maxim/miniapp',
      scripts: { test: 'tsx --test ./test/*.test.ts' },
    }),
    'apps/admin/package.json': JSON.stringify({
      name: '@maxim/admin',
      scripts: { test: 'tsx --test ./test/*.test.ts' },
    }),
    'apps/api/package.json': JSON.stringify({
      name: '@maxim/api',
      scripts: {
        test: 'node ../../scripts/with-file-lock.mjs api-validation -- npm run test:unlocked',
        'test:unlocked': 'npm run prepare:codegen && npm run test:source',
        'prepare:codegen': 'node prepare.cjs',
        'test:source': 'node record.cjs',
        typecheck: 'node typecheck.cjs',
      },
    }),
    'apps/api/prepare.cjs': "require('node:fs').writeFileSync('../../.git/prepared', 'yes');\n",
    'apps/api/record.cjs':
      "require('node:fs').writeFileSync('../../.git/argv.json', JSON.stringify(process.argv.slice(2)));\n",
    'apps/api/src/a.spec.ts': '',
    'packages/contracts/package.json': JSON.stringify({
      name: '@maxim/contracts',
      scripts: {
        build: 'node ../../scripts/with-file-lock.mjs contracts-build -- npm run build:source',
        'build:source': 'node build.cjs',
        test: 'npm run build && npm run test:source',
        'test:source': 'node record.cjs',
      },
    }),
    'packages/contracts/build.cjs':
      "require('node:fs').writeFileSync('../../.git/contracts-built', 'yes');\n",
    'packages/contracts/record.cjs':
      "require('node:fs').writeFileSync('../../.git/contracts-argv.json', JSON.stringify(process.argv.slice(2)));\n",
    'packages/contracts/test/a.spec.ts': '',
    'apps/miniapp/test/a.test.ts': '',
    'apps/admin/test/a.test.ts': '',
    'scripts/a.test.mjs':
      "import { writeFileSync } from 'node:fs'; import test from 'node:test'; test('selected', () => { writeFileSync('.git/ran', 'yes'); console.log('selected test output'); console.error('selected test error'); });\n",
    'scripts/unknown.mjs': '',
    'infra/scripts/b.test.mjs': '',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await copyFile(
    new URL('../../with-file-lock.mjs', import.meta.url),
    join(repo, 'scripts/with-file-lock.mjs'),
  );
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'focused@example.invalid']);
  git(repo, ['config', 'user.name', 'Focused Tests']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  return repo;
}

function invoke(repo, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [cli, '--repo', repo, ...args], { encoding: 'utf8', env });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
