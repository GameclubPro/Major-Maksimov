import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  ROUTING_INDEX_TARGET,
  readRoutingIndexSource,
} from '../../scripts/agent/routing-index-online-target.mjs';
import { verifyRoutingIndexState } from './routing-index-online-state.mjs';
import {
  assessRoutingIndexPrepareCapacity,
  checkRoutingIndexPrepareCapacity,
} from './routing-index-prepare-capacity.mjs';
import {
  routingIndexOnlineClientCreateArgs,
  createRoutingIndexOnlineClientLauncher,
} from './multibot-online-client.mjs';
import {
  prepareRoutingIndex,
  routingIndexFailureCode,
} from './routing-index-online-supervisor.mjs';
import { runRoutingIndexOnlinePrepare } from '../../scripts/agent/routing-index-online-prepare.mjs';

const source = readRoutingIndexSource(resolve(import.meta.dirname, '../..'));
const GiB = 1024 ** 3;
const receipts = () =>
  source
    .filter((entry) => entry.name < ROUTING_INDEX_TARGET.migration)
    .map((entry, index) => ({
      ...entry,
      id: `receipt-${index}`,
      finished: true,
      rolled_back: false,
      steps: 1,
    }));
const snapshot = () => ({
  supportedVersion: true,
  receipts: receipts(),
  artifacts: [],
  builders: [],
  index: { present: false, exact: false },
});
const filesystem = (device, availableBytes) => ({ device, mount: '/', availableBytes });

test('routing receipt and catalog gates reject drift and incomplete prefixes', () => {
  assert.deepEqual(verifyRoutingIndexState(snapshot(), source), {
    state: 'prepare_routing',
    pending: ['routing'],
  });
  const applied = snapshot();
  applied.receipts.push({
    id: 'routing-receipt',
    name: ROUTING_INDEX_TARGET.migration,
    checksum: ROUTING_INDEX_TARGET.checksum,
    finished: true,
    rolled_back: false,
    steps: 1,
  });
  applied.index = { present: true, exact: true };
  assert.deepEqual(verifyRoutingIndexState(applied, source), {
    state: 'already_applied',
    pending: [],
  });
  for (const mutate of [
    (s) => {
      s.receipts.pop();
    },
    (s) => {
      s.receipts[0].checksum = 'f'.repeat(64);
    },
    (s) => {
      s.receipts[0].finished = false;
    },
    (s) => {
      s.receipts.push(s.receipts[0]);
    },
    (s) => {
      s.receipts.push({
        name: 'foreign',
        checksum: 'f'.repeat(64),
        finished: true,
        rolled_back: false,
        steps: 1,
      });
    },
    (s) => {
      s.index.present = true;
    },
    (s) => {
      s.builders.push({ pid: 1 });
    },
    (s) => {
      s.artifacts.push('webhook_events_chat_queue_head_idx_ccnew');
    },
    (s) => {
      s.receipts.push({ ...s.receipts[0] });
    },
    (s) => {
      s.receipts.push({
        id: 'rolled-back-foreign',
        name: 'foreign',
        checksum: 'f'.repeat(64),
        rolled_back: true,
      });
    },
    (s) => {
      s.receipts.push({
        id: 'rolled-back-routing',
        name: ROUTING_INDEX_TARGET.migration,
        checksum: ROUTING_INDEX_TARGET.checksum,
        rolled_back: true,
      });
    },
  ]) {
    const value = snapshot();
    mutate(value);
    assert.throws(() => verifyRoutingIndexState(value, source), /ROUTING_INDEX_/u);
  }
  applied.index.exact = false;
  assert.throws(() => verifyRoutingIndexState(applied, source), /INDEX_BLOCKED/u);
});

