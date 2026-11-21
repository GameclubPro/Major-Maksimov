import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { selectEarlyCommands, selectEarlyTests } from '../early-checks.mjs';

const root = resolve(import.meta.dirname, '../../..');

test('changing the real preview modules selects their architecture check once', async () => {
  const callers = [
    'apps/miniapp/src/lib/api/preview-transport.ts',
    'apps/miniapp/src/lib/api/preview-transport-events.ts',
    'apps/miniapp/src/lib/api/preview-chat-closure.ts',
    'apps/miniapp/src/lib/api/preview-stop-words.ts',
  ];
  const architecture = 'apps/miniapp/test/preview-transport-architecture.test.ts';
  for (const path of callers) {
    assert.ok(existsSync(resolve(root, path)), path);
    assert.deepEqual(selectEarlyTests([path]), [architecture], path);
  }
  const commands = await selectEarlyCommands(root, callers);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, 'early-miniapp-tests');
  assert.ok(commands[0].args.includes('test/preview-transport-architecture.test.ts'));
  assert.deepEqual(await selectEarlyCommands(root, ['docs/README.md']), []);
});
