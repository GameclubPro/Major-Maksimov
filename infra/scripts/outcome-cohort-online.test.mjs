import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  OUTCOME_COHORT_TARGETS,
  readOutcomeCohortSource,
  requireOutcomeCohortTarget,
} from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import { runOutcomeCohortOnlinePrepare } from '../../scripts/agent/outcome-cohort-online-prepare.mjs';
import {
  verifyOutcomeCohortPreparationState,
  outcomeCohortStateSql,
  projectOutcomeCohortPreview,
} from './outcome-cohort-online-state.mjs';
import {
  assessOutcomeCohortPrepareCapacity,
  checkOutcomeCohortPrepareCapacity,
} from './outcome-cohort-prepare-capacity.mjs';
import {
  prepareOutcomeCohortIndexes,
  OUTCOME_COHORT_TOTAL_MS,
} from './outcome-cohort-online-supervisor.mjs';
import {
  multibotOnlineClientCreateArgs,
  outcomeCohortOnlineClientCreateArgs,
} from './multibot-online-client.mjs';

const root = resolve(import.meta.dirname, '../..');
const source = readOutcomeCohortSource(root);
const tag = 'maxim-online-61bfd8a3-9d75-4ec2-9b1c-89f325387e53';
const compose = ['-f', 'infra/docker-compose.yml'];
const GiB = 1024 ** 3;
function snapshot(applied = []) {
  return {
    artifacts: [],
    builders: [],
    indexes: OUTCOME_COHORT_TARGETS.map((target) => ({
      selector: target.selector,
      present: applied.includes(target.selector),
      exact: applied.includes(target.selector),
    })),
    receipts: source
      .filter(
        (m) =>
          m.name < OUTCOME_COHORT_TARGETS[0].migration ||
          OUTCOME_COHORT_TARGETS.some(
            (t) => t.migration === m.name && applied.includes(t.selector),
          ),
      )
      .map((migration) => ({ ...migration, finished: true, rolled_back: false, steps: 1 })),
  };
}
const state = (applied = []) => verifyOutcomeCohortPreparationState(snapshot(applied), source);

test('frozen migrations match source bytes and target ordering; selectors are closed', () => {
  assert.equal(
    source.find((s) => s.name === OUTCOME_COHORT_TARGETS[0].migration).checksum,
    OUTCOME_COHORT_TARGETS[0].checksum,
  );
  assert.equal(
    source.find((s) => s.name === OUTCOME_COHORT_TARGETS[1].migration).checksum,
    OUTCOME_COHORT_TARGETS[1].checksum,
  );
  assert.throws(() => requireOutcomeCohortTarget('../../migration'), /TARGET_INVALID/u);
  assert.deepEqual(state(), { state: 'prepare_delete', pending: ['delete', 'recipient'] });
  assert.deepEqual(state(['delete']), { state: 'prepare_recipient', pending: ['recipient'] });
  assert.deepEqual(state(['delete', 'recipient']), { state: 'already_applied', pending: [] });
});

test('receipts, complete prefix and exact catalog are independent fail-closed gates', () => {
  for (const mutate of [
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
      s.receipts.shift();
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
      s.indexes[0].present = true;
    },
    (s) => {
      s.artifacts.push('retained_ccnew');
    },
    (s) => {
      s.builders.push({ selector: 'delete', pid: 123, application_name: null });
    },
    (s) => {
      s.receipts = Array.from({ length: 4097 }, () => s.receipts[0]);
    },
  ]) {
    const value = snapshot();
    mutate(value);
    assert.throws(() => verifyOutcomeCohortPreparationState(value, source), /OUTCOME_COHORT_/u);
  }
  const value = snapshot(['delete']);
  value.indexes[0].exact = false;
  assert.throws(() => verifyOutcomeCohortPreparationState(value, source), /INDEX_BLOCKED/u);
  const retained = snapshot();
  retained.receipts.push({ finished: false, rolled_back: true });
  assert.equal(verifyOutcomeCohortPreparationState(retained, source).state, 'prepare_delete');
  for (const predicate of [
    'indisvalid',
    'indisready',
    'indislive',
    'indoption',
    'opcdefault',
    'attcollation',
    'reloptions',
    'indnkeyatts',
  ])
    assert.ok(outcomeCohortStateSql.includes(predicate));
});