test('connection options are rejected before a preflight probe, container creation or runner inspect', async () => {
  const sha = 'a'.repeat(40);
  const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';
  const url = 'postgresql://maxim:private@postgres/maxim?options=-c%20temp_tablespaces%3Devil';
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    assert.ok(args.includes('config'));
    return {
      stdout: JSON.stringify({
        name: 'maxim',
        services: {
          'api-ingress': {
            image: `maxim-api:${sha}`,
            environment: { DATABASE_URL: url },
          },
        },
        networks: { default: { name: 'maxim_default' } },
      }),
    };
  };
  const compose = ['-f', 'infra/docker-compose.yml'];
  const env = { MAXIM_EXPECTED_DEPLOY_SHA: sha };
  await assert.rejects(
    checkRoutingIndexPrepareCapacity(compose, { run, env }),
    /DATABASE_OPTIONS_BLOCKED/u,
  );
  await assert.rejects(
    createRoutingIndexOnlineClientLauncher(compose, 'routing', { run, env }),
    /DATABASE_OPTIONS_BLOCKED/u,
  );
  let inspected = false;
  await assert.rejects(
    runRoutingIndexOnlinePrepare({
      env: { DATABASE_URL: url, MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag },
      inspect: () => {
        inspected = true;
      },
    }),
    /DATABASE_OPTIONS_BLOCKED/u,
  );
  await assert.rejects(
    runRoutingIndexOnlinePrepare({
      env: {
        DATABASE_URL: 'postgresql://maxim:private@postgres/maxim',
        PGOPTIONS: '-c temp_tablespaces=evil',
        MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
      },
      inspect: () => {
        inspected = true;
      },
    }),
    /DATABASE_OPTIONS_BLOCKED/u,
  );
  assert.equal(inspected, false);
  assert.equal(calls.length, 2);
});

function routingSupervisorFixture() {
  let time = 1_800_000_000_000;
  let launches = 0;
  const events = [];
  const safeFs = {
    device: 'data',
    mount: '/',
    availableBytes: 20 * GiB,
    roles: ['data', 'temp', 'wal', 'docker'],
  };
  const options = {
    now: () => time,
    signals: new EventEmitter(),
    readState: async () => ({ state: 'prepare_routing', pending: ['routing'] }),
    checkCapacity: async () => ({
      skipped: false,
      state: { pending: ['routing'] },
      devices: [safeFs],
      monitorPaths: {},
    }),
    readFilesystems: async () => [safeFs],
    checkRuntime: async () => {
      const timestamp = new Date(time).toISOString();
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
      return { checkedAtMs: time, ingress: probe, admin: probe };
    },
    waitForTick: async (_done, ms) => {
      time += ms;
    },
    createLauncher: async () => ({
      prepare: async () => {},
      start: () => {
        launches++;
        return new EventEmitter();
      },
    }),
    stop: async () => {},
    onProgress: (event) => events.push(event),
  };
  return {
    options,
    events,
    advance: (ms) => {
      time += ms;
    },
    launches: () => launches,
  };
}

test('routing supervisor fails closed on pressure, lost devices, disk floor and deadline', async () => {
  for (const scenario of ['pressure', 'missing', 'device', 'floor', 'deadline']) {
    const f = routingSupervisorFixture();
    let expected;
    if (scenario === 'pressure') {
      const base = f.options.checkRuntime;
      f.options.checkRuntime = async () => {
        const sample = await base();
        sample.ingress.body.checks.queueLag.effectiveLagSec = 11;
        return sample;
      };
      expected = /MULTIBOT_PREPARE_RUNTIME_ADMISSION_BLOCKED/u;
    } else if (scenario === 'missing') {
      f.options.readFilesystems = async () => {
        throw Error('MULTIBOT_PREPARE_MONITOR_UNAVAILABLE');
      };
      expected = /MULTIBOT_PREPARE_MONITOR_UNAVAILABLE/u;
    } else if (scenario === 'device') {
      f.options.readFilesystems = async () => {
        throw Error('MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED');
      };
      expected = /MULTIBOT_PREPARE_STORAGE_DEVICE_CHANGED/u;
    } else if (scenario === 'floor') {
      f.options.readFilesystems = async () => [{ availableBytes: 10 * GiB - 1 }];
      expected = /ROUTING_INDEX_RESERVE_EXHAUSTED/u;
    } else {
      f.options.createLauncher = async () => ({
        prepare: async () => {
          f.advance(2_830_000);
        },
        start: () => {
          throw Error('unexpected start');
        },
      });
      expected = /ROUTING_INDEX_DEADLINE_EXHAUSTED/u;
    }
    await assert.rejects(
      prepareRoutingIndex(['-f', 'infra/docker-compose.yml'], f.options),
      expected,
    );
    assert.equal(f.launches(), 0);
    assert.ok(f.events.every((event) => event.stage === 'routing_index_prepare'));
  }
});

