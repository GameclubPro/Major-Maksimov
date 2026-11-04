import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  attestationAuthFailureMessage,
  cleanupRegistryAttestationAuth,
  prepareRegistryAttestationAuth,
} from './registry-attestation-auth.mjs';

const syntheticAuth = Buffer.from('fixture-user:synthetic-opaque-credential').toString('base64');
const sourceBytes = Buffer.from(
  JSON.stringify({
    auths: {
      'ghcr.io': { auth: syntheticAuth, ignored: 'DO_NOT_COPY' },
      'private.invalid': { auth: 'DO_NOT_COPY' },
    },
    credsStore: 'DO_NOT_EXECUTE',
    credHelpers: { 'ghcr.io': 'DO_NOT_EXECUTE' },
  }),
);
const expectedConfig = { auths: { 'ghcr.io': { auth: syntheticAuth } } };
const failure = (error) => error.message === attestationAuthFailureMessage && !error.cause;

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-attestation-auth-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDirectory = join(root, 'home');
  const source = join(root, 'publication');
  fs.mkdirSync(homeDirectory, { mode: 0o700 });
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(join(source, 'config.json'), sourceBytes, { mode: 0o600 });
  const directory = join(homeDirectory, '.docker');
  return {
    root,
    source,
    directory,
    target: join(directory, 'config.json'),
    state: join(source, '.maxim-attestation-auth'),
    temporary: join(directory, '.maxim-attestation-config.tmp'),
    options: {
      env: {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        DOCKER_CONFIG: source,
        HOME: join(root, 'ignored-home'),
      },
      homeDirectory,
    },
  };
}

function priorConfig(
  data,
  {
    bytes = Buffer.from(' { "existing": "exact bytes" }\n\n'),
    mode = 0o640,
    directoryMode = 0o750,
  } = {},
) {
  fs.mkdirSync(data.directory, { mode: directoryMode });
  fs.chmodSync(data.directory, directoryMode);
  fs.writeFileSync(data.target, bytes, { mode });
  fs.chmodSync(data.target, mode);
  return bytes;
}

// FLAG: This reproduces the pinned upstream client's path selection: its read
// ignores DOCKER_CONFIG even when the publication job has already logged in.
function pinnedActionRead(homeDirectory) {
  return JSON.parse(fs.readFileSync(join(homeDirectory, '.docker', 'config.json'), 'utf8'));
}