test('fixed recovery preview reports retained failure without printing raw logs or widening targets', () => {
  const value = snapshot();
  value.receipts.push({
    id: 'receipt-id',
    name: OUTCOME_COHORT_TARGETS[0].migration,
    checksum: OUTCOME_COHORT_TARGETS[0].checksum,
    started_at: '2026-10-17T00:00:00Z',
    finished: false,
    rolled_back: false,
    steps: 0,
    failure_family: 'canceled',
    logs: 'private-log',
  });
  const result = projectOutcomeCohortPreview(value, source);
  assert.equal(result.state, 'OUTCOME_COHORT_RECEIPT_BLOCKED');
  assert.equal(result.targets[0].receipts[0].failureFamily, 'canceled');
  assert.equal(JSON.stringify(result).includes('private-log'), false);
  value.builders = Array.from({ length: 17 }, () => ({}));
  assert.throws(() => projectOutcomeCohortPreview(value, source), /PREVIEW_CAPPED/u);
});

test('runner attests before Prisma, exposes only selected immutable prefix and cleans it', async () => {
  let calls = 0,
    prefix;
  const result = await runOutcomeCohortOnlinePrepare({
    root,
    selector: 'delete',
    env: {
      DATABASE_URL: 'postgresql://fixture:private@localhost/race_test',
      MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
    },
    inspect: async (url) => {
      assert.ok(url.endsWith(`application_name=${tag}`));
      return state(calls ? ['delete'] : []);
    },
    runPrisma: (_command, args, options) => {
      calls += 1;
      assert.deepEqual(args.slice(1, 4), ['migrate', 'deploy', '--config']);
      prefix = resolve(args[4], '..');
      assert.equal(statSync(prefix).mode & 0o777, 0o700);
      assert.equal(statSync(args[4]).mode & 0o777, 0o600);
      const names = readdirSync(resolve(prefix, 'migrations')).filter(
        (name) => name !== 'migration_lock.toml',
      );
      assert.deepEqual(
        names,
        source.filter((m) => m.name <= OUTCOME_COHORT_TARGETS[0].migration).map((m) => m.name),
      );
      assert.equal(options.stdio, 'ignore');
      assert.equal(options.timeout, 1_830_000);
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { state: 'applied', selector: 'delete' });
  assert.equal(calls, 1);
  assert.equal(existsSync(prefix), false);
});

test('runner refuses missing tag/prerequisite and never retries failed Prisma', async () => {
  let calls = 0;
  const env = {
    DATABASE_URL: 'postgresql://fixture:private@localhost/race_test',
    MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag,
  };
  await assert.rejects(
    runOutcomeCohortOnlinePrepare({
      selector: 'delete',
      env: {},
      inspect: () => {
        throw Error('unexpected');
      },
    }),
    /TAGGED_DATABASE_REQUIRED/u,
  );
  await assert.rejects(
    runOutcomeCohortOnlinePrepare({ selector: 'recipient', env, inspect: async () => state() }),
    /PREDECESSOR_PENDING/u,
  );
  await assert.rejects(
    runOutcomeCohortOnlinePrepare({
      selector: 'delete',
      env,
      inspect: async () => state(),
      runPrisma: () => {
        calls += 1;
        return { status: 1 };
      },
    }),
    /PRISMA_DEPLOY_FAILED/u,
  );
  assert.equal(calls, 1);
});

const metadata = () => ({
  defaultLayout: true,
  tempTablespaces: '',
  maxWalBytes: GiB,
  tables: OUTCOME_COHORT_TARGETS.map((t) => ({
    selector: t.selector,
    exact: true,
    tableBytes: 100_000_000,
    orderedIndexBytes: 10_000_000,
    approxRows: 100_000,
  })),
});
const filesystem = (device = '/dev/fixture', availableBytes = 30 * GiB) => ({
  device,
  mount: '/fixture',
  availableBytes,
});
const filesystems = () => ({
  data: filesystem(),
  temp: filesystem(),
  wal: filesystem(),
  docker: filesystem(),
});

test('shared physical device counts reserve once but enforces all incremental budgets', () => {
  const result = assessOutcomeCohortPrepareCapacity(metadata(), filesystems(), [
    'delete',
    'recipient',
  ]);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].requiredBytes, 10 * GiB + 200_000_000 + 2 * GiB + 2 * GiB);
  const fs = filesystems();
  fs.docker = filesystem('/dev/docker');
  const split = assessOutcomeCohortPrepareCapacity(metadata(), fs, ['recipient']);
  assert.equal(split.devices.length, 2);
  assert.equal(split.devices[1].requiredBytes, 10 * GiB);
  const low = filesystems();
  low.data.availableBytes = 10 * GiB;
  assert.equal(
    assessOutcomeCohortPrepareCapacity(metadata(), low, ['delete']).devices[0].sufficient,
    false,
  );
  const oversized = metadata();
  oversized.tables[0].tableBytes = 4 * GiB + 1;
  assert.throws(
    () => assessOutcomeCohortPrepareCapacity(oversized, fs, ['delete']),
    /TABLE_SCOPE_EXCEEDED/u,
  );
  assert.doesNotThrow(() => assessOutcomeCohortPrepareCapacity(oversized, fs, ['recipient']));
  const invalid = metadata();
  invalid.tables[0].approxRows = -1;
  assert.throws(
    () => assessOutcomeCohortPrepareCapacity(invalid, fs, ['delete']),
    /METADATA_INVALID/u,
  );
});

