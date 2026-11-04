import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreVolumeBudgets, restoreVolumeOperation } from './lib/postgres-restore-volume.mjs';

const GiB = 1024 ** 3;
const filesystemUuid = '11111111-2222-4333-8444-555555555555';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'maxim-loop-fixture-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    profile: 'maxim',
    root: path.join(directory, 'private'),
    backingPath: directory,
    operationId: randomUUID(),
    bytes: 8 * GiB,
    databaseBytes: 1024 * 1024,
    percent: 125,
    floor: 2 * GiB,
  };
  const active = path.join(options.root, options.profile, 'active');
  const image = path.join(active, 'volume.ext4');
  const mount = path.join(active, 'mount');
  const data = path.join(mount, 'data');
  const stateFile = path.join(active, 'state.json');
  const calls = [];
  const control = {
    loop: false,
    mounted: false,
    mismatch: false,
    busy: false,
    free: 100 * GiB,
    mountFree: 7 * GiB,
    container: null,
    gap: null,
    childMount: false,
  };
  const fakeFs = {
    ...fs,
    lstatSync(target) {
      const value = fs.lstatSync(target);
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
        uid: 0,
        dev: value.dev + (control.backingMismatch && target === options.backingPath ? 1 : 0),
        mode: target === '/tmp' ? (value.mode & ~0o777) | 0o755 : value.mode,
      });
    },
  };
  const run = (name, args) => {
    calls.push([name, ...args]);
    const result = (stdout = '', status = 0) => ({ stdout, status });
    if (name === 'df')
      return result(
        `Filesystem 1-blocks Used Available Use% Mounted on\nfixture 999999999999 0 ${args.at(-1) === mount ? control.mountFree : control.free} 1% /\n`,
      );
    if (name === 'mkfs.ext4') {
      assert.equal(args.at(-1), image);
      assert.equal(fs.lstatSync(image).isFile(), true);
      assert.equal(fs.lstatSync(image).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(image).size, options.bytes);
      return result();
    }
    if (name === 'blkid') return result(filesystemUuid);
    if (name === 'losetup') {
      if (args.includes('--associated'))
        return result(
          JSON.stringify({
            loopdevices: control.loop
              ? [
                  {
                    name: '/dev/loop77',
                    'back-file': image,
                    'back-ino': fs.lstatSync(image).ino + (control.mismatch ? 1 : 0),
                  },
                ]
              : [],
          }),
        );
      if (args.includes('--find')) {
        control.loop = true;
        return result('/dev/loop77\n', control.gap === 'loop' ? 1 : 0);
      }
      if (args.includes('--detach')) {
        control.loop = false;
        return result();
      }
    }
    if (name === 'mount') {
      control.mounted = true;
      return result('', control.gap === 'mount' ? 1 : 0);
    }
    if (name === 'findmnt') {
      if (!control.mounted) return result('', 1);
      if (args.includes('--raw')) return result(`${mount}\n`);
      return result(
        JSON.stringify({
          filesystems: [
            {
              target: mount,
              source: '/dev/loop77',
              fstype: 'ext4',
              uuid: filesystemUuid,
              options: 'rw,nosuid,nodev,noexec',
              ...(control.childMount ? { children: [{ target: `${data}/foreign` }] } : {}),
            },
          ],
        }),
      );
    }
    if (name === 'umount') {
      if (control.busy) return result('', 32);
      control.mounted = false;
      return result();
    }
    if (name === 'docker') {
      if (args[0] === 'inspect')
        return control.container ? result(JSON.stringify([control.container])) : result('', 1);
      if (args[0] === 'stop') {
        control.container.State = { Status: 'exited', Running: false, Restarting: false, Pid: 0 };
        return result();
      }
      if (args[0] === 'rm') {
        control.container = null;
        return result();
      }
    }
    throw new Error(`Unexpected command ${name} ${args.join(' ')}`);
  };
  const invoke = (action, override = {}) =>
    restoreVolumeOperation(action, { ...options, ...override }, { fs: fakeFs, run, uid: 0 });
  const startContainer = () => {
    const admission = invoke('container-starting');
    const id = 'a'.repeat(64);
    fs.writeFileSync(admission.cidfile, id, { mode: 0o600 });
    control.container = {
      Id: id,
      Name: `/${admission.containerName}`,
      Config: { Labels: { 'maxim.restore.operation': options.operationId } },
      HostConfig: { NetworkMode: 'none' },
      Mounts: [{ Type: 'bind', Source: data, Destination: '/var/lib/postgresql/data' }],
      State: { Status: 'running', Running: true, Restarting: false, Pid: 1234 },
    };
  };
  return {
    options,
    directory,
    active,
    image,
    mount,
    data,
    stateFile,
    calls,
    control,
    invoke,
    startContainer,
    journal: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
  };
}

