import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DockerStoreError,
  dockerStoreFailureMessage,
  prepareDockerStore,
  verifyDockerStore,
} from './prepare-docker-store.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const required = (version = '29.3.1') => ({
  serverVersion: version,
  driver: 'overlayfs',
  driverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
});
const classic = () => ({
  serverVersion: '28.0.4',
  driver: 'overlay2',
  driverStatus: [['Backing Filesystem', 'extfs']],
});
const failure = (error) =>
  error instanceof DockerStoreError &&
  error.code === 'DOCKER_STORE_INVALID' &&
  error.message === dockerStoreFailureMessage &&
  !error.cause;

function runner({
  information = [classic(), required()],
  containers = '',
  context = 'default',
  endpoint = 'unix:///var/run/docker.sock',
  onRestart,
  expectedEnv = hosted,
} = {}) {
  const calls = [];
  let infoIndex = 0;
  const run = (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.equal(options.maxBuffer, 65_536);
    assert.ok(options.timeout > 0 && options.timeout <= 60_000);
    assert.equal(options.env, expectedEnv);
    if (binary === 'systemctl') {
      assert.deepEqual(args, ['restart', 'docker.service']);
      onRestart?.();
      return '';
    }
    assert.equal(binary, 'docker');
    if (args[0] === 'context' && args[1] === 'show') {
      assert.deepEqual(args, ['context', 'show']);
      return context;
    }
    if (args[0] === 'context' && args[1] === 'inspect') {
      assert.deepEqual(args, [
        'context',
        'inspect',
        'default',
        '--format',
        '{{.Endpoints.docker.Host}}',
      ]);
      return endpoint;
    }
    if (args[0] === 'info') {
      assert.equal(args[1], '--format');
      assert.equal(
        args[2],
        '{"serverVersion":{{json .ServerVersion}},"driver":{{json .Driver}},"driverStatus":{{json .DriverStatus}}}',
      );
      const info = information[Math.min(infoIndex++, information.length - 1)];
      return typeof info === 'string' ? info : JSON.stringify(info);
    }
    assert.deepEqual(args, ['container', 'ls', '--all', '--quiet']);
    return containers;
  };
  return { run, calls };
}

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-docker-store-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = join(root, 'docker');
  return {
    root,
    configDirectory,
    configPath: join(configDirectory, 'daemon.json'),
    temporary: join(configDirectory, '.maxim-containerd-daemon.tmp'),
    options: { env: hosted, configDirectory, uid: 0, ownerUid: process.getuid() },
  };
}

function existingConfig(
  data,
  value = { debug: false, 'log-driver': 'local', features: { 'other-feature': true } },
  mode = 0o640,
) {
  fs.mkdirSync(data.configDirectory, { mode: 0o755 });
  fs.writeFileSync(data.configPath, typeof value === 'string' ? value : JSON.stringify(value), {
    mode,
  });
  fs.chmodSync(data.configPath, mode);
  return fs.readFileSync(data.configPath);
}

