import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('operational stdin readers decode only after buffering the complete pipe', () => {
  const root = import.meta.dirname;
  // FLAG: Node 24 can corrupt memory on fragmented pipes with its encoded read fast path.
  // https://github.com/nodejs/node/issues/66341 — read bytes, then decode the Buffer.
  const unsafeReader = /\breadFileSync\s*\(\s*(?:0|process\.stdin\.fd)\s*,/u;
  const violations = readdirSync(root, { recursive: true })
    .filter((path) => /\.(?:sh|mjs|cjs)$/u.test(path))
    .filter((path) => unsafeReader.test(readFileSync(resolve(root, path), 'utf8')));
  assert.deepEqual(violations, [], 'Use readFileSync(0).toString("utf8") for stdin');
});

test('Lastik bootstrap buffers a fragmented request through EOF before validating its source', async () => {
  const request = JSON.stringify({
    sourceSha: 'a'.repeat(40),
    botId: '123',
    botToken: `test-only-${'x'.repeat(128)}`,
  });
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, 'eraser-bootstrap.mjs'), 'install', 'b'.repeat(40)],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((done, reject) => {
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  for (let offset = 0; offset < request.length; offset += 7) {
    child.stdin.write(request.slice(offset, offset + 7));
    await delay(2);
  }
  child.stdin.end();
  assert.deepEqual(await completed, { code: 2, signal: null });
  // FLAG: A mismatched source stops before touching production secret paths or environment files.
  assert.match(stderr, /Lastik bootstrap source does not match the synchronized checkout\./u);
  assert.equal(stdout, '');
  assert.ok(!stderr.includes('test-only-'), 'request credentials must never enter diagnostics');
});

test('registry image planning decodes a fragmented UTF8 pipe before selecting exact components', async () => {
  const sha = 'a'.repeat(40);
  const request = Buffer.from(
    `Синхронизация источников\nMAXIM_IMAGE_PLAN=${JSON.stringify({
      schemaVersion: 1,
      sourceSha: sha,
      components: ['admin-static', 'api-shared'],
    })}\n`,
  );
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, 'registry-preload.mjs'), 'plan', sha],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((done, reject) => {
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  for (let offset = 0; offset < request.length; offset += 7) {
    child.stdin.write(request.subarray(offset, offset + 7));
    await delay(2);
  }
  child.stdin.end();
  assert.deepEqual(await completed, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'admin-static\napi-shared\n');
  assert.equal(stderr, '');
});