test('sparse admission keeps the full authoritative database reserve and both independent floors', () => {
  const budget = restoreVolumeBudgets({
    bytes: 700000000000,
    databaseBytes: 485411577856,
    percent: 100,
    floor: 16 * GiB,
  });
  assert.equal(budget.virtualNeed, 623944341504);
  assert.equal(budget.physicalNeed, 650787887104);
  assert.equal(budget.backingFloor, 40 * GiB);
  assert.ok(budget.physicalNeed < 700000000000 + 40 * GiB);
  assert.equal(
    restoreVolumeBudgets({
      bytes: 700000000000,
      databaseBytes: 485411577856,
      percent: 130,
      floor: 48 * GiB,
    }).backingFloor,
    48 * GiB,
  );
});

test('preflight creates no directories, image, format, loop, mount or container', (t) => {
  const f = fixture(t);
  const result = f.invoke('preflight');
  assert.equal(result.virtualCapacity, 'estimate_only');
  assert.equal(fs.existsSync(f.options.root), false);
  assert.deepEqual(
    f.calls.map(([command]) => command),
    ['df'],
  );
});

test('format is exclusive, loop and mount are exact, terminal container precedes data cleanup', (t) => {
  const f = fixture(t);
  f.invoke('prepare');
  assert.equal(fs.statSync(f.active).mode & 0o777, 0o700);
  assert.equal(f.journal().phase, 'prepared');
  assert.ok(fs.statSync(f.image).blocks * 512 < GiB);
  f.startContainer();
  fs.writeFileSync(path.join(f.data, 'synthetic'), 'only owned data');
  assert.deepEqual(f.invoke('cleanup'), { cleaned: true });
  assert.equal(fs.existsSync(f.image), false);
  assert.equal(fs.existsSync(f.active), false);
  const names = f.calls.map(([name, ...args]) => `${name} ${args.join(' ')}`);
  assert.ok(
    names.findIndex((value) => value.startsWith('docker rm ')) <
      names.findIndex((value) => value.startsWith('umount ')),
  );
  assert.ok(
    names.findIndex((value) => value.startsWith('umount ')) <
      names.findIndex((value) => value.startsWith('losetup --detach ')),
  );
  assert.equal(
    f.calls.some(
      ([name, ...args]) =>
        (name === 'umount' &&
          args.some((argument) => ['-f', '-l', '--force', '--lazy'].includes(argument))) ||
        (name === 'losetup' && args.includes('--detach-all')) ||
        (name === 'docker' && args[0] === 'rm' && args.includes('-f')),
    ),
    false,
  );
  assert.deepEqual(f.invoke('cleanup'), { cleaned: true });
});

for (const scenario of [
  'collision',
  'symlink',
  'backing-floor',
  'virtual-capacity',
  'missing-database',
]) {
  test(`admission fails before allocation for ${scenario}`, (t) => {
    const f = fixture(t);
    const override = {};
    if (scenario === 'collision') {
      f.invoke('prepare');
      f.calls.length = 0;
    }
    if (scenario === 'symlink') fs.symlinkSync(f.directory, f.options.root);
    if (scenario === 'backing-floor') f.control.free = 40 * GiB;
    if (scenario === 'virtual-capacity') override.bytes = GiB;
    if (scenario === 'missing-database') override.databaseBytes = '';
    assert.throws(() => f.invoke('prepare', override));
    assert.equal(
      f.calls.some(([name]) => name === 'mkfs.ext4'),
      false,
    );
  });
}

