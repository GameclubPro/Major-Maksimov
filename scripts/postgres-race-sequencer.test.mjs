import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const DefaultSequencer = require('@jest/test-sequencer').default;
const apiRoot = resolve(import.meta.dirname, '../apps/api');
const { scripts } = JSON.parse(readFileSync(resolve(apiRoot, 'package.json'), 'utf8'));
const nativeCommand = scripts['test:postgres-races:unlocked'];
const sections = nativeCommand.split('--runTestsByPath ');
assert.equal(sections.length, 2, 'The public native command must retain one literal suite list');
const nativePaths = sections[1].trim().split(/\s+/u);
const sequencerFlag = sections[0].match(/(?:^|\s)--testSequencer(?:=|\s+)([^\s]+)/u);
// Before the correction, exercise the actual public command's default assignment.
const SelectedSequencer = sequencerFlag
  ? require(resolve(apiRoot, sequencerFlag[1]))
  : DefaultSequencer;

const rollup = 'src/admin/publication-occurrence-rollup-noop-postgres.spec.ts';
const diagnostic = 'src/scripts/diagnose-vk-parsing-postgres.spec.ts';
const otherHeavySuites = [
  'src/scripts/source-abandonment-store-postgres.spec.ts',
  'src/admin/publisher-publication-temporal-selection-postgres.spec.ts',
];

function makeTests(paths = nativePaths, rootDir = apiRoot) {
  const context = Object.freeze({ config: Object.freeze({ rootDir }) });
  const separator = rootDir.includes('\\') ? '\\' : '/';
  return Object.freeze(
    paths.map((id) =>
      Object.freeze({
        id,
        path: `${rootDir}${separator}${id.replaceAll('/', separator)}`,
        context,
      }),
    ),
  );
}

async function partitions(Sequencer, tests, shardCount = 8) {
  const sequencer = new Sequencer({ contexts: [], globalConfig: {} });
  return Promise.all(
    Array.from({ length: shardCount }, (_, index) =>
      sequencer.shard(tests, { shardIndex: index + 1, shardCount }),
    ),
  );
}

function owners(lanes) {
  return new Map(lanes.flatMap((lane, index) => lane.map(({ id }) => [id, index + 1])));
}

test('the public eight-way native selection separates the three heavy suites', async () => {
  const assignment = owners(await partitions(SelectedSequencer, makeTests()));
  const heavyOwners = [rollup, ...otherHeavySuites].map((path) => assignment.get(path));
  assert.equal(heavyOwners.includes(undefined), false, 'All three native suites must execute');
  assert.ok(
    new Set(heavyOwners).size > 1,
    'The rollup, source-abandonment and temporal suites must not share one native job budget',
  );
});

