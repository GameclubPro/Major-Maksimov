import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const watchdogUrl = new URL('./vps-postgres-audit-test-watchdog.mjs', import.meta.url).href;
const fixtureWindowMs = 1_000;

function runFixture(source) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import assert from 'node:assert/strict';
import test, { after, afterEach, before, beforeEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { armAuditFixtureInactivityWatchdog } from ${JSON.stringify(watchdogUrl)};
const windowMs = ${fixtureWindowMs};
const watchdog = armAuditFixtureInactivityWatchdog(windowMs);
beforeEach((context) => watchdog.markProgress(context.name));
afterEach(() => watchdog.markProgress('between_tests_or_shutdown'));
${source}
`,
    ],
    { encoding: 'utf8', env, timeout: 10_000, killSignal: 'SIGKILL' },
  );
}

function assertWatchdogFailure(result, expectedTest) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  const diagnostics = result.stderr
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  assert.equal(diagnostics.length, 1, result.stderr);
  const [diagnostic] = diagnostics;
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'activeResources',
    'failure',
    'test',
    'testElapsedMs',
  ]);
  assert.equal(diagnostic.failure, 'audit_fixture_file_deadline');
  assert.equal(diagnostic.test, expectedTest);
  assert.ok(diagnostic.testElapsedMs >= fixtureWindowMs - 50, result.stderr);
  assert.ok(diagnostic.activeResources.includes('Timeout'), result.stderr);
}

test('progressing audit cases may cumulatively exceed the inactivity window and exit cleanly', () => {
  const result = runFixture(`
const startedAt = Date.now();
for (let index = 0; index < 5; index += 1) {
  test('progressing case ' + index, async () => {
    await delay(windowMs * 0.3);
  });
}
after(() => {
  assert.ok(Date.now() - startedAt > windowMs);
  process.stdout.write('PROGRESSING_CASES_COMPLETE\\n');
});
`);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PROGRESSING_CASES_COMPLETE/u);
  assert.equal(result.stderr, '');
});

test('the audit setup watchdog does not keep an otherwise idle child alive', () => {
  const result = runFixture('');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('stuck audit module setup exits with its phase and resource evidence', () => {
  const result = runFixture(`
setInterval(() => {}, 60_000);
await new Promise(() => {});
`);
  assertWatchdogFailure(result, 'module_setup');
});

test('beforeEach gives a stuck audit case its own inactivity window', () => {
  const result = runFixture(`
before(async () => { await delay(windowMs * 0.6); });
test('stuck audit case', async () => {
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
});
`);
  assertWatchdogFailure(result, 'stuck audit case');
});

test('afterEach leaves a fresh shutdown watchdog armed for an orphan resource', () => {
  const result = runFixture(`
test('completed audit case', async () => {
  await delay(windowMs * 0.6);
  setInterval(() => {}, 60_000);
});
after(() => { process.stdout.write('AUDIT_CASE_COMPLETE\\n'); });
`);
  assertWatchdogFailure(result, 'between_tests_or_shutdown');
  assert.match(result.stdout, /AUDIT_CASE_COMPLETE/u);
});