test('prepares only the existing default daemon before work and verifies its actual backend after the fixed service restart', (t) => {
  const data = fixture(t);
  const initial = {
    debug: false,
    'log-driver': 'local',
    features: { 'other-feature': true, 'containerd-snapshotter': false },
    labels: ['preserve=value'],
  };
  existingConfig(data, initial);
  const events = [];
  const commands = runner({
    onRestart() {
      events.push('restart');
      assert.deepEqual(JSON.parse(fs.readFileSync(data.configPath, 'utf8')), {
        ...initial,
        features: { ...initial.features, 'containerd-snapshotter': true },
      });
      assert.equal(fs.statSync(data.configPath).mode & 0o777, 0o640);
    },
  });
  const fileSystem = {
    ...fs,
    fsyncSync(descriptor) {
      events.push(fs.fstatSync(descriptor).isDirectory() ? 'fsync-directory' : 'fsync-file');
      fs.fsyncSync(descriptor);
    },
    renameSync(from, to) {
      assert.equal(from, data.temporary);
      assert.equal(to, data.configPath);
      events.push('rename');
      fs.renameSync(from, to);
    },
  };
  const output = prepareDockerStore({ ...data.options, run: commands.run, fileSystem });
  assert.deepEqual(output, {
    serverVersion: '29.3.1',
    driver: 'overlayfs',
    driverType: 'io.containerd.snapshotter.v1',
  });
  assert.deepEqual(events, ['fsync-file', 'rename', 'fsync-directory', 'restart']);
  assert.deepEqual(
    commands.calls.map(({ binary, args }) => [binary, ...args.slice(0, 2)]),
    [
      ['docker', 'context', 'show'],
      ['docker', 'context', 'inspect'],
      ['docker', 'info', '--format'],
      ['docker', 'container', 'ls'],
      ['systemctl', 'restart', 'docker.service'],
      ['docker', 'context', 'show'],
      ['docker', 'context', 'inspect'],
      ['docker', 'info', '--format'],
    ],
  );
  assert.equal(fs.existsSync(data.temporary), false);
});

test('a daemon already using the required backend needs no container listing, filesystem access or restart', () => {
  const commands = runner({ information: [required('28.5.2')] });
  const fileSystem = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected filesystem access');
      },
    },
  );
  assert.equal(
    prepareDockerStore({ env: hosted, run: commands.run, fileSystem, uid: 0 }).serverVersion,
    '28.5.2',
  );
  assert.equal(commands.calls.length, 3);
});

test('an occupied daemon is refused before every filesystem mutation and service operation', () => {
  const commands = runner({ containers: '0123456789abcdef\n' });
  const fileSystem = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected filesystem access');
      },
    },
  );
  assert.throws(
    () => prepareDockerStore({ env: hosted, run: commands.run, fileSystem, uid: 0 }),
    failure,
  );
  assert.equal(commands.calls.length, 4);
  assert.equal(
    commands.calls.some(({ binary }) => binary === 'systemctl'),
    false,
  );
});

test('creates an absent daemon config with only the required feature and a private file mode', (t) => {
  const data = fixture(t);
  prepareDockerStore({ ...data.options, run: runner().run });
  assert.deepEqual(JSON.parse(fs.readFileSync(data.configPath, 'utf8')), {
    features: { 'containerd-snapshotter': true },
  });
  assert.equal(fs.statSync(data.configPath).mode & 0o777, 0o600);
});

test('verify accepts only the observed overlayfs containerd backend on supported Docker 28 and 29', () => {
  for (const version of ['28.0.4', '29.3.1']) {
    assert.equal(
      verifyDockerStore({ env: hosted, run: runner({ information: [required(version)] }).run })
        .serverVersion,
      version,
    );
  }
  for (const info of [
    classic(),
    { ...required(), driver: 'overlay2' },
    { ...required(), driverStatus: [] },
    { ...required(), driverStatus: [['driver-type', 'other']] },
    {
      ...required(),
      driverStatus: [
        ['driver-type', 'io.containerd.snapshotter.v1'],
        ['driver-type', 'io.containerd.snapshotter.v1'],
      ],
    },
    required('27.5.1'),
    required('30.0.0'),
    required('PRIVATE_VERSION_CONTENT'),
    { ...required(), driverStatus: null },
    { ...required(), unexpected: 'PRIVATE_EXTRA' },
    'PRIVATE_MALFORMED_JSON',
    'x'.repeat(65_537),
  ])
    assert.throws(
      () => verifyDockerStore({ env: hosted, run: runner({ information: [info] }).run }),
      failure,
    );
});