test('all 157 native suites execute exactly once with only the two approved ownership changes', async () => {
  assert.equal(nativePaths.length, 157);
  assert.equal(new Set(nativePaths).size, 157);
  assert.ok(nativePaths.includes('src/moderation/message-count-quota.redis-integration.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/night-mode-comments-postgres.spec.ts'));
  for (const path of [
    'src/chat-context/chat-context-source-postgres.spec.ts',
    'src/chat-context/chat-context-settings-cache-postgres.spec.ts',
    'src/chat-context/chat-context-media-cache.redis-integration.spec.ts',
    'src/chat-context/chat-context-subscriber.redis-integration.spec.ts',
  ])
    assert.ok(nativePaths.includes(path));
  assert.ok(nativePaths.includes('src/admin/link-rules-settings-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/moderation/link-rules-runtime-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/moderation/global-spammer-archive-postgres.spec.ts'));
  assert.ok(
    nativePaths.includes('src/moderation/moderation-effect-failure-diagnostics-postgres.spec.ts'),
  );
  assert.ok(nativePaths.includes('src/admin/admin-manual-command.redis-integration.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/admin-commercial-ads-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/max/chat-admin-roster-state-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/admin-settings-entry-protection-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/managed-giveaway-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/managed-poll-render-retry-postgres.spec.ts'));
  for (const path of [
    'src/integrations/karavan-marketplace/karavan-connection-journal-postgres.spec.ts',
    'src/integrations/karavan-marketplace/karavan-marketplace-connections-postgres.spec.ts',
    'src/integrations/karavan-marketplace/karavan-management-journal-postgres.spec.ts',
  ])
    assert.ok(nativePaths.includes(path));
  assert.ok(nativePaths.includes('src/admin/former-participant-sanctions-postgres.spec.ts'));
  assert.ok(
    nativePaths.includes('src/webhook/webhook-nonordered-mirror-quarantine-postgres.spec.ts'),
  );
  assert.ok(nativePaths.includes('src/publisher/publisher-auto-reply-recovery-postgres.spec.ts'));
  for (const path of [
    'src/admin/safety-desk-overview-pending-postgres.spec.ts',
    'src/admin/safety-desk-overview-actions-postgres.spec.ts',
    'src/admin/safety-desk-overview-redis.spec.ts',
  ])
    assert.ok(nativePaths.includes(path));
  assert.ok(nativePaths.includes('src/admin/vk-parsing-rate-limit.redis-integration.spec.ts'));
  assert.ok(nativePaths.includes('src/admin/vk-auto-delete-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/max/max-immediate-send-ledger-postgres.spec.ts'));
  assert.ok(nativePaths.includes('src/max/max-action-send-capacity-postgres.spec.ts'));
  const tests = makeTests();
  const baseline = await partitions(DefaultSequencer, tests);
  const selected = await partitions(SelectedSequencer, tests);
  const flat = selected.flat();
  assert.equal(flat.length, nativePaths.length);
  assert.equal(new Set(flat).size, nativePaths.length, 'No suite object may appear in two lanes');
  assert.deepEqual(new Set(flat), new Set(tests), 'Keep every original native suite object');
  assert.deepEqual(
    selected.map((lane) => lane.length),
    baseline.map((lane) => lane.length),
  );
  const previous = owners(baseline);
  const actual = owners(selected);
  assert.equal(previous.get(rollup), 2);
  assert.equal(previous.get(diagnostic), 4);
  for (const path of nativePaths) {
    const expected = path === rollup ? 4 : path === diagnostic ? 2 : previous.get(path);
    assert.equal(actual.get(path), expected, `Unexpected native owner for ${path}`);
  }
});

test('other shard counts retain Jest assignment, order and original suite references', async () => {
  const tests = makeTests();
  for (const count of [1, 2, 3, 4, 7, 9]) {
    assert.deepEqual(
      await partitions(SelectedSequencer, tests, count),
      await partitions(DefaultSequencer, tests, count),
      `Only the selected eight-way partition may change: ${count}`,
    );
  }
  assert.equal(SelectedSequencer.prototype.sort, DefaultSequencer.prototype.sort);
  assert.equal(SelectedSequencer.prototype.cacheResults, DefaultSequencer.prototype.cacheResults);
});

test('eight-way ownership is independent of input order and checkout path spelling', async () => {
  const expected = owners(await partitions(SelectedSequencer, makeTests()));
  for (const rootDir of ['/tmp/native checkout/apps/api', 'C:\\native checkout\\apps\\api']) {
    const reversed = makeTests([...nativePaths].reverse(), rootDir);
    assert.deepEqual(owners(await partitions(SelectedSequencer, reversed)), expected);
  }
});

test('partial selections and matching basenames in foreign directories retain default ownership', async () => {
  for (const paths of [
    nativePaths.filter((path) => path !== rollup),
    nativePaths.filter((path) => path !== diagnostic),
    nativePaths.map((path) =>
      path === rollup || path === diagnostic ? path.replace('src/', 'src/foreign/') : path,
    ),
  ]) {
    const tests = makeTests(paths);
    assert.deepEqual(
      await partitions(SelectedSequencer, tests),
      await partitions(DefaultSequencer, tests),
    );
  }
});

