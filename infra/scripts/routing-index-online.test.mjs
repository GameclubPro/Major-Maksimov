import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  ROUTING_INDEX_TARGET,
  readRoutingIndexSource,
  verifyRoutingIndexDatabaseUrl,
} from '../../scripts/agent/routing-index-online-target.mjs';
import {
  readReleaseRoutingSource,
  readReleaseRoutingState,
  verifyReleaseRoutingState,
  verifyRoutingIndexState,
} from './routing-index-online-state.mjs';
import { OUTCOME_COHORT_TARGETS } from '../../scripts/agent/outcome-cohort-online-targets.mjs';
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
const supersededMigration = '20261103120000_index_webhook_chat_queue_head';
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

test('release admission defers only the sole optional migration with exact ordered index proof', () => {
  const pending = { ...snapshot(), orderedIndex: { present: true, exact: true } };
  const release = { source, supportsOrdered: true };
  assert.equal(verifyReleaseRoutingState(pending, release), 'compatible_pending');
  assert.equal(verifyRoutingIndexState(pending, source).state, 'prepare_routing');
  assert.equal(
    verifyReleaseRoutingState(pending, { ...release, supportsOrdered: false }),
    'prepare_routing',
  );
  for (const orderedIndex of [
    undefined,
    { present: false, exact: false },
    { present: true, exact: false },
  ])
    assert.equal(
      verifyReleaseRoutingState({ ...pending, orderedIndex }, release),
      'prepare_routing',
    );
  assert.equal(
    verifyReleaseRoutingState(pending, {
      ...release,
      source: [
        ...source,
        {
          name: '20990101120000_later_migration',
          checksum: 'a'.repeat(64),
        },
      ],
    }),
    'prepare_routing',
  );
  for (const change of [
    { builders: [{ pid: 99 }] },
    { artifacts: ['webhook_events_chat_queue_head_idx_ccold'] },
    { index: { present: true, exact: false } },
    { receipts: pending.receipts.slice(1) },
    {
      receipts: [
        ...pending.receipts,
        {
          ...pending.receipts[0],
          id: 'pending',
          name: ROUTING_INDEX_TARGET.migration,
          finished: false,
        },
      ],
    },
  ])
    assert.throws(
      () => verifyReleaseRoutingState({ ...pending, ...change }, release),
      /ROUTING_INDEX_/u,
    );
});

test('release proof uses the selected commit for migration bytes, identity and compatibility marker', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'routing-release-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  const commit = () => {
    git('add', '--all');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const migrations = 'apps/api/prisma/migrations';
  const copyMigration = (name) => {
    mkdirSync(resolve(root, migrations, name), { recursive: true });
    copyFileSync(
      resolve(import.meta.dirname, '../..', migrations, name, 'migration.sql'),
      resolve(root, migrations, name, 'migration.sql'),
    );
  };
  for (const { migration } of OUTCOME_COHORT_TARGETS) copyMigration(migration);
  const service = resolve(root, 'apps/api/src/webhook/webhook-routing.service.ts');
  mkdirSync(resolve(service, '..'), { recursive: true });
  writeFileSync(service, '// Previously released routing.\n');
  const old = commit();
  copyMigration(ROUTING_INDEX_TARGET.migration);
  const required = commit();
  const marker =
    '// FLAG: Routing uses the existing ordered chat head index without the optional queue index.\n';
  writeFileSync(service, marker);
  const optional = commit();
  const compose = ['-f', 'infra/docker-compose.yml'];
  const rootOnly = {
    root,
    run: async () => assert.fail('pre-routing release must not query PostgreSQL'),
  };
  assert.equal(await readReleaseRoutingState(old, compose, rootOnly), 'not_in_target');
  assert.throws(() => readReleaseRoutingSource(root, 'HEAD'), /TARGET_INVALID/u);
  assert.throws(
    () => readReleaseRoutingSource(root, git('rev-parse', 'HEAD^{tree}')),
    /TARGET_INVALID/u,
  );
  const target = readReleaseRoutingSource(root, optional);
  assert.equal(target.supportsOrdered, true);
  assert.equal(readReleaseRoutingSource(root, required).supportsOrdered, false);
  const state = snapshot();
  state.orderedIndex = { present: true, exact: true };
  state.receipts = state.receipts.filter((r) => target.source.some((m) => m.name === r.name));
  const read = (sha) =>
    readReleaseRoutingState(sha, compose, {
      root,
      run: async () => ({ stdout: JSON.stringify(state) }),
    });
  writeFileSync(service, '// Worktree contents have no authority.\n');
  assert.equal(await read(optional), 'compatible_pending');
  assert.equal(await read(required), 'prepare_routing');
  writeFileSync(
    resolve(root, migrations, ROUTING_INDEX_TARGET.migration, 'migration.sql'),
    'SELECT 1;\n',
  );
  assert.throws(() => readReleaseRoutingSource(root, commit()), /TARGET_SOURCE_INVALID/u);
  rmSync(resolve(root, migrations, ROUTING_INDEX_TARGET.migration), { recursive: true });
  assert.throws(() => readReleaseRoutingSource(root, commit()), /TARGET_SOURCE_INVALID/u);
  mkdirSync(resolve(root, migrations, supersededMigration), { recursive: true });
  writeFileSync(resolve(root, migrations, supersededMigration, 'migration.sql'), 'SELECT 1;\n');
  assert.throws(() => readReleaseRoutingSource(root, commit()), /TARGET_SOURCE_INVALID/u);
});

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
  for (const steps of [0, 2]) {
    const invalid = structuredClone(applied);
    invalid.receipts.at(-1).steps = steps;
    assert.throws(() => verifyRoutingIndexState(invalid, source), /RECEIPT_BLOCKED/u);
  }
  for (const value of [snapshot(), applied]) {
    for (const [finished, rolledBack] of [
      [true, false],
      [false, false],
      [false, true],
    ]) {
      const invalid = structuredClone(value);
      invalid.receipts.push({
        id: 'superseded-routing',
        name: supersededMigration,
        checksum: ROUTING_INDEX_TARGET.checksum,
        finished,
        rolled_back: rolledBack,
        steps: finished ? 1 : 0,
      });
      assert.throws(() => verifyRoutingIndexState(invalid, source), /RECEIPT_BLOCKED/u);
    }
  }
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