test('rejects non-hosted environments and endpoint overrides before inspecting or changing a daemon', () => {
  for (const env of [
    { ...hosted, GITHUB_ACTIONS: 'false' },
    { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...hosted, DOCKER_HOST: 'unix:///var/run/docker.sock' },
    { ...hosted, DOCKER_CONTEXT: 'default' },
    { ...hosted, DOCKER_HOST: ' ' },
    { ...hosted, DOCKER_CONTEXT: ' ' },
  ]) {
    let calls = 0;
    const run = () => {
      calls++;
      throw new Error('PRIVATE_DEPENDENCY_OUTPUT');
    };
    assert.throws(() => prepareDockerStore({ env, run, uid: 0 }), failure);
    assert.throws(() => verifyDockerStore({ env, run }), failure);
    assert.equal(calls, 0);
  }
  for (const options of [
    { context: 'builder' },
    { endpoint: 'unix:///private/docker.sock' },
    { endpoint: 'tcp://127.0.0.1:2375' },
  ]) {
    const commands = runner(options);
    assert.throws(() => prepareDockerStore({ env: hosted, run: commands.run, uid: 0 }), failure);
    assert.equal(
      commands.calls.some(({ args }) => args[0] === 'info' || args[0] === 'container'),
      false,
    );
  }
  const commands = runner();
  assert.throws(() => prepareDockerStore({ env: hosted, run: commands.run, uid: 1001 }), failure);
  assert.equal(commands.calls.length, 0);
});

test('accepts the explicit empty override values forwarded through sudo while still checking the real default endpoint', () => {
  const env = { ...hosted, DOCKER_HOST: '', DOCKER_CONTEXT: '' };
  const commands = runner({ information: [required()], expectedEnv: env });
  assert.equal(
    verifyDockerStore({ env, run: commands.run }).driverType,
    'io.containerd.snapshotter.v1',
  );
  assert.equal(commands.calls.length, 3);
});

for (const [name, mutation] of [
  [
    'symlinked directory',
    (data) => {
      fs.mkdirSync(join(data.root, 'other'));
      fs.symlinkSync(join(data.root, 'other'), data.configDirectory);
    },
  ],
  [
    'symlinked daemon config',
    (data) => {
      existingConfig(data);
      fs.renameSync(data.configPath, join(data.root, 'original'));
      fs.symlinkSync(join(data.root, 'original'), data.configPath);
    },
  ],
  [
    'multilink daemon config',
    (data) => {
      existingConfig(data);
      fs.linkSync(data.configPath, join(data.root, 'other-link'));
    },
  ],
  [
    'nonregular daemon config',
    (data) => {
      fs.mkdirSync(data.configDirectory);
      fs.mkdirSync(data.configPath);
    },
  ],
  ['writable parent', (data) => fs.chmodSync(data.root, 0o777)],
  [
    'writable config directory',
    (data) => {
      existingConfig(data);
      fs.chmodSync(data.configDirectory, 0o777);
    },
  ],
  [
    'writable config file',
    (data) => {
      existingConfig(data);
      fs.chmodSync(data.configPath, 0o666);
    },
  ],
  [
    'special config file mode',
    (data) => {
      existingConfig(data);
      fs.chmodSync(data.configPath, 0o1640);
    },
  ],
  ['oversized daemon config', (data) => existingConfig(data, 'x'.repeat(65_537))],
  ['malformed daemon config', (data) => existingConfig(data, 'PRIVATE_PARSE_FAILURE')],
  ['nonobject daemon config', (data) => existingConfig(data, '[]')],
  ['nonobject features', (data) => existingConfig(data, '{"features":null}')],
  [
    'preexisting temporary entry',
    (data) => {
      existingConfig(data);
      fs.writeFileSync(data.temporary, 'preserve');
    },
  ],
]) {
  test(`refuses ${name} without a restart`, (t) => {
    const data = fixture(t);
    mutation(data);
    const commands = runner();
    assert.throws(() => prepareDockerStore({ ...data.options, run: commands.run }), failure);
    assert.equal(
      commands.calls.some(({ binary }) => binary === 'systemctl'),
      false,
    );
  });
}