test('additional unknown suite paths retain default membership without omissions or duplication', async () => {
  const tests = makeTests([...nativePaths, 'src/unrelated/new-native-proof.spec.ts']);
  const baseline = owners(await partitions(DefaultSequencer, tests));
  const selected = await partitions(SelectedSequencer, tests);
  const actual = owners(selected);
  assert.deepEqual(new Set(selected.flat()), new Set(tests));
  assert.equal(selected.flat().length, tests.length);
  for (const { id } of tests) {
    const expected =
      id === rollup
        ? baseline.get(diagnostic)
        : id === diagnostic
          ? baseline.get(rollup)
          : baseline.get(id);
    assert.equal(actual.get(id), expected, `Unexpected owner for ${id}`);
  }
});

test('a subset exchanges original owners instead of injecting suites into fixed lanes', async () => {
  const tests = makeTests([rollup, diagnostic]);
  const baseline = await partitions(DefaultSequencer, tests);
  const selected = await partitions(SelectedSequencer, tests);
  const previous = owners(baseline);
  const actual = owners(selected);
  assert.deepEqual(
    selected.map((lane) => lane.length),
    baseline.map((lane) => lane.length),
  );
  assert.equal(actual.get(rollup), previous.get(diagnostic));
  assert.equal(actual.get(diagnostic), previous.get(rollup));
  assert.deepEqual(new Set(selected.flat()), new Set(tests));
});

test('exceptions already in the same default lane keep capacity and every original suite object', async () => {
  const fullDefault = await partitions(DefaultSequencer, makeTests());
  // Seven later hash-ranked suites put both exception objects in the first 2/9 slot.
  const laterPaths = fullDefault[7].slice(0, 7).map(({ id }) => id);
  const tests = makeTests([rollup, diagnostic, ...laterPaths]);
  const baseline = await partitions(DefaultSequencer, tests);
  const previous = owners(baseline);
  assert.equal(previous.get(rollup), previous.get(diagnostic));
  const selected = await partitions(SelectedSequencer, tests);
  assert.deepEqual(
    selected.map((lane) => lane.length),
    baseline.map((lane) => lane.length),
  );
  assert.equal(selected.flat().length, tests.length);
  assert.deepEqual(new Set(selected.flat()), new Set(tests));
  assert.deepEqual(owners(selected), previous);
});

test('duplicate exception paths are rejected rather than silently assigned twice', async () => {
  for (const path of [rollup, diagnostic]) {
    await assert.rejects(partitions(SelectedSequencer, makeTests([...nativePaths, path])));
  }
});

test('ordinary API and compatibility commands retain their existing Jest configuration', () => {
  const config = require(resolve(apiRoot, 'jest.config.cjs'));
  assert.equal(config.testSequencer, undefined);
  for (const name of ['test:source', 'test:ci:source']) {
    assert.match(scripts[name], /--config jest\.config\.cjs/u);
    assert.doesNotMatch(scripts[name], /--testSequencer/u);
  }
  assert.equal(
    Object.entries(scripts).filter(([, command]) => command.includes('--testSequencer')).length,
    1,
    'The assignment exception belongs only to the public native test family',
  );
});

test('native selection retains its public lock, required stores, generation and serial worker', () => {
  assert.equal(
    scripts['test:postgres-races'],
    'node ../../scripts/with-file-lock.mjs api-validation -- npm run test:postgres-races:unlocked',
  );
  assert.ok(
    nativeCommand.startsWith(
      'node ../../scripts/require-postgres-race-env.mjs && npm run prepare:codegen && ',
    ),
  );
  assert.match(sections[0], /--maxWorkers=1(?:\s|$)/u);
  assert.match(sections[0], /--workerIdleMemoryLimit=768MB(?:\s|$)/u);
  assert.ok(sequencerFlag, 'Wire the custom sequencer before the maintained literal suite list');
  assert.equal((nativeCommand.match(/--testSequencer/gu) ?? []).length, 1);
  assert.doesNotMatch(nativeCommand, /--(?:forceExit|runInBand|testNamePattern|filter)(?:=|\s|$)/u);
  assert.ok(nativePaths.every((path) => /^src\/[a-z0-9./-]+\.spec\.ts$/u.test(path)));
});
