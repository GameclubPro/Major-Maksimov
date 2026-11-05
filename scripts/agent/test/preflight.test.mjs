import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runPreflight } from '../preflight.mjs';
import { findRefactorFileSizeViolations } from '../../check-refactor-guards.mjs';

const root = resolve(import.meta.dirname, '../../..');
test('fast preflight checks current source without building dist or changing generated files', () => {
  const generated = [
    'infra/scripts/lib/change-impact-components.generated.sh',
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-detector-source.generated.ts',
  ];
  const before = generated.map((path) => readFileSync(resolve(root, path), 'utf8'));
  const messages = [];
  runPreflight(root, (message) => messages.push(message));
  assert.equal(messages.filter((line) => line.includes('passed')).length, 5);
  assert.match(messages[0], /refactor file size ceilings: passed/u);
  assert.match(messages.at(-1), /exact-SHA CI are still required/u);
  assert.deepEqual(
    generated.map((path) => readFileSync(resolve(root, path), 'utf8')),
    before,
  );
});

test('file growth fails preflight before generated artifacts or other checks are needed', (t) => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-preflight-ceiling-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  findRefactorFileSizeViolations(fixture, (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    return '';
  });
  writeFileSync(
    resolve(fixture, 'apps/api/src/moderation/moderation.service.legacy.ts'),
    'line\n'.repeat(18_725),
  );
  const messages = [];
  assert.throws(
    () => runPreflight(fixture, (message) => messages.push(message)),
    /moderation\.service\.legacy\.ts has 18725 lines, over the 18724 refactor guard/u,
  );
  assert.deepEqual(messages, []);
});