test('rejects a foreign-owned config inode before opening it', (t) => {
  const data = fixture(t);
  existingConfig(data);
  const fileSystem = {
    ...fs,
    lstatSync(path) {
      const stat = fs.lstatSync(path);
      return path === data.configPath
        ? Object.create(stat, { uid: { value: process.getuid() + 1 } })
        : stat;
    },
  };
  const commands = runner();
  assert.throws(
    () => prepareDockerStore({ ...data.options, run: commands.run, fileSystem }),
    failure,
  );
  assert.equal(
    commands.calls.some(({ binary }) => binary === 'systemctl'),
    false,
  );
});

test('a partial atomic write leaves the original file intact and never restarts the daemon', (t) => {
  const data = fixture(t);
  const before = existingConfig(data);
  const commands = runner();
  const fileSystem = {
    ...fs,
    writeSync(descriptor, bytes, offset, length) {
      fs.writeSync(descriptor, bytes, offset, Math.min(length, 7));
      throw Object.assign(new Error('PRIVATE_WRITE_ERROR', { cause: 'PRIVATE_WRITE_CAUSE' }), {
        code: 'EACCES',
        phase: 'FORGED_PHASE',
        command: 'FORGED_COMMAND',
        outcome: 'FORGED_OUTCOME',
        exitCode: 99,
      });
    },
  };
  assert.throws(
    () => prepareDockerStore({ ...data.options, run: commands.run, fileSystem }),
    (error) => {
      assert.ok(failure(error));
      assert.equal(error.phase, 'config_install');
      assert.equal(error.command, 'none');
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.exitCode, null);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|FORGED_|EACCES|cause/u);
      return true;
    },
  );
  assert.deepEqual(fs.readFileSync(data.configPath), before);
  assert.equal(fs.statSync(data.configPath).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(data.temporary), false);
  assert.equal(
    commands.calls.some(({ binary }) => binary === 'systemctl'),
    false,
  );
});

test('a concurrent config edit is preserved and prevents atomic replacement or restart', (t) => {
  const data = fixture(t);
  existingConfig(data);
  const fileSystem = {
    ...fs,
    fsyncSync(descriptor) {
      fs.fsyncSync(descriptor);
      if (fs.fstatSync(descriptor).isFile())
        fs.writeFileSync(data.configPath, 'CONCURRENT_PRIVATE_CONFIG');
    },
  };
  const commands = runner();
  assert.throws(
    () => prepareDockerStore({ ...data.options, run: commands.run, fileSystem }),
    failure,
  );
  assert.equal(fs.readFileSync(data.configPath, 'utf8'), 'CONCURRENT_PRIVATE_CONFIG');
  assert.equal(
    commands.calls.some(({ binary }) => binary === 'systemctl'),
    false,
  );
});

test('a restart failure is not accepted and never falls back to another endpoint or backend', (t) => {
  const data = fixture(t);
  const commands = runner({
    onRestart() {
      throw new Error('PRIVATE_SYSTEMCTL_OUTPUT');
    },
  });
  assert.throws(
    () => prepareDockerStore({ ...data.options, run: commands.run }),
    (error) =>
      failure(error) &&
      error.backend === 'other' &&
      error.phase === 'service_restart' &&
      error.command === 'docker_service_restart' &&
      error.outcome === 'dependency_failed',
  );
  assert.equal(commands.calls.length, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(data.configPath, 'utf8')), {
    features: { 'containerd-snapshotter': true },
  });
});

test('a successful restart with the wrong observed backend still fails acceptance', (t) => {
  const data = fixture(t);
  const commands = runner({ information: [classic(), classic()] });
  assert.throws(
    () => prepareDockerStore({ ...data.options, run: commands.run }),
    (error) =>
      failure(error) &&
      error.backend === 'other' &&
      error.phase === 'post_restart_policy' &&
      error.command === 'none' &&
      error.outcome === 'guard_rejected' &&
      error.exitCode === null,
  );
  assert.equal(commands.calls.length, 8);
});

