import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSpammerProjectionOnlineClientLauncher } from './multibot-online-client.mjs';
import { prepareSpammerProjection } from './routing-index-online-supervisor.mjs';
import { checkSpammerProjectionPrepareCapacity } from './routing-index-prepare-capacity.mjs';

const sha = 'a'.repeat(40);
const compose = ['-f', 'infra/docker-compose.yml'];
const env = { MAXIM_EXPECTED_DEPLOY_SHA: sha };
const GiB = 1024 ** 3;
const imageId = 'sha256:' + 'b'.repeat(64);
const networkId = 'c'.repeat(64);
const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';

function fixture({
  tableBytes = GiB,
  availableBytes = 25 * GiB,
  exact = true,
  release = 'prepare_spammer_deferral',
} = {}) {
  const queries = [];
  const calls = [];
  const options = {
    env,
    readReleaseState: async (givenSha, args, stateOptions) => {
      assert.equal(givenSha, sha);
      assert.deepEqual(args, compose);
      assert.equal(stateOptions.requireSpammerDeferral, true);
      return release;
    },
    run: async (cmd, args, opts = {}) => {
      calls.push(args);
      if (args.includes('config'))
        return {
          stdout: JSON.stringify({
            name: 'maxim',
            services: {
              'api-ingress': {
                image: 'maxim-api:' + sha,
                environment: { DATABASE_URL: 'postgresql://maxim:fixture@postgres/maxim' },
              },
            },
            networks: { default: { name: 'maxim_default' } },
          }),
        };
      if (args.includes('psql')) {
        queries.push(opts.input);
        return {
          stdout: JSON.stringify({
            tableBytes,
            approxRows: 10000,
            exact,
            maxWalBytes: GiB,
            tempTablespaces: '',
            defaultLayout: true,
            dataDirectory: '/data',
          }),
        };
      }
      if (args.includes('sh')) return { stdout: '/data/pg_wal' };
      if (cmd === 'df' || args.includes('df'))
        return { stdout: 'dev 50000000 1 ' + Math.floor(availableBytes / 1024) + ' 1% /data' };
      if (args[0] === 'image')
        return {
          stdout: JSON.stringify([
            {
              Id: imageId,
              Config: {
                User: 'node',
                Labels: {
                  'com.maxim.release-protected': 'true',
                  'org.opencontainers.image.revision': sha,
                },
              },
            },
          ]),
        };
      if (args[0] === 'network')
        return {
          stdout: JSON.stringify([
            {
              Id: networkId,
              Name: 'maxim_default',
              Driver: 'bridge',
              Scope: 'local',
              Labels: {
                'com.docker.compose.project': 'maxim',
                'com.docker.compose.network': 'default',
              },
            },
          ]),
        };
      if (args[0] === 'create') return { stdout: 'd'.repeat(64) };
      throw new Error('Unexpected command ' + args[0]);
    },
  };
  return { options, calls, queries };
}
test('projection preflight counts the exact source table and reserves all shared device budgets', async () => {
  const f = fixture();
  const v = await checkSpammerProjectionPrepareCapacity(sha, compose, f.options);
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0], /to_regclass\('public\.spammer_observations'\)/u);
  assert.doesNotMatch(f.queries[0], /webhook_events/u);
  assert.deepEqual(v.estimates, [
    { selector: 'spammer_projection', indexBytes: GiB, tempBytes: GiB / 4, tableBytes: GiB },
  ]);
  assert.equal(v.devices[0].requiredBytes, (10 + 1 + 0.25 + 2) * GiB);
  const observedProductionSize = 2207891456;
  const measured = await checkSpammerProjectionPrepareCapacity(
    sha,
    compose,
    fixture({ tableBytes: observedProductionSize }).options,
  );
  assert.equal(measured.estimates[0].tableBytes, observedProductionSize);
  for (const [input, error] of [
    [{ tableBytes: 3 * GiB + 1 }, /TABLE_SCOPE_EXCEEDED/u],
    [{ availableBytes: 13 * GiB }, /CAPACITY_INSUFFICIENT/u],
    [{ exact: false }, /CAPACITY_METADATA_INVALID/u],
  ]) {
    await assert.rejects(
      checkSpammerProjectionPrepareCapacity(sha, compose, fixture(input).options),
      error,
    );
  }
});
test('unrelated release states and mismatched SHA cannot reach the target or create a client', async () => {
  const wrong = fixture();
  assert.throws(
    () => checkSpammerProjectionPrepareCapacity('b'.repeat(40), compose, wrong.options),
    /TARGET_INVALID/u,
  );
  assert.equal(wrong.calls.length, 0);
  for (const state of [
    'prepare_routing',
    'already_applied',
    'prepare_publisher_deferral',
    'not_in_target',
  ]) {
    const f = fixture({ release: state });
    await assert.rejects(prepareSpammerProjection(sha, compose, f.options), /STATE_INVALID/u);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ release: 'compatible_pending' });
  assert.deepEqual(await prepareSpammerProjection(sha, compose, f.options), {
    state: 'already_applied',
  });
  assert.equal(f.calls.length, 0);
});
test('projection launcher only starts the immutable image runner in the restricted client', async () => {
  const f = fixture();
  await assert.rejects(
    createSpammerProjectionOnlineClientLauncher(compose, 'routing', f.options),
    /TARGET_INVALID/u,
  );
  const launch = await createSpammerProjectionOnlineClientLauncher(
    compose,
    'spammer_projection',
    f.options,
  );
  await launch.prepare(tag);
  const args = f.calls.find((a) => a[0] === 'create');
  assert.deepEqual(args.slice(-3), [
    imageId,
    'scripts/agent/routing-index-online-prepare.mjs',
    '--spammer-deferral',
  ]);
  assert.equal(args[args.indexOf('--network') + 1], networkId);
  assert.ok(args.includes('--read-only') && args.includes('no-new-privileges'));
});
test('one supervised UUID owns both migrations until post-DDL state readback and cleanup', async () => {
  let now = 1800000000000,
    starts = 0,
    stopped = 0,
    capacityChecks = 0;
  const stages = [];
  const options = {
    env,
    now: () => now,
    signals: new EventEmitter(),
    readReleaseState: async () => (starts ? 'compatible_pending' : 'prepare_spammer_deferral'),
    checkCapacity: async () => {
      capacityChecks++;
      return { skipped: false, state: { pending: ['spammer_projection'] } };
    },
    readFilesystems: async () => [{ availableBytes: 20 * GiB }],
    checkRuntime: async () => {
      const timestamp = new Date(now).toISOString();
      const probe = {
        status: 200,
        body: {
          ok: true,
          timestamp,
          checks: {
            database: true,
            redis: true,
            queueLag: {
              ok: true,
              rawOk: true,
              softWarning: false,
              softWarningCode: null,
              effectiveLagSec: 0,
              sampleGeneratedAt: timestamp,
            },
          },
        },
      };
      return { checkedAtMs: now, ingress: probe, admin: probe };
    },
    waitForTick: async (_done, ms) => {
      now += ms;
    },
    createLauncher: async (_compose, selector) => {
      assert.equal(selector, 'spammer_projection');
      return {
        identity: { imageId },
        prepare: async () => {},
        start: (uuid) => {
          starts++;
          const child = new EventEmitter();
          child.name = uuid;
          queueMicrotask(() => child.emit('exit', 0, null));
          return child;
        },
      };
    },
    stop: async (_compose, child, applicationName, containerName) => {
      assert.match(applicationName, /^maxim-online-[\da-f-]{36}$/u);
      assert.equal(child.name, applicationName);
      assert.equal(containerName, applicationName);
      stopped++;
    },
    onProgress: (event) => stages.push(event),
  };
  assert.deepEqual(await prepareSpammerProjection(sha, compose, options), {
    state: 'already_applied',
  });
  assert.equal(starts, 1);
  assert.equal(stopped, 1);
  assert.equal(capacityChecks, 2);
  assert.ok(
    stages.some(
      (e) =>
        e.phase === 'target_verified' &&
        e.lastStorageAt &&
        e.lastRuntimeAt &&
        e.imageId === imageId &&
        e.sourceSha === sha,
    ),
  );
});