test('already-applied exact state performs no capacity/table growth probes', async () => {
  assert.deepEqual(
    await checkOutcomeCohortPrepareCapacity(compose, {
      state: state(['delete', 'recipient']),
      run: () => {
        throw Error('unexpected capacity command');
      },
    }),
    { skipped: true, state: state(['delete', 'recipient']) },
  );
});

test('outcome client changes only its fixed image command; old profile unchanged', () => {
  const identity = {
    imageId: `sha256:${'a'.repeat(64)}`,
    networkId: 'b'.repeat(64),
    networkName: 'fixture_default',
  };
  const old = multibotOnlineClientCreateArgs(tag, identity);
  for (const selector of ['delete', 'recipient']) {
    const next = outcomeCohortOnlineClientCreateArgs(tag, identity, selector);
    assert.deepEqual(next.slice(0, -2), old.slice(0, -1));
    assert.deepEqual(next.slice(-2), ['scripts/agent/outcome-cohort-online-prepare.mjs', selector]);
  }
  assert.equal(old.at(-1), 'scripts/agent/multibot-online-prepare.mjs');
  assert.throws(
    () => outcomeCohortOnlineClientCreateArgs(tag, identity, 'arbitrary'),
    /TARGET_INVALID/u,
  );
});

function supervisorFixture() {
  let time = 1_800_000_000_000;
  const applied = [],
    events = [],
    launches = [],
    stops = [];
  const signals = new EventEmitter();
  const sample = () => {
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
  };
  const options = {
    now: () => time,
    signals,
    onProgress: (event) => events.push(event),
    readState: async () => state(applied),
    checkCapacity: async () => ({
      skipped: false,
      state: state(applied),
      devices: [{ ...filesystem(), roles: ['data', 'temp', 'wal', 'docker'] }],
      monitorPaths: {},
    }),
    readFilesystems: async () => [filesystem()],
    checkRuntime: async () => sample(),
    waitForTick: async (_done, ms) => {
      time += ms;
    },
    createLauncher: async (_args, selector) => ({
      prepare: async () => {},
      start: (name) => {
        const child = new EventEmitter();
        child.kill = () => {};
        launches.push({ selector, name, time });
        queueMicrotask(() => {
          applied.push(selector);
          child.emit('exit', 0, null);
        });
        return child;
      },
    }),
    stop: async (_args, _child, name, container) => {
      assert.equal(name, container);
      stops.push(name);
      time += 40_300;
    },
  };
  return {
    options,
    events,
    launches,
    stops,
    applied,
    signals,
    advance: (ms) => {
      time += ms;
    },
  };
}