test('a post-restart backend failure retains its actual phase without trusting dependency fields', (t) => {
  const data = fixture(t);
  const commands = runner();
  let informationReads = 0;
  const run = (binary, args, options) => {
    const output = commands.run(binary, args, options);
    if (binary === 'docker' && args[0] === 'info' && ++informationReads === 2) {
      throw Object.assign(new Error('PRIVATE_POST_RESTART_OUTPUT'), {
        phase: 'FORGED_PHASE',
        command: 'FORGED_COMMAND',
        outcome: 'FORGED_OUTCOME',
        exitCode: 99,
      });
    }
    return output;
  };
  assert.throws(
    () => prepareDockerStore({ ...data.options, run }),
    (error) => {
      assert.ok(failure(error));
      assert.equal(error.serverVersion, 'unknown');
      assert.equal(error.backend, 'unverified');
      assert.equal(error.phase, 'post_restart_backend');
      assert.equal(error.command, 'docker_info');
      assert.equal(error.outcome, 'dependency_failed');
      assert.equal(error.exitCode, null);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|FORGED_/u);
      return true;
    },
  );
  assert.equal(commands.calls.length, 8);
  assert.equal(commands.calls.filter(({ binary }) => binary === 'systemctl').length, 1);
});

test('the actual CLI retains a failed Docker child outcome without exposing its private stderr', (t) => {
  const data = fixture(t);
  const bin = join(data.root, 'bin');
  const calls = join(data.root, 'calls.jsonl');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(
    join(bin, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MAXIM_DOCKER_DIAGNOSTIC_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'context' && args[1] === 'show') process.stdout.write('default\\n');
else if (args[0] === 'context' && args[1] === 'inspect') process.stdout.write('unix:///var/run/docker.sock\\n');
else if (args[0] === 'info') {
  process.stderr.write('PRIVATE_DOCKER_STDERR https://private.invalid/token\\n');
  process.exitCode = 17;
} else process.exitCode = 99;
`,
    { mode: 0o700 },
  );
  const cli = new URL('./prepare-docker-store.mjs', import.meta.url).pathname;
  const output = spawnSync(process.execPath, [cli, 'verify'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ...hosted,
      DOCKER_HOST: '',
      DOCKER_CONTEXT: '',
      PATH: `${bin}:${process.env.PATH}`,
      MAXIM_DOCKER_DIAGNOSTIC_CALLS: calls,
    },
  });
  assert.equal(output.status, 1);
  assert.equal(output.stdout, '');
  assert.deepEqual(JSON.parse(output.stderr), {
    error: 'DOCKER_STORE_INVALID',
    message: dockerStoreFailureMessage,
    serverVersion: 'unknown',
    backend: 'unverified',
    phase: 'verify_backend',
    command: 'docker_info',
    outcome: 'nonzero_exit',
    exitCode: 17,
  });
  assert.doesNotMatch(output.stderr, /PRIVATE_|private\.invalid|cause|stack/u);
  const executed = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(executed.length, 3);
  assert.deepEqual(
    executed.map((args) => args.slice(0, 2)),
    [
      ['context', 'show'],
      ['context', 'inspect'],
      ['info', '--format'],
    ],
  );
});

test('CLI errors expose only the typed fixed diagnostic, never raw dependency or caller content', () => {
  const cli = new URL('./prepare-docker-store.mjs', import.meta.url).pathname;
  for (const args of [[], ['unknown'], ['prepare', 'PRIVATE_PATH'], ['verify']]) {
    const output = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    assert.equal(output.status, 1);
    assert.equal(output.stdout, '');
    assert.deepEqual(JSON.parse(output.stderr), {
      error: 'DOCKER_STORE_INVALID',
      message: dockerStoreFailureMessage,
      serverVersion: 'unknown',
      backend: 'unverified',
      phase: args[0] === 'verify' ? 'verify_context' : 'arguments',
      command: 'none',
      outcome: 'guard_rejected',
      exitCode: null,
    });
  }
});
