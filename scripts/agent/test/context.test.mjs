import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseContextArgs, runContextCli } from '../context.mjs';

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(repo, path, contents) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
}

function fixture(t, files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'maxim-context-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.name', 'Context Tests']);
  git(repo, ['config', 'user.email', 'context@example.invalid']);
  for (const [path, contents] of Object.entries({ 'AGENTS.md': '# Root\n', ...files }))
    write(repo, path, contents);
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'fixture']);
  return repo;
}

function context(repo, args = []) {
  const output = [];
  assert.equal(
    runContextCli(['--repo', repo, '--json', ...args], { stdout: (value) => output.push(value) }),
    0,
  );
  assert.equal(output.length, 1);
  return JSON.parse(output[0]);
}

test('routes planned paths in a clean checkout through ancestors and override precedence', (t) => {
  const repo = fixture(t, {
    'AGENTS.md': '# Root\n[Workflow](docs/workflow.md#safety)\n',
    'docs/workflow.md': '# Safety\n',
    'apps/AGENTS.md': '# Apps\n',
    'apps/api/AGENTS.md': '[Ignored route](../../docs/other.md)\n',
    'apps/api/AGENTS.override.md':
      '# API override\n## Editing\n[Rules](../../docs/workflow.md#safety)\n',
    'apps/miniapp/AGENTS.md': '# Unrelated\n',
  });
  const before = git(repo, ['status', '--porcelain=v1']);
  const result = context(repo, ['--path', 'apps/api/src/planned.ts']);
  assert.equal(result.checkout.root, repo);
  assert.equal(result.checkout.revision, git(repo, ['rev-parse', 'HEAD']).trim());
  assert.deepEqual(
    result.guidance.map(({ path }) => path),
    ['AGENTS.md', 'apps/AGENTS.md', 'apps/api/AGENTS.override.md'],
  );
  assert.deepEqual(result.links, [
    { from: 'AGENTS.md', line: 2, heading: 'Root', target: 'docs/workflow.md#safety' },
    {
      from: 'apps/api/AGENTS.override.md',
      line: 3,
      heading: 'Editing',
      target: 'docs/workflow.md#safety',
    },
  ]);
  assert.match(result.notices.join('\n'), /source missing/u);
  assert.match(result.warning, /Existing code and tests do not establish intended behavior/u);
  assert.equal(git(repo, ['status', '--porcelain=v1']), before);
});

test('empty overrides fall back; clean default mode asks for planned paths', (t) => {
  const repo = fixture(t, { 'AGENTS.override.md': '' });
  const result = context(repo);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.guidance, [{ path: 'AGENTS.md', readable: true }]);
  assert.match(result.notices.join('\n'), /Use --path/u);
});

test('worktree and staged scopes retain both rename sides and deleted source guidance', (t) => {
  const repo = fixture(t, {
    'old/AGENTS.md': '# Old\n',
    'new/AGENTS.md': '# New\n',
    'old/task.ts': '// FLAG: private explanatory text\nexport const value = 1;\n',
    'old/gone.ts': '// FLAG: deleted\n',
  });
  git(repo, ['mv', 'old/task.ts', 'new/task.ts']);
  git(repo, ['rm', '--quiet', 'old/gone.ts']);
  write(repo, 'untracked.ts', '// FLAG: untracked secret\n');
  const result = context(repo, ['--staged']);
  assert.deepEqual(result.paths, ['new/task.ts', 'old/gone.ts', 'old/task.ts']);
  assert.deepEqual(
    result.guidance.map(({ path }) => path),
    ['AGENTS.md', 'new/AGENTS.md', 'old/AGENTS.md'],
  );
  assert.deepEqual(result.flags, [{ path: 'new/task.ts', line: 1 }]);
  assert.equal(JSON.stringify(result).includes('private explanatory text'), false);
  assert.match(result.notices.join('\n'), /not staged contents/u);
  assert.match(result.notices.join('\n'), /old\/gone.ts: source missing/u);
  const worktree = context(repo);
  assert.ok(worktree.paths.includes('untracked.ts'));
  assert.match(worktree.notices.join('\n'), /untracked.ts: content not scanned/u);
});