test('two fresh admission windows and sequential clients share one absolute deadline and heartbeat', async () => {
  const f = supervisorFixture();
  assert.deepEqual(await prepareOutcomeCohortIndexes(compose, f.options), {
    state: 'already_applied',
  });
  assert.equal(f.launches.length, 2);
  assert.equal(f.stops.length, 2);
  assert.notEqual(f.launches[0].name, f.launches[1].name);
  const admissions = f.events.filter((event) => event.phase === 'admission');
  assert.equal(admissions.length, 2);
  assert.ok(f.launches[0].time >= 1_800_000_120_000);
  assert.ok(f.launches[1].time - f.launches[0].time >= 160_300);
  assert.equal(new Set(f.events.map((event) => event.deadlineAt)).size, 1);
  assert.ok(
    f.events.some(
      (event) => event.phase === 'admission_sample' && event.lastStorageAt && event.lastRuntimeAt,
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    assert.equal(f.signals.listenerCount(signal), 0);
});

test('lost storage/runtime observation aborts before a client; unhealthy admission never resets silently', async () => {
  for (const field of ['readFilesystems', 'checkRuntime']) {
    const f = supervisorFixture();
    f.options[field] = async () => {
      throw Error('probe unavailable');
    };
    await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), /PREPARATION_FAILED/u);
    assert.equal(f.launches.length, 0);
  }
  const f = supervisorFixture();
  const original = f.options.checkRuntime;
  f.options.checkRuntime = async () => {
    const sample = await original();
    sample.ingress.body.checks.queueLag.effectiveLagSec = 11;
    return sample;
  };
  await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), /ADMISSION_BLOCKED/u);
  assert.equal(f.launches.length, 0);
});

test('deadline reserves cleanup and failure never launches the next target', async () => {
  const f = supervisorFixture();
  f.options.createLauncher = async () => ({
    prepare: async () => {
      f.advance(OUTCOME_COHORT_TOTAL_MS - 170_000);
    },
    start: () => {
      throw Error('must not start after work deadline');
    },
  });
  await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), /DEADLINE_EXHAUSTED/u);
  assert.equal(f.stops.length, 1);
  assert.equal(f.launches.length, 0);
  assert.ok(
    Date.parse(f.events.at(-1).deadlineAt) >=
      1_800_000_000_000 + 120_000 + OUTCOME_COHORT_TOTAL_MS - 170_000 + 40_300,
  );
});

test('unconfirmed create remains unconfirmed even when owned cleanup finds no container', async () => {
  const f = supervisorFixture();
  f.options.createLauncher = async () => ({
    prepare: async () => {
      throw Error('timeout');
    },
  });
  await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), /CLEANUP_UNCONFIRMED/u);
  assert.equal(f.stops.length, 1);
  assert.equal(f.launches.length, 0);
});

test('interruption between targets prevents the second client; all-applied avoids health/build work', async () => {
  const f = supervisorFixture();
  f.options.onProgress = (event) => {
    f.events.push(event);
    if (event.phase === 'target_verified') f.signals.emit('SIGTERM');
  };
  await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), /INTERRUPTED/u);
  assert.equal(f.launches.length, 1);
  const g = supervisorFixture();
  g.applied.push('delete', 'recipient');
  g.options.checkCapacity = () => {
    throw Error('growth scope must not apply');
  };
  assert.equal((await prepareOutcomeCohortIndexes(compose, g.options)).state, 'already_applied');
});