test('bridges the upstream homedir path mismatch with only inline GHCR auth and removes it on cleanup', (t) => {
  const data = fixture(t);
  assert.throws(() => pinnedActionRead(data.options.homeDirectory), { code: 'ENOENT' });
  assert.equal(prepareRegistryAttestationAuth(data.options).status, 'prepared');
  assert.deepEqual(pinnedActionRead(data.options.homeDirectory), expectedConfig);
  assert.equal(fs.statSync(data.target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(data.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(data.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(data.state, 'state.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(join(data.source, 'config.json')), sourceBytes);
  assert.throws(() => prepareRegistryAttestationAuth(data.options), failure);
  assert.equal(cleanupRegistryAttestationAuth(data.options).status, 'clean');
  assert.equal(fs.existsSync(data.target), false);
  assert.equal(fs.existsSync(data.state), false);
  assert.equal(fs.statSync(data.directory).isDirectory(), true);
  assert.equal(cleanupRegistryAttestationAuth(data.options).status, 'clean');
});

test('restores the prior standard config byte-for-byte and with its exact mode, preserving the directory', (t) => {
  const data = fixture(t);
  const original = priorConfig(data);
  fs.writeFileSync(join(data.directory, 'unrelated'), 'preserve me');
  const inode = fs.statSync(data.directory).ino;
  prepareRegistryAttestationAuth(data.options);
  assert.deepEqual(pinnedActionRead(data.options.homeDirectory), expectedConfig);
  assert.deepEqual(fs.readFileSync(join(data.state, 'original.json')), original);
  assert.equal(fs.statSync(join(data.state, 'original.json')).mode & 0o777, 0o600);
  cleanupRegistryAttestationAuth(data.options);
  assert.deepEqual(fs.readFileSync(data.target), original);
  assert.equal(fs.statSync(data.target).mode & 0o777, 0o640);
  assert.equal(fs.statSync(data.directory).mode & 0o777, 0o750);
  assert.equal(fs.statSync(data.directory).ino, inode);
  assert.equal(fs.readFileSync(join(data.directory, 'unrelated'), 'utf8'), 'preserve me');
  cleanupRegistryAttestationAuth(data.options);
  assert.deepEqual(fs.readFileSync(data.target), original);
});

test('preserves an existing config directory without a config file, including cleanup before prepare', (t) => {
  const data = fixture(t);
  fs.mkdirSync(data.directory, { mode: 0o755 });
  fs.chmodSync(data.directory, 0o755);
  assert.equal(cleanupRegistryAttestationAuth(data.options).status, 'clean');
  prepareRegistryAttestationAuth(data.options);
  cleanupRegistryAttestationAuth(data.options);
  assert.equal(fs.existsSync(data.target), false);
  assert.equal(fs.statSync(data.directory).mode & 0o777, 0o755);
  fs.rmSync(data.source, { recursive: true });
  assert.equal(cleanupRegistryAttestationAuth(data.options).status, 'clean');
});

for (const [name, mutation] of [
  [
    'missing inline auth',
    (data) => fs.writeFileSync(join(data.source, 'config.json'), '{"credsStore":"helper"}'),
  ],
  [
    'malformed JSON',
    (data) => fs.writeFileSync(join(data.source, 'config.json'), 'PRIVATE_PARSE_DIAGNOSTIC'),
  ],
  [
    'oversized config',
    (data) => fs.writeFileSync(join(data.source, 'config.json'), Buffer.alloc(65_537, 'x')),
  ],
  [
    'malformed auth',
    (data) =>
      fs.writeFileSync(
        join(data.source, 'config.json'),
        '{"auths":{"ghcr.io":{"auth":"bm9jb2xvbg=="}}}',
      ),
  ],
  ['shared source config', (data) => fs.chmodSync(join(data.source, 'config.json'), 0o644)],
  ['shared writable source directory', (data) => fs.chmodSync(data.source, 0o777)],
  ['shared writable ancestor', (data) => fs.chmodSync(data.root, 0o777)],
  [
    'unsafe target directory',
    (data) => {
      priorConfig(data);
      fs.chmodSync(data.directory, 0o777);
    },
  ],
  [
    'unsafe target config',
    (data) => {
      priorConfig(data);
      fs.chmodSync(data.target, 0o666);
    },
  ],
  [
    'special target config mode',
    (data) => {
      priorConfig(data);
      fs.chmodSync(data.target, 0o1640);
    },
  ],
  [
    'source symlink',
    (data) => {
      fs.renameSync(join(data.source, 'config.json'), join(data.source, 'real.json'));
      fs.symlinkSync(join(data.source, 'real.json'), join(data.source, 'config.json'));
    },
  ],
  [
    'source hardlink',
    (data) => fs.linkSync(join(data.source, 'config.json'), join(data.source, 'other-link')),
  ],
  [
    'source nonregular entry',
    (data) => {
      fs.unlinkSync(join(data.source, 'config.json'));
      fs.mkdirSync(join(data.source, 'config.json'));
    },
  ],
  [
    'home directory symlink',
    (data) => {
      fs.renameSync(data.options.homeDirectory, join(data.root, 'real-home'));
      fs.symlinkSync(join(data.root, 'real-home'), data.options.homeDirectory);
    },
  ],
  [
    'target directory symlink',
    (data) => {
      fs.mkdirSync(join(data.root, 'other-docker'));
      fs.symlinkSync(join(data.root, 'other-docker'), data.directory);
    },
  ],
  [
    'target config symlink',
    (data) => {
      priorConfig(data);
      fs.renameSync(data.target, join(data.directory, 'real.json'));
      fs.symlinkSync(join(data.directory, 'real.json'), data.target);
    },
  ],
  [
    'target config hardlink',
    (data) => {
      priorConfig(data);
      fs.linkSync(data.target, join(data.directory, 'other-link'));
    },
  ],
  [
    'target config nonregular entry',
    (data) => {
      fs.mkdirSync(data.directory);
      fs.mkdirSync(data.target);
    },
  ],
  [
    'preexisting installation temporary',
    (data) => {
      fs.mkdirSync(data.directory);
      fs.writeFileSync(data.temporary, 'unowned');
    },
  ],
]) {
  test(`rejects ${name} with a generic error before installing credentials`, (t) => {
    const data = fixture(t);
    mutation(data);
    assert.throws(() => prepareRegistryAttestationAuth(data.options), failure);
    assert.equal(fs.existsSync(data.state), false);
  });
}

test('rejects a foreign-owned source config', { skip: process.getuid() !== 0 }, (t) => {
  const data = fixture(t);
  fs.chownSync(join(data.source, 'config.json'), 12345, 12345);
  assert.throws(() => prepareRegistryAttestationAuth(data.options), failure);
  assert.equal(fs.existsSync(data.state), false);
});

for (const failedName of ['original.json', 'journal.tmp', '.maxim-attestation-config.tmp']) {
  test(`cleanup restores the original after a partial preparation write to ${failedName}`, (t) => {
    const data = fixture(t);
    const original = priorConfig(data);
    const descriptors = new Map();
    const fileSystem = {
      ...fs,
      openSync(path, ...args) {
        const descriptor = fs.openSync(path, ...args);
        descriptors.set(descriptor, path);
        return descriptor;
      },
      writeSync(descriptor, bytes, offset, length) {
        if (basename(descriptors.get(descriptor)) === failedName) {
          fs.writeSync(descriptor, bytes, offset, Math.min(length, 7));
          throw new Error('PRIVATE_INJECTED_WRITE_FAILURE');
        }
        return fs.writeSync(descriptor, bytes, offset, length);
      },
    };
    assert.throws(() => prepareRegistryAttestationAuth({ ...data.options, fileSystem }), failure);
    cleanupRegistryAttestationAuth(data.options);
    assert.deepEqual(fs.readFileSync(data.target), original);
    assert.equal(fs.statSync(data.target).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(data.temporary), false);
    assert.equal(fs.existsSync(data.state), false);
  });
}

for (const when of ['before', 'after']) {
  test(`cleanup recognizes a preparation failure ${when} the home config rename`, (t) => {
    const data = fixture(t);
    const original = priorConfig(data);
    const fileSystem = {
      ...fs,
      renameSync(from, to) {
        if (to === data.target) {
          if (when === 'after') fs.renameSync(from, to);
          throw new Error('PRIVATE_INJECTED_RENAME_FAILURE');
        }
        fs.renameSync(from, to);
      },
    };
    assert.throws(() => prepareRegistryAttestationAuth({ ...data.options, fileSystem }), failure);
    cleanupRegistryAttestationAuth(data.options);
    assert.deepEqual(fs.readFileSync(data.target), original);
    assert.equal(fs.statSync(data.target).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(data.state), false);
  });
}

test('cleanup recovers a failed prepare after creating the previously absent config directory', (t) => {
  const data = fixture(t);
  const fileSystem = {
    ...fs,
    mkdirSync(path, options) {
      const result = fs.mkdirSync(path, options);
      if (path === data.directory) throw new Error('PRIVATE_INJECTED_MKDIR_FAILURE');
      return result;
    },
  };
  assert.throws(() => prepareRegistryAttestationAuth({ ...data.options, fileSystem }), failure);
  cleanupRegistryAttestationAuth(data.options);
  assert.equal(fs.existsSync(data.target), false);
  assert.equal(fs.existsSync(data.state), false);
});

test('failed restoration retains the private journal and a later cleanup restores the original', (t) => {
  const data = fixture(t);
  const original = priorConfig(data);
  prepareRegistryAttestationAuth(data.options);
  const fileSystem = {
    ...fs,
    renameSync() {
      throw new Error('PRIVATE_RESTORE_FAILURE');
    },
  };
  assert.throws(() => cleanupRegistryAttestationAuth({ ...data.options, fileSystem }), failure);
  assert.equal(fs.existsSync(join(data.state, 'state.json')), true);
  assert.deepEqual(fs.readFileSync(join(data.state, 'original.json')), original);
  assert.deepEqual(pinnedActionRead(data.options.homeDirectory), expectedConfig);
  cleanupRegistryAttestationAuth(data.options);
  assert.deepEqual(fs.readFileSync(data.target), original);
  assert.equal(fs.existsSync(data.state), false);
});

test('cleanup recognizes an already-restored config after interruption before journal removal', (t) => {
  const data = fixture(t);
  const original = priorConfig(data);
  prepareRegistryAttestationAuth(data.options);
  const fileSystem = {
    ...fs,
    unlinkSync(path) {
      if (path === join(data.state, 'state.json')) throw new Error('PRIVATE_CLEANUP_INTERRUPTED');
      fs.unlinkSync(path);
    },
  };
  assert.throws(() => cleanupRegistryAttestationAuth({ ...data.options, fileSystem }), failure);
  assert.deepEqual(fs.readFileSync(data.target), original);
  cleanupRegistryAttestationAuth(data.options);
  assert.deepEqual(fs.readFileSync(data.target), original);
  assert.equal(fs.existsSync(data.state), false);
});

test('cleanup refuses unrecognized replacement and unsafe journal entries without exposing or discarding the backup', (t) => {
  const data = fixture(t);
  const original = priorConfig(data);
  prepareRegistryAttestationAuth(data.options);
  const bridge = fs.readFileSync(data.target);
  fs.writeFileSync(data.target, 'CONCURRENT_PRIVATE_CONFIG');
  assert.throws(() => cleanupRegistryAttestationAuth(data.options), failure);
  assert.equal(fs.readFileSync(data.target, 'utf8'), 'CONCURRENT_PRIVATE_CONFIG');
  assert.deepEqual(fs.readFileSync(join(data.state, 'original.json')), original);
  fs.writeFileSync(data.target, bridge);
  fs.linkSync(join(data.state, 'original.json'), join(data.root, 'backup-link'));
  assert.throws(() => cleanupRegistryAttestationAuth(data.options), failure);
  fs.unlinkSync(join(data.root, 'backup-link'));
  cleanupRegistryAttestationAuth(data.options);
  assert.deepEqual(fs.readFileSync(data.target), original);
});

for (const operation of ['prepare', 'cleanup']) {
  test(`${operation} refuses a config changed while its atomic replacement is being written`, (t) => {
    const data = fixture(t);
    const original = priorConfig(data);
    if (operation === 'cleanup') prepareRegistryAttestationAuth(data.options);
    const fileSystem = {
      ...fs,
      fsyncSync(descriptor) {
        fs.fsyncSync(descriptor);
        if (fs.existsSync(data.temporary))
          fs.writeFileSync(data.target, 'CONCURRENT_PRIVATE_CONFIG');
      },
    };
    const action =
      operation === 'prepare' ? prepareRegistryAttestationAuth : cleanupRegistryAttestationAuth;
    assert.throws(() => action({ ...data.options, fileSystem }), failure);
    assert.equal(fs.readFileSync(data.target, 'utf8'), 'CONCURRENT_PRIVATE_CONFIG');
    assert.deepEqual(fs.readFileSync(join(data.state, 'original.json')), original);
    assert.equal(fs.existsSync(join(data.state, 'state.json')), true);
  });
}

test('runner and path guards reject non-disposable or overlapping configuration contexts', (t) => {
  const data = fixture(t);
  for (const env of [
    { ...data.options.env, GITHUB_ACTIONS: 'false' },
    { ...data.options.env, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...data.options.env, DOCKER_CONFIG: data.directory },
    { ...data.options.env, DOCKER_CONFIG: 'relative' },
    { ...data.options.env, DOCKER_CONFIG: undefined },
  ])
    assert.throws(() => prepareRegistryAttestationAuth({ ...data.options, env }), failure);
});

test('CLI failures expose no paths, credential content, raw filesystem or JSON diagnostics', () => {
  const cli = new URL('./registry-attestation-auth.mjs', import.meta.url).pathname;
  for (const args of [[], ['unknown'], ['prepare', 'extra'], ['prepare']]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, GITHUB_ACTIONS: 'false', DOCKER_CONFIG: '/PRIVATE_PATH_WITH_SECRET' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${attestationAuthFailureMessage}\n`);
  }
});
