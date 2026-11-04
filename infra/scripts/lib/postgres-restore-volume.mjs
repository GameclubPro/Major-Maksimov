import * as nativeFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GiB = 1024 ** 3;
const METADATA_RESERVE = GiB;
const MAX_JSON = 65536;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const fail = (message) => {
  throw new Error(message);
};

function integer(value, name, maximum = 2 ** 43) {
  if (!/^[0-9]+$/u.test(String(value))) fail(`Invalid ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail(`Invalid ${name}.`);
  return number;
}

export function restoreVolumeBudgets(options) {
  const bytes = integer(options.bytes, 'loop bytes', 2 ** 41);
  const databaseBytes = integer(options.databaseBytes, 'database size');
  const percent = Math.max(integer(options.percent, 'restore percentage', 1000), 125);
  const floor = integer(options.floor, 'restore reserve');
  const backingFloor = Math.max(floor, 40 * GiB);
  const databaseReserve = Math.ceil((databaseBytes * percent) / 100);
  const virtualNeed = databaseReserve + floor;
  const physicalNeed = databaseReserve + backingFloor + METADATA_RESERVE;
  if (bytes - METADATA_RESERVE < virtualNeed)
    fail('Sparse volume virtual capacity estimate is insufficient.');
  return {
    bytes,
    floor,
    backingFloor,
    virtualNeed,
    physicalNeed,
    metadataReserve: METADATA_RESERVE,
  };
}

export function restoreVolumeOperation(action, options, dependencies = {}) {
  const fs = dependencies.fs ?? nativeFs;
  const uid = dependencies.uid ?? process.getuid();
  const run =
    dependencies.run ??
    ((command, args, timeout = 30000) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: MAX_JSON });
      if (result.error || result.signal) fail(`Missing observation from ${command}.`);
      return result;
    });
  const command = (name, args, absent = false, timeout) => {
    const result = run(name, args, timeout);
    if (result.error || result.signal || ![0, ...(absent ? [1] : [])].includes(result.status))
      fail(`Failed or missing observation from ${name}.`);
    if (Buffer.byteLength(result.stdout ?? '') > MAX_JSON) fail(`Oversized ${name} observation.`);
    return result;
  };
  if (uid !== 0) fail('Disposable loop restore requires root.');
  if (!['maxim', 'eraser'].includes(options.profile) || !UUID.test(options.operationId))
    fail('Invalid volume operation identity.');
  const cleanPath = (value) => {
    if (!/^\/[a-zA-Z0-9_./-]+$/u.test(value) || path.normalize(value) !== value || value === '/')
      fail('Invalid private volume path.');
    return value;
  };
  const root = cleanPath(options.root);
  const backingPath = cleanPath(options.backingPath);
  const profileRoot = path.join(root, options.profile);
  const active = path.join(profileRoot, 'active');
  const journalPath = path.join(active, 'state.json');
  const historyPath = path.join(profileRoot, 'completed.json');
  const image = path.join(active, 'volume.ext4');
  const mount = path.join(active, 'mount');
  const data = path.join(mount, 'data');
  const cidfile = path.join(active, 'container.cid');
  const budgets = restoreVolumeBudgets(options);
  const stat = (target) => fs.lstatSync(target);
  const exists = (target) => {
    try {
      stat(target);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const privateDirectory = (target, create = false) => {
    const components = target.split('/').filter(Boolean);
    let current = '';
    for (const component of components) {
      current += `/${component}`;
      if (!exists(current)) {
        if (!create || current !== target) fail('Private volume parent is missing.');
        fs.mkdirSync(current, { mode: 0o700 });
      }
      const entry = stat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || entry.mode & 0o022)
        fail('Unsafe private volume directory or parent.');
    }
    if ((stat(target).mode & 0o777) !== 0o700) fail('Volume directory must have mode 0700.');
  };
  const regular = (target, maximum = Infinity) => {
    const entry = stat(target);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== 0 ||
      entry.nlink !== 1 ||
      (entry.mode & 0o777) !== 0o600 ||
      entry.size > maximum
    )
      fail('Unsafe owned volume file.');
    return entry;
  };
  const readJson = (target) => {
    regular(target, MAX_JSON);
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  };
  const atomicJson = (target, value) => {
    if (exists(target)) regular(target, MAX_JSON);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
  };
  const closestParent = (target) => {
    let parent = target;
    while (!exists(parent)) parent = path.dirname(parent);
    return parent;
  };
  const sameBacking = () => {
    const parent = closestParent(root);
    let current = parent;
    while (current !== '/') {
      const entry = stat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || entry.mode & 0o022)
        fail('Unsafe volume backing path parent.');
      current = path.dirname(current);
    }
    if (exists(root) && (stat(root).mode & 0o777) !== 0o700)
      fail('Volume directory must have mode 0700.');
    if (stat(parent).dev !== stat(backingPath).dev)
      fail('Loop root and configured backing filesystem differ.');
  };
  const free = (target) => {
    const value = command('df', ['-PB1', '--', target]).stdout.trim().split('\n');
    if (value.length !== 2) fail('Missing filesystem capacity observation.');
    return integer(value[1].trim().split(/\s+/u)[3], 'free space', Number.MAX_SAFE_INTEGER);
  };
  const physicalAdmission = () => {
    sameBacking();
    if (free(backingPath) < budgets.physicalNeed)
      fail('Insufficient physical backing reserve for full restore.');
  };
  const history = () => {
    if (!exists(historyPath)) return [];
    const rows = readJson(historyPath);
    if (
      !Array.isArray(rows) ||
      rows.length > 8 ||
      rows.some(
        (row) =>
          row.schemaVersion !== 1 ||
          row.profile !== options.profile ||
          !UUID.test(row.operationId) ||
          row.phase !== 'cleaned',
      )
    )
      fail('Unknown completed volume journal.');
    return rows;
  };
  let state;
  const save = (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    atomicJson(journalPath, state);
  };
  const imageIdentity = () => {
    const entry = regular(image);
    if (
      entry.size !== budgets.bytes ||
      (state.file && (entry.dev !== state.file.dev || entry.ino !== state.file.ino))
    )
      fail('Volume image identity changed.');
    return { dev: entry.dev, ino: entry.ino };
  };
  const loopRows = () => {
    const parsed = JSON.parse(
      command('losetup', [
        '--json',
        '--list',
        '--associated',
        image,
        '--output',
        'NAME,BACK-FILE,BACK-INO',
      ]).stdout,
    );
    if (!Array.isArray(parsed.loopdevices) || parsed.loopdevices.length > 1)
      fail('Unknown loop association.');
    return parsed.loopdevices;
  };
  const assertLoop = () => {
    imageIdentity();
    const rows = loopRows();
    if (
      rows.length !== 1 ||
      rows[0].name !== state.loop ||
      rows[0]['back-file'] !== image ||
      String(rows[0]['back-ino']) !== String(state.file.ino)
    )
      fail('Loop backing identity changed.');
  };
  const mounted = () => {
    const result = command(
      'findmnt',
      [
        '--json',
        '--submounts',
        '--mountpoint',
        mount,
        '--output',
        'TARGET,SOURCE,FSTYPE,OPTIONS,UUID',
      ],
      true,
    );
    if (result.status === 1) return null;
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.filesystems) || parsed.filesystems.length !== 1)
      fail('Unknown mount observation.');
    return parsed.filesystems[0];
  };
  const assertMount = () => {
    assertLoop();
    const row = mounted();
    if (
      !row ||
      row.target !== mount ||
      row.source !== state.loop ||
      row.fstype !== 'ext4' ||
      row.uuid !== state.filesystemUuid ||
      (row.children?.length ?? 0) !== 0 ||
      !['nosuid', 'nodev', 'noexec'].every((option) => row.options.split(',').includes(option))
    )
      fail('Mounted restore filesystem identity changed.');
    const uses = command('findmnt', [
      '--raw',
      '--noheadings',
      '--source',
      state.loop,
      '--output',
      'TARGET',
    ])
      .stdout.trim()
      .split('\n');
    if (uses.length !== 1 || uses[0] !== mount) fail('Loop filesystem has another mount.');
  };
  const containerIdentity = (id) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) fail('Missing exact restore container identity.');
    const rows = JSON.parse(command('docker', ['inspect', '--type', 'container', id]).stdout);
    if (!Array.isArray(rows) || rows.length !== 1) fail('Missing restore container observation.');
    const row = rows[0];
    if (
      row.Id !== id ||
      row.Name !== `/${state.containerName}` ||
      row.Config?.Labels?.['maxim.restore.operation'] !== options.operationId ||
      row.HostConfig?.NetworkMode !== 'none' ||
      row.Mounts?.filter((item) => item.Type === 'bind').length !== 1 ||
      !row.Mounts?.some(
        (item) =>
          item.Type === 'bind' &&
          item.Source === data &&
          item.Destination === '/var/lib/postgresql/data',
      )
    )
      fail('Restore container ownership changed.');
    return row;
  };
  const assertData = () => {
    const entry = stat(data);
    if (
      !state.data ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.dev !== state.data.dev ||
      entry.ino !== state.data.ino
    )
      fail('Restore data directory identity changed.');
  };
  const load = () => {
    privateDirectory(root);
    privateDirectory(profileRoot);
    privateDirectory(active);
    state = readJson(journalPath);
    if (
      state.schemaVersion !== 1 ||
      state.profile !== options.profile ||
      state.operationId !== options.operationId ||
      state.image !== image ||
      state.mount !== mount ||
      state.dataPath !== data ||
      state.bytes !== budgets.bytes ||
      typeof state.containerExpected !== 'boolean' ||
      typeof state.phase !== 'string' ||
      (state.containerExpected &&
        state.containerName !== `${options.profile}-restore-volume-${options.operationId}`)
    )
      fail('Another or unknown volume operation owns this directory.');
  };
  if (action === 'preflight') {
    // FLAG: A preflight creates no filesystem, file, loop, mount or container.
    physicalAdmission();
    if (exists(active)) fail('A previous restore volume needs review.');
    return { ...budgets, virtualCapacity: 'estimate_only', mount };
  }
  if (action === 'prepare') {
    physicalAdmission();
    privateDirectory(root, true);
    privateDirectory(profileRoot, true);
    history();
    if (exists(active)) fail('A previous restore volume needs review.');
    fs.mkdirSync(active, { mode: 0o700 });
    state = {
      schemaVersion: 1,
      profile: options.profile,
      operationId: options.operationId,
      phase: 'creating_file',
      bytes: budgets.bytes,
      image,
      mount,
      dataPath: data,
      startedAt: new Date().toISOString(),
      containerExpected: false,
    };
    save({});
    try {
      const descriptor = fs.openSync(
        image,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.ftruncateSync(descriptor, budgets.bytes);
      } finally {
        fs.closeSync(descriptor);
      }
      save({ file: imageIdentity(), phase: 'formatting' });
      // FLAG: Format only the freshly and exclusively created regular file, never a device.
      command(
        'mkfs.ext4',
        [
          '-F',
          '-T',
          'largefile4',
          '-m',
          '0',
          '-J',
          'size=128',
          '-E',
          'lazy_itable_init=0,lazy_journal_init=0',
          image,
        ],
        false,
        120000,
      );
      imageIdentity();
      if (stat(image).blocks * 512 > METADATA_RESERVE)
        fail('Formatted metadata exceeded its physical reserve.');
      const filesystemUuid = command('blkid', [
        '-p',
        '-s',
        'UUID',
        '-o',
        'value',
        '--',
        image,
      ]).stdout.trim();
      if (!UUID.test(filesystemUuid)) fail('Missing formatted filesystem UUID.');
      if (loopRows().length !== 0) fail('New image already has a loop association.');
      save({ filesystemUuid, phase: 'attaching_loop', loopExpected: true });
      const loop = command('losetup', [
        '--find',
        '--show',
        '--nooverlap',
        '--',
        image,
      ]).stdout.trim();
      if (!/^\/dev\/loop[0-9]{1,5}$/u.test(loop)) fail('Missing newly attached loop identity.');
      save({ loop, phase: 'loop_attached' });
      assertLoop();
      fs.mkdirSync(mount, { mode: 0o700 });
      save({ phase: 'mounting', mountExpected: true });
      command('mount', ['-t', 'ext4', '-o', 'nosuid,nodev,noexec', '--', loop, mount]);
      assertMount();
      save({ phase: 'mounted', mountConfirmed: true });
      physicalAdmission();
      if (free(mount) < budgets.virtualNeed) fail('Actual mounted capacity is insufficient.');
      fs.mkdirSync(data, { mode: 0o700 });
      const entry = stat(data);
      save({ phase: 'prepared', data: { dev: entry.dev, ino: entry.ino } });
      return { ...budgets, data, mount, cidfile };
    } catch (error) {
      save({ phase: 'needs_review', failure: error.message });
      throw error;
    }
  }
  if (action === 'cleanup' && !exists(active)) {
    privateDirectory(root);
    privateDirectory(profileRoot);
    if (history().some((row) => row.operationId === options.operationId)) return { cleaned: true };
    fail('Missing active or completed volume journal.');
  }
  load();
  if (action === 'container-starting') {
    assertMount();
    assertData();
    if (state.phase !== 'prepared') fail('Restore container is not admitted.');
    const containerName = `${options.profile}-restore-volume-${options.operationId}`;
    save({ phase: 'container_starting', containerExpected: true, containerName });
    return { containerName, cidfile, data };
  }
  if (action === 'sample') {
    if (
      !['container_starting', 'restoring'].includes(state.phase) ||
      !['0', '1'].includes(options.ready)
    )
      fail('Invalid restore watchdog sample.');
    assertMount();
    assertData();
    regular(cidfile, 65);
    const id = fs.readFileSync(cidfile, 'utf8').trim();
    containerIdentity(id);
    const observedAt = new Date().toISOString();
    save({
      phase: 'restoring',
      containerId: id,
      heartbeatAt: observedAt,
      watchdog: {
        observedAt,
        ready: options.ready === '1',
        virtualFree: integer(
          options.virtualFree,
          'observed virtual free space',
          Number.MAX_SAFE_INTEGER,
        ),
        backingFree: integer(
          options.backingFree,
          'observed backing free space',
          Number.MAX_SAFE_INTEGER,
        ),
      },
      ...(options.ready === '1' ? { lastHealthySampleAt: observedAt } : {}),
    });
    return { sampled: true };
  }
  if (action !== 'cleanup') fail('Unknown volume operation action.');
  try {
    // FLAG: Missing write-ahead mutation results are uncertain; never adopt them during cleanup.
    if (
      state.phase === 'needs_review' ||
      !state.file ||
      (state.loopExpected && !state.loop) ||
      (state.mountExpected && (!state.filesystemUuid || !state.mountConfirmed))
    )
      fail('Incomplete loop or mount identity requires review.');
    imageIdentity();
    if (state.loop) assertLoop();
    else if (loopRows().length !== 0) fail('Unexpected loop association.');
    if (state.mountExpected) assertMount();
    if (state.data) assertData();
    if (state.containerExpected) {
      regular(cidfile, 65);
      const id = fs.readFileSync(cidfile, 'utf8').trim();
      let container = containerIdentity(id);
      save({ containerId: id, phase: 'stopping_container' });
      if (container.State?.Running === true) command('docker', ['stop', '--time', '10', id]);
      container = containerIdentity(id);
      if (
        !['exited', 'created', 'dead'].includes(container.State?.Status) ||
        container.State?.Running !== false ||
        container.State?.Pid !== 0 ||
        container.State?.Restarting !== false
      )
        fail('Restore container terminal state is unproved.');
      // FLAG: All file, loop, mount and container identities precede every destructive cleanup step.
      imageIdentity();
      assertMount();
      assertData();
      command('docker', ['rm', id]);
      save({ containerRemoved: true, phase: 'container_removed' });
    }
    if (state.data) {
      imageIdentity();
      assertMount();
      assertData();
      fs.rmSync(data, { recursive: true });
      save({ dataRemoved: true, phase: 'data_removed' });
    }
    if (state.mountExpected) {
      imageIdentity();
      assertMount();
      command('umount', ['--', mount]);
      if (mounted() !== null) fail('Restore mount remains attached.');
      save({ mountRemoved: true, phase: 'mount_removed' });
    }
    if (state.loop) {
      imageIdentity();
      assertLoop();
      command('losetup', ['--detach', state.loop]);
      if (loopRows().length !== 0) fail('Restore loop remains attached.');
      save({ loopRemoved: true, phase: 'loop_removed' });
    }
    imageIdentity();
    fs.unlinkSync(image);
    if (exists(mount)) fs.rmdirSync(mount);
    if (exists(cidfile)) {
      regular(cidfile, 65);
      fs.unlinkSync(cidfile);
    }
    save({ phase: 'cleaned', cleanedAt: new Date().toISOString() });
    atomicJson(historyPath, [...history(), state].slice(-8));
    fs.unlinkSync(journalPath);
    fs.rmdirSync(active);
    return { cleaned: true };
  } catch (error) {
    save({ phase: 'needs_review', failure: error.message });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [
      action,
      profile,
      root,
      operationId,
      bytes,
      databaseBytes,
      percent,
      floor,
      backingPath,
      ready,
      virtualFree,
      backingFree,
    ] = process.argv.slice(2);
    console.log(
      JSON.stringify(
        restoreVolumeOperation(action, {
          profile,
          root,
          operationId,
          bytes,
          databaseBytes,
          percent,
          floor,
          backingPath,
          ready,
          virtualFree,
          backingFree,
        }),
      ),
    );
  } catch (error) {
    console.error(`Disposable restore volume: ${error.message}`);
    process.exitCode = 1;
  }
}