test('deploy gates precede quiescence, new image imports ship, historical cutoff unchanged', () => {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  assert.ok(
    deploy.indexOf('  maxim_outcome_cohort_preflight COMPOSE_FILES') <
      deploy.indexOf('\nprepare_deploy_disk_capacity\n'),
  );
  assert.ok(
    deploy.indexOf('  maxim_outcome_cohort_prepare\n') <
      deploy.indexOf('  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES'),
  );
  assert.ok(
    deploy.indexOf('  maxim_outcome_cohort_assert COMPOSE_FILES') >
      deploy.indexOf('  if ! run_migrations; then'),
  );
  const dockerfile = readFileSync(resolve(root, 'apps/api/Dockerfile'), 'utf8');
  for (const file of [
    'scripts/agent/outcome-cohort-online-targets.mjs',
    'scripts/agent/outcome-cohort-online-prepare.mjs',
    'scripts/agent/outcome-cohort-historical-compatibility.mjs',
    'infra/scripts/outcome-cohort-online-state.mjs',
    'scripts/agent/routing-index-online-target.mjs',
    'scripts/agent/routing-index-online-prepare.mjs',
    'infra/scripts/routing-index-online-state.mjs',
    'infra/scripts/online-migration-receipts.mjs',
  ])
    assert.ok(dockerfile.includes(file));
  const old = readFileSync(resolve(root, 'scripts/agent/multibot-online-prepare.mjs'), 'utf8');
  assert.ok(
    old.includes("MULTIBOT_ONLINE_PREFIX_NAME = '20261005016100_index_multibot_retention_cursor'"),
  );
});

test('outcome image modules load from the narrow Docker context and isolated runtime layout', () => {
  const dockerfile = readFileSync(resolve(root, 'apps/api/Dockerfile'), 'utf8');
  const statePath = 'infra/scripts/outcome-cohort-online-state.mjs';
  const infrastructureModules = [
    statePath,
    'infra/scripts/routing-index-online-state.mjs',
    'infra/scripts/online-migration-receipts.mjs',
  ];
  const copyLines = dockerfile.split(/\r?\n/u).filter((line) => line.startsWith('COPY '));
  for (const file of infrastructureModules) assert.ok(copyLines.includes(`COPY ${file} ./${file}`));
  assert.ok(copyLines.includes('COPY scripts scripts'));
  const exceptions = readFileSync(resolve(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!infra/scripts'));
  assert.deepEqual(
    exceptions,
    infrastructureModules.map((file) => `!${file}`),
  );

  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-outcome-image-modules-'));
  const modules = [
    'scripts/agent/multibot-online-prepare.mjs',
    'scripts/agent/outcome-cohort-online-targets.mjs',
    'scripts/agent/outcome-cohort-online-prepare.mjs',
    'scripts/agent/outcome-cohort-historical-compatibility.mjs',
    'scripts/agent/routing-index-online-target.mjs',
    'scripts/agent/routing-index-online-prepare.mjs',
    ...infrastructureModules,
  ];
  try {
    for (const file of modules) {
      if (!infrastructureModules.includes(file)) {
        assert.ok(copyLines.includes(`COPY --from=build /app/${file} ./${file}`), file);
      }
      const destination = resolve(directory, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(root, file), destination);
    }
    assert.equal(
      existsSync(resolve(directory, 'infra/scripts/multibot-prepare-capacity.mjs')),
      false,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
import assert from 'node:assert/strict';
const runner = await import(process.argv[1]);
const state = await import(process.argv[2]);
const routing = await import(process.argv[3]);
const routingState = await import(process.argv[4]);
assert.equal(typeof state.outcomeCohortStateSql, 'string');
assert.throws(() => state.verifyOutcomeCohortPreparationState({}, []), /STATE_INVALID/);
await assert.rejects(runner.runOutcomeCohortOnlinePrepare({ selector: 'delete', env: {} }), /TAGGED_DATABASE_REQUIRED/);
assert.equal(typeof routingState.routingIndexStateSql, 'string');
await assert.rejects(routing.runRoutingIndexOnlinePrepare({ env: {} }), /TAGGED_DATABASE_REQUIRED/);
`,
        pathToFileURL(resolve(directory, modules[2])).href,
        pathToFileURL(resolve(directory, statePath)).href,
        pathToFileURL(resolve(directory, 'scripts/agent/routing-index-online-prepare.mjs')).href,
        pathToFileURL(resolve(directory, 'infra/scripts/routing-index-online-state.mjs')).href,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('new shell hook preserves complete migration scope and aborts without quiescence on failure', () => {
  for (const failure of ['none', 'prepare', 'authority']) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
ROOT_DIR="$1"
source "$ROOT_DIR/infra/scripts/lib/outcome-cohort-online-prepare.sh"
failure="$2"
MAXIM_API_IMAGE=maxim-api:fixture
MIGRATION_COMPOSE_FILES=(--env-file '/private/fixture env' -p fixture -f base.yml -f overlay.yml)
maxim_require_ordinary_effect_authority() { [[ "$failure" != authority ]]; }
ensure_compose_env() { echo env-verified; }
node() {
  local script="$1" mode="$2"
  shift 2
  [[ "$*" == '--env-file /private/fixture env -p fixture -f base.yml -f overlay.yml' ]] || return 98
  case "$script:$mode" in
    "$ROOT_DIR/infra/scripts/outcome-cohort-online-supervisor.mjs:prepare")
      [[ "$MAXIM_MIGRATION_API_IMAGE" == "$MAXIM_API_IMAGE" ]] || return 99
      echo prepare
      [[ "$failure" != prepare ]] ;;
    "$ROOT_DIR/infra/scripts/outcome-cohort-online-state.mjs:assert") echo asserted ;;
    *) return 97 ;;
  esac
}
maxim_outcome_cohort_prepare
echo quiescence-reachable
`,
        'outcome-hook-fixture',
        root,
        failure,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (failure === 'none') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /prepare\nasserted\nquiescence-reachable/u);
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /asserted|quiescence-reachable/u);
    }
  }
});