test('failed routing client is cleaned only by its exact tag and never relaunched', async () => {
  const f = routingSupervisorFixture();
  const stopped = [];
  let launches = 0;
  f.options.createLauncher = async (_args, selector) => {
    assert.equal(selector, 'routing');
    return {
      prepare: async () => {},
      start: (name) => {
        launches++;
        const child = new EventEmitter();
        child.name = name;
        queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      },
    };
  };
  f.options.stop = async (_args, child, applicationName, containerName) => {
    assert.match(applicationName, /^maxim-online-[0-9a-f-]{36}$/u);
    assert.equal(containerName, applicationName);
    assert.equal(child.name, applicationName);
    stopped.push(applicationName);
  };
  await assert.rejects(
    prepareRoutingIndex(['-f', 'infra/docker-compose.yml'], f.options),
    /ROUTING_INDEX_PRISMA_DEPLOY_FAILED/u,
  );
  assert.equal(launches, 1);
  assert.equal(stopped.length, 1);
});

test('capacity sums device budgets and rejects out-of-scope table or layout', () => {
  const metadata = {
    defaultLayout: true,
    tempTablespaces: '',
    exact: true,
    tableBytes: 140 * GiB,
    approxRows: 79_000_000,
    maxWalBytes: GiB,
  };
  const fs = filesystem('shared', 500 * GiB);
  const result = assessRoutingIndexPrepareCapacity(metadata, {
    data: fs,
    temp: fs,
    wal: fs,
    docker: fs,
  });
  assert.equal(result.estimates[0].indexBytes, 140 * GiB);
  assert.equal(result.devices[0].requiredBytes, (10 + 140 + 8 + 280) * GiB);
  assert.equal(result.devices[0].sufficient, true);
  assert.throws(
    () => assessRoutingIndexPrepareCapacity({ ...metadata, tableBytes: 161 * GiB }, {}),
    /TABLE_SCOPE_EXCEEDED/u,
  );
  assert.throws(
    () => assessRoutingIndexPrepareCapacity({ ...metadata, tempTablespaces: 'other' }, {}),
    /CAPACITY_METADATA_INVALID/u,
  );
});

test('routing launcher fixes entrypoint and error mapping retains old supervisor categories', () => {
  const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';
  const args = routingIndexOnlineClientCreateArgs(tag, {
    imageId: `sha256:${'a'.repeat(64)}`,
    networkId: 'a'.repeat(64),
    networkName: 'maxim_default',
  });
  assert.equal(args.at(-1), 'scripts/agent/routing-index-online-prepare.mjs');
  assert.equal(
    routingIndexFailureCode(new Error('OUTCOME_COHORT_CLEANUP_UNCONFIRMED')),
    'ROUTING_INDEX_CLEANUP_UNCONFIRMED',
  );
  assert.equal(routingIndexFailureCode(new Error('secret')), 'ROUTING_INDEX_PREPARATION_FAILED');
});

test('runner exposes only the fixed prefix and rechecks the resulting state', async () => {
  let inspections = 0;
  let prefix;
  const result = await runRoutingIndexOnlinePrepare({
    root: resolve(import.meta.dirname, '../..'),
    env: {
      DATABASE_URL: 'postgresql://fixture:private@localhost/race_test',
      MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53',
    },
    inspect: async () =>
      ++inspections === 1
        ? { state: 'prepare_routing', pending: ['routing'] }
        : { state: 'already_applied', pending: [] },
    runPrisma: (_command, args, options) => {
      prefix = resolve(args[4], '..');
      assert.equal(statSync(args[4]).mode & 0o777, 0o600);
      assert.deepEqual(
        readdirSync(resolve(prefix, 'migrations'))
          .filter((name) => name !== 'migration_lock.toml')
          .sort(),
        source
          .filter((entry) => entry.name <= ROUTING_INDEX_TARGET.migration)
          .map((entry) => entry.name)
          .sort(),
      );
      assert.equal(options.timeout, 2_730_000);
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { state: 'applied' });
  assert.equal(inspections, 2);
  assert.equal(existsSync(prefix), false);
});