test('routing accepts only exact recovered predecessor attempts with a later successful receipt', () => {
  const failedAttempts = [
    [
      '20260621120000_optimize_spammer_review',
      '456919e50cecb0b00a54d65ccb346598f9781498c446179e483ea99cf2e93c95',
    ],
    [
      '20260628133000_managed_broadcast_lock_tokens_and_validated_invariants',
      '4534eb15d6901acbbc8b48431c43f2a156bb5db99cf518daa4165687c4a9fa28',
    ],
    [
      '20260706193000_channel_suggestion_admin_delivery_ledger',
      'e2130f6974440b0dfe2d755ffab65aaa19544655b69208df377d9a9012e62de0',
    ],
    [
      '20260718100000_add_publication_delivery_content_revision',
      'c0c095a4943c31d34262c589df61d59466d5119a09d7dca8934362ddc53f26ca',
    ],
  ];
  const state = snapshot();
  for (const [name, checksum] of failedAttempts) {
    const applied = state.receipts.find((row) => row.name === name);
    assert.ok(applied);
    applied.started_at = '2026-08-01T00:01:00Z';
    state.receipts.push({
      id: `failed-${applied.id}`,
      name,
      checksum,
      started_at: '2026-08-01T00:00:00Z',
      finished: false,
      rolled_back: true,
      steps: 0,
    });
  }
  assert.deepEqual(verifyRoutingIndexState(state, source), {
    state: 'prepare_routing',
    pending: ['routing'],
  });
  for (const mutate of [
    (s, failed) => {
      failed.checksum = '0'.repeat(64);
    },
    (s, failed) => {
      failed.finished = true;
    },
    (s, failed) => {
      failed.rolled_back = false;
    },
    (s, failed) => {
      failed.steps = 1;
    },
    (s, failed) => {
      failed.started_at = '2026-08-01T00:01:00Z';
    },
    (s, failed) => {
      failed.started_at = null;
    },
    (s, failed) => {
      s.receipts.push({ ...failed, id: 'second-failed-receipt' });
    },
    (s, failed, applied) => {
      applied.steps = 0;
    },
    (s, failed, applied) => {
      applied.checksum = failed.checksum;
    },
    (s, failed, applied) => {
      s.receipts.splice(s.receipts.indexOf(applied), 1);
    },
  ]) {
    const invalid = structuredClone(state);
    const failed = invalid.receipts.at(-1);
    const applied = invalid.receipts.find((row) => row.name === failed.name && !row.rolled_back);
    mutate(invalid, failed, applied);
    assert.throws(() => verifyRoutingIndexState(invalid, source), /RECEIPT_BLOCKED/u);
  }
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

test('the routing URI cannot override the inspected database authority', () => {
  const url = 'postgresql://maxim:private@postgres:5432/maxim';
  const safe = `${url}?schema=public&connection_limit=6&connect_timeout=5`;
  assert.equal(verifyRoutingIndexDatabaseUrl(safe), safe);
  for (const query of [
    'port=5433',
    '%70ort=5433',
    'user=another',
    'host=elsewhere',
    'database=another',
    'dbname=another',
    'schema=other',
    'schema=public&schema=public',
  ]) {
    assert.throws(
      () => verifyRoutingIndexDatabaseUrl(`${url}?${query}`),
      /DATABASE_OPTIONS_BLOCKED/u,
    );
  }
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
