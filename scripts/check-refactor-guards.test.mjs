import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { findRefactorFileSizeViolations } from './check-refactor-guards.mjs';

const source = fileURLToPath(new URL('./check-refactor-guards.mjs', import.meta.url));
const moderation = 'apps/api/src/moderation/moderation.service.legacy.ts';

test('the shared ceiling check accepts its boundary and rejects one extra line', () => {
  const root = resolve(tmpdir(), 'maxim-refactor-line-fixture');
  for (const contents of [
    'line\n'.repeat(18_724),
    'line\r\n'.repeat(18_724),
    'line\n'.repeat(18_724).slice(0, -1),
  ]) {
    assert.deepEqual(
      findRefactorFileSizeViolations(root, (path) =>
        path === resolve(root, moderation) ? contents : '',
      ),
      [],
    );
  }
  const violations = findRefactorFileSizeViolations(root, (path) =>
    path === resolve(root, moderation) ? 'line\n'.repeat(18_725) : '',
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, moderation);
  assert.equal(violations[0].lines, 18_725);
  assert.equal(violations[0].maxLines, 18_724);
  assert.equal(violations[0].targetLines, 17_000);
  assert.match(violations[0].reason, /focused cleanup services/u);
});

test('importing the helper does not read a checkout or execute CLI checks', (t) => {
  const fixture = createFixture(t);
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(fixture.cli).href)});`,
    ],
    { cwd: fixture.root, encoding: 'utf8', timeout: 15_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('direct CLI execution retains file, facade, entrypoint, cycle and boundary refusals', (t) => {
  const fixture = createFixture(t);
  findRefactorFileSizeViolations(fixture.root, (path) => {
    fixture.write(path, '');
    return '';
  });
  fixture.write(moderation, 'line\n'.repeat(18_725));
  fixture.write('apps/api/src/webhook/webhook.controller.ts', 'WebhookService;\n');
  fixture.write('apps/api/src/max/max-action.processor.ts', '');
  fixture.write('apps/api/src/moderation/default-webhook-lease-manager.service.ts', '');
  fixture.write('apps/api/src/admin/admin-managed-entities-refresh.processor.ts', '');
  const legacyImport = ['./implementation', 'legacy'].join('.');
  fixture.write(
    'apps/api/src/fixture-legacy.ts',
    `import value from ${JSON.stringify(legacyImport)};\n`,
  );
  fixture.write('apps/api/src/fixture-cycle-a.ts', "import './fixture-cycle-b';\n");
  fixture.write('apps/api/src/fixture-cycle-b.ts', "import './fixture-cycle-a';\n");

  const run = spawnSync(process.execPath, [fixture.cli], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /has 18725 lines, over the 18724 refactor guard/u);
  assert.match(run.stderr, /Next target: 17000 lines or fewer/u);
  assert.match(run.stderr, /fixture-legacy\.ts imports a \*\.legacy module directly/u);
  assert.match(run.stderr, /webhook\.controller\.ts bypasses WebhookIngestionService/u);
  assert.match(run.stderr, /Import cycle detected:/u);
  assert.match(run.stderr, /fixture contract boundary refused/u);
  assert.match(run.stderr, /fixture runtime boundary refused/u);
  assert.doesNotMatch(run.stderr, /ENOENT|ReferenceError|TypeError/u);
});

function createFixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'maxim-refactor-guards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const cli = resolve(root, 'scripts/check-refactor-guards.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(source, cli);
  write(
    'scripts/check-contract-exports.mjs',
    "export function findContractsArchitectureViolations() { return [{ message: 'fixture contract boundary refused' }]; }\n",
  );
  write(
    'scripts/check-runtime-contexts.mjs',
    "export function assertRuntimeContextBoundaries() { throw new Error('fixture runtime boundary refused'); }\n",
  );
  return { root, cli, write };
}