test('outcome image smoke refuses non-CI, foreign source SHA and remote Docker before commands', () => {
  const smoke = resolve(root, 'infra/scripts/smoke-outcome-cohort-online-client-ci.sh');
  for (const overrides of [
    { GITHUB_ACTIONS: '' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { DOCKER_HOST: 'tcp://foreign:2375' },
  ]) {
    const result = spawnSync('bash', [smoke, '--bounded', `maxim-api:${'a'.repeat(40)}`], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'a'.repeat(40),
        DOCKER_CONTEXT: '',
        DOCKER_HOST: '',
        ...overrides,
      },
    });
    assert.equal(result.status, 2);
  }
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(
    workflow.includes(
      'run: node --test --test-concurrency=1 infra/scripts/outcome-cohort-online.native.test.mjs',
    ),
  );
  assert.ok(
    workflow.indexOf('bash infra/scripts/smoke-outcome-cohort-online-client-ci.sh') <
      workflow.indexOf('name: Package immutable production image'),
  );
});

test('a successful but late probe cannot erase a storage or runtime observation gap', async () => {
  for (const [field, gap, code] of [
    ['readFilesystems', 11_000, 'STORAGE_SAMPLE_GAP'],
    ['checkRuntime', 31_000, 'RUNTIME_SAMPLE_GAP'],
  ]) {
    const f = supervisorFixture();
    const original = f.options[field];
    let calls = 0;
    f.options[field] = async (...args) => {
      if (++calls === 2) f.advance(gap);
      return original(...args);
    };
    await assert.rejects(prepareOutcomeCohortIndexes(compose, f.options), new RegExp(code, 'u'));
    assert.equal(f.launches.length, 0);
    const previous = field === 'readFilesystems' ? 'lastStorageAt' : 'lastRuntimeAt';
    assert.equal(f.events.at(-1)[previous], new Date(1_800_000_000_000).toISOString());
  }
});