for (const scenario of [
  'loop-gap',
  'mount-gap',
  'device-mismatch',
  'child-mount',
  'busy',
  'unknown-container',
]) {
  test(`uncertain ${scenario} retains owned resources, review journal and blocks a second operation`, (t) => {
    const f = fixture(t);
    if (scenario === 'loop-gap' || scenario === 'mount-gap') {
      f.control.gap = scenario === 'loop-gap' ? 'loop' : 'mount';
      assert.throws(() => f.invoke('prepare'));
    } else {
      f.invoke('prepare');
      if (scenario === 'device-mismatch') f.control.mismatch = true;
      if (scenario === 'child-mount') f.control.childMount = true;
      if (scenario === 'busy') f.control.busy = true;
      if (scenario === 'unknown-container') f.invoke('container-starting');
    }
    const before = f.calls.length;
    assert.throws(() => f.invoke('cleanup'));
    assert.equal(f.journal().phase, 'needs_review');
    assert.equal(fs.existsSync(f.image), true);
    assert.equal(f.control.loop, true);
    assert.equal(
      f.calls.slice(before).some(([name, flag]) => name === 'losetup' && flag === '--detach'),
      false,
    );
    assert.throws(() => f.invoke('prepare', { operationId: randomUUID() }), /needs review/);
    if (scenario !== 'busy') assert.equal(fs.existsSync(f.data), !scenario.endsWith('gap'));
  });
}

test('cleanup refuses another container label before removing any data or mount', (t) => {
  const f = fixture(t);
  f.invoke('prepare');
  f.startContainer();
  f.control.container.Config.Labels['maxim.restore.operation'] = randomUUID();
  assert.throws(() => f.invoke('cleanup'), /ownership changed/);
  assert.equal(fs.existsSync(f.data), true);
  assert.equal(f.control.mounted, true);
  assert.equal(
    f.calls.some(([command, action]) => command === 'docker' && ['stop', 'rm'].includes(action)),
    false,
  );
});

test('a loop root on another filesystem cannot count the configured backing free space', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.options.root, { mode: 0o700 });
  f.control.backingMismatch = true;
  assert.throws(() => f.invoke('prepare'), /filesystems differ|filesystem differ/);
  assert.equal(fs.existsSync(f.active), false);
  assert.equal(f.calls.length, 0);
});

test('watchdog heartbeat and last healthy sample remain separate and bind the exact container', (t) => {
  const f = fixture(t);
  f.invoke('prepare');
  f.startContainer();
  f.invoke('sample', { ready: '1', virtualFree: String(6 * GiB), backingFree: String(80 * GiB) });
  const healthyAt = f.journal().lastHealthySampleAt;
  f.invoke('sample', { ready: '0', virtualFree: String(6 * GiB), backingFree: String(80 * GiB) });
  assert.equal(f.journal().lastHealthySampleAt, healthyAt);
  assert.equal(f.journal().watchdog.ready, false);
  assert.equal(f.journal().containerId, 'a'.repeat(64));
  assert.ok(f.journal().heartbeatAt);
  f.invoke('cleanup');
});

test(
  'actual small ext4 loop creation, mount flags and exact cleanup',
  {
    skip:
      process.env.MAXIM_RESTORE_VOLUME_NATIVE !== '1'
        ? 'Requires explicit root-owned disposable ext4 loop acceptance.'
        : false,
  },
  () => {
    assert.equal(process.getuid(), 0, 'Native loop acceptance requires root.');
    const directory = `/var/lib/maxim-restore-volume-test-${randomUUID()}`;
    fs.mkdirSync(directory, { mode: 0o700 });
    const options = {
      profile: 'maxim',
      root: path.join(directory, 'volumes'),
      backingPath: directory,
      operationId: randomUUID(),
      bytes: 8 * GiB,
      databaseBytes: 1024 * 1024,
      percent: 125,
      floor: 2 * GiB,
    };
    const result = restoreVolumeOperation('prepare', options);
    assert.ok(
      fs.statSync(path.join(options.root, 'maxim', 'active', 'volume.ext4')).blocks * 512 < GiB,
    );
    fs.writeFileSync(path.join(result.data, 'synthetic'), 'root-owned disposable loop acceptance');
    assert.deepEqual(restoreVolumeOperation('cleanup', options), { cleaned: true });
    assert.equal(fs.existsSync(path.join(options.root, 'maxim', 'active')), false);
    assert.deepEqual(restoreVolumeOperation('cleanup', options), { cleaned: true });
    fs.unlinkSync(path.join(options.root, 'maxim', 'completed.json'));
    fs.rmdirSync(path.join(options.root, 'maxim'));
    fs.rmdirSync(options.root);
    fs.rmdirSync(directory);
  },
);