test('does not scan environment, ignored, untracked, binary or linked source content', (t) => {
  const repo = fixture(t, {
    '.env.md': 'FLAG: ENV_SECRET\n',
    'ignored.ts': 'FLAG: IGNORED_SECRET\n',
    'binary.ts': '\0FLAG: BINARY_SECRET\n',
    'safe.ts': '// FLAG: PRIVATE_SOURCE_TEXT\n',
  });
  write(repo, '.gitignore', 'ignored.ts\n');
  write(repo, 'untracked.ts', 'FLAG: UNTRACKED_SECRET\n');
  const outside = mkdtempSync(join(tmpdir(), 'maxim-context-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  write(outside, 'secret.ts', 'FLAG: SYMLINK_SECRET\n');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(outside, join(repo, 'escape'), linkType);
  const result = context(repo, [
    '--path',
    '.env.md',
    '--path',
    'ignored.ts',
    '--path',
    'untracked.ts',
    '--path',
    'binary.ts',
    '--path',
    'safe.ts',
    '--path',
    'escape/secret.ts',
  ]);
  assert.deepEqual(result.flags, [{ path: 'safe.ts', line: 1 }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /ENV_SECRET|IGNORED_SECRET|UNTRACKED_SECRET|BINARY_SECRET|SYMLINK_SECRET|PRIVATE_SOURCE_TEXT/u,
  );
  assert.match(result.notices.join('\n'), /environment or untracked file/u);
  assert.match(result.notices.join('\n'), /ignored file/u);
  assert.match(result.notices.join('\n'), /binary file/u);
  assert.match(result.notices.join('\n'), /symlink/u);
});

test('directory selection does not recurse and untrusted overrides do not silently fall back', (t) => {
  const repo = fixture(t, {
    'src/AGENTS.md': '# Source\n',
    'src/nested/code.ts': '// FLAG: hidden\n',
  });
  write(repo, 'src/AGENTS.override.md', '[Secret route](private-secret.md)\n');
  const result = context(repo, ['--path', 'src']);
  assert.deepEqual(result.guidance, [
    { path: 'AGENTS.md', readable: true },
    { path: 'src/AGENTS.override.md', readable: false },
  ]);
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.links, []);
  assert.match(result.notices.join('\n'), /no recursion/u);
});

test('rejects paths outside repository content, including Git metadata', (t) => {
  const repo = fixture(t);
  for (const path of [
    '../escape.ts',
    '/tmp/secret.ts',
    '.git/config',
    'src/../../escape.ts',
    'C:\\secret.ts',
    'bad\nfile.ts',
  ]) {
    assert.throws(() => context(repo, ['--path', path]), /repository-relative|outside repository/u);
  }
});

test('only emits local inline links outside fences and never follows linked documents', (t) => {
  const repo = fixture(t, {
    'AGENTS.md':
      '# Notes\n[Missing](docs/not-created.md#rule)\n[External](https://example.invalid/)\n[Escaping](../private.md)\n[Self](#notes)\n```md\n[Example](not-a-rule.md)\n```\n',
  });
  const result = context(repo, ['--path', 'planned.ts']);
  assert.deepEqual(
    result.links.map(({ target }) => target),
    ['docs/not-created.md#rule', 'AGENTS.md#notes'],
  );
  assert.match(result.notices.join('\n'), /outside repository/u);
});

test('reports output and file-size limits without silently claiming complete coverage', (t) => {
  const repo = fixture(t, {
    'AGENTS.md': '# Links\n' + '[Reference](docs/rules.md)\n'.repeat(101),
    'source.ts': '// FLAG: safeguard\n'.repeat(201),
    'large.ts': 'x'.repeat(1048577),
    'huge/AGENTS.md': 'x'.repeat(65537),
  });
  const result = context(repo, [
    '--path',
    'source.ts',
    '--path',
    'large.ts',
    '--path',
    'huge/planned.ts',
  ]);
  assert.equal(result.flags.length, result.limits.flags);
  assert.equal(result.links.length, result.limits.links);
  assert.deepEqual(result.omitted, { paths: 0, links: 1, flags: 1 });
  assert.match(result.notices.join('\n'), /large.ts: content not scanned.*1048576-byte limit/u);
  assert.match(
    result.notices.join('\n'),
    /huge\/AGENTS.md: content not scanned.*65536-byte limit/u,
  );
  const manyPaths = context(
    repo,
    Array.from({ length: 101 }, (_, i) => ['--path', `planned-${i}.ts`]).flat(),
  );
  assert.equal(manyPaths.paths.length, manyPaths.limits.paths);
  assert.equal(manyPaths.omitted.paths, 1);
  assert.match(manyPaths.notices.join('\n'), /Path limit/u);
});

test('rejects ambiguous modes and malformed CLI options; help needs no repository', () => {
  for (const args of [
    ['--staged', '--worktree'],
    ['--path', 'file.ts', '--worktree'],
    ['--path', 'file.ts', '--staged'],
    ['--repo'],
    ['--path'],
    ['--json', '--json'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseContextArgs(args));
  }
  assert.deepEqual(parseContextArgs(['--path', 'a.ts', '--path', 'b.ts']).paths, ['a.ts', 'b.ts']);
  const output = [];
  assert.equal(
    runContextCli(['--repo', '/does/not/exist', '--help'], {
      stdout: (value) => output.push(value),
    }),
    0,
  );
  assert.match(output.join(''), /Usage:/u);
});

test('human output identifies navigation limitations and source locations without snippets', (t) => {
  const repo = fixture(t, { 'source.ts': '// FLAG: sensitive implementation detail\n' });
  const output = [];
  runContextCli(['--repo', repo, '--path', 'source.ts'], { stdout: (value) => output.push(value) });
  const rendered = output.join('');
  assert.match(rendered, /Navigation only/u);
  assert.match(rendered, /source.ts:1/u);
  assert.doesNotMatch(rendered, /sensitive implementation detail/u);
  assert.equal(
    readFileSync(join(repo, 'source.ts'), 'utf8'),
    '// FLAG: sensitive implementation detail\n',
  );
});
