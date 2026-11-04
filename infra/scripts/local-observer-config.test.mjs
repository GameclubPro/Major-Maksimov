import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureObserverStateDirectory,
  initializeObserverConfiguration,
  readObserverConfiguration,
  OBSERVER_ADDRESS,
  OBSERVER_URL,
} from './local-observer-config.mjs';
import {
  readObserverPrivate,
  writeObserverPrivate,
  privateDirectory,
} from './local-observer-files.mjs';

function fixture(t) {
  const floor = fs.mkdtempSync(join(tmpdir(), 'maxim-observer-config-'));
  fs.mkdirSync(join(floor, 'config-parent'), { mode: 0o755 });
  fs.mkdirSync(join(floor, 'state-parent'), { mode: 0o755 });
  t.after(() => fs.rmSync(floor, { force: true, recursive: true }));
  return {
    floor,
    directory: join(floor, 'config-parent/observer'),
    stateDirectory: join(floor, 'state-parent/observer'),
  };
}

test('safe standard 0755 parents admit new private configuration without activating or exposing secrets', (t) => {
  const { floor, directory, stateDirectory } = fixture(t);
  const result = initializeObserverConfiguration(directory, { floor, stateDirectory });
  assert.equal(result.status, 'PREPARED_NOT_ACTIVATED');
  const config = readObserverConfiguration(directory, { floor });
  assert.equal(config.overviewUrl, OBSERVER_URL);
  assert.equal(config.smtpConfigured, false);
  assert.equal(config.smtp.to, OBSERVER_ADDRESS);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(config.reader.token, 'u'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(config.reader.basicPassword, 'u'));
  const provision = JSON.parse(readObserverPrivate(result.serverProvisionFile, { floor }));
  assert.equal(
    provision.readerTokenSha256,
    createHash('sha256').update(config.reader.token).digest('hex'),
  );
  assert.equal(provision.basicPassword, config.reader.basicPassword);
  for (const name of fs.readdirSync(directory))
    assert.equal(fs.statSync(join(directory, name)).mode & 0o777, 0o600);
  assert.equal(ensureObserverStateDirectory(config, { floor }), stateDirectory);
  assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(join(stateDirectory, 'state.json')), false);
  assert.throws(() => initializeObserverConfiguration(directory, { floor, stateDirectory }), {
    code: 'OBSERVER_CONFIGURATION_EXISTS',
  });
  assert.equal(readObserverConfiguration(directory, { floor }).reader.token, config.reader.token);
});

test('application password reload accepts one line and refuses unsafe permissions or content', (t) => {
  const { floor, directory, stateDirectory } = fixture(t);
  const result = initializeObserverConfiguration(directory, { floor, stateDirectory });
  writeObserverPrivate(result.passwordFile, 'fixture-application-password\n', { floor });
  assert.equal(readObserverConfiguration(directory, { floor }).smtpConfigured, true);
  assert.equal(
    readObserverConfiguration(directory, { floor }).smtp.password,
    'fixture-application-password',
  );
  writeObserverPrivate(result.passwordFile, 'fixture\r\nheader: injected', { floor });
  assert.throws(() => readObserverConfiguration(directory, { floor }), {
    code: 'OBSERVER_SMTP_CONFIGURATION_INVALID',
  });
  fs.chmodSync(result.passwordFile, 0o644);
  assert.throws(() => readObserverConfiguration(directory, { floor }), {
    code: 'OBSERVER_UNSAFE_FILE',
  });
});

test('fixed destination, origin and path contracts reject silent configuration widening', (t) => {
  const { floor, directory, stateDirectory } = fixture(t);
  initializeObserverConfiguration(directory, { floor, stateDirectory });
  const configPath = join(directory, 'config.json');
  const original = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const change of [
    { overviewUrl: 'https://untrusted.example/secret' },
    { stateDirectory: 'relative' },
    { unreviewedOption: true },
  ]) {
    writeObserverPrivate(configPath, JSON.stringify({ ...original, ...change }), { floor });
    assert.throws(() => readObserverConfiguration(directory, { floor }), {
      code: 'OBSERVER_CONFIGURATION_INVALID',
    });
  }
  writeObserverPrivate(configPath, JSON.stringify(original), { floor });
  writeObserverPrivate(
    join(directory, 'smtp.json'),
    JSON.stringify({ username: OBSERVER_ADDRESS, from: OBSERVER_ADDRESS, to: 'other@mail.ru' }),
    { floor },
  );
  assert.throws(() => readObserverConfiguration(directory, { floor }), {
    code: 'OBSERVER_CONFIGURATION_INVALID',
  });
});

test('unsafe parent, public leaf, symlink and hardlink are refused without changing their target', (t) => {
  const { floor, directory, stateDirectory } = fixture(t);
  fs.chmodSync(join(floor, 'config-parent'), 0o777);
  assert.throws(() => initializeObserverConfiguration(directory, { floor, stateDirectory }), {
    code: 'OBSERVER_UNSAFE_DIRECTORY',
  });
  fs.chmodSync(join(floor, 'config-parent'), 0o755);
  initializeObserverConfiguration(directory, { floor, stateDirectory });
  fs.chmodSync(directory, 0o755);
  assert.throws(() => privateDirectory(directory, { floor }), {
    code: 'OBSERVER_PRIVATE_DIRECTORY_REQUIRED',
  });
  fs.chmodSync(directory, 0o700);
  const target = join(directory, 'private-target');
  writeObserverPrivate(target, 'preserved', { floor });
  fs.symlinkSync(target, join(directory, 'link'));
  assert.throws(() => readObserverPrivate(join(directory, 'link'), { floor }), {
    code: 'OBSERVER_UNSAFE_FILE',
  });
  assert.throws(() => writeObserverPrivate(join(directory, 'link'), 'changed', { floor }), {
    code: 'OBSERVER_UNSAFE_FILE',
  });
  fs.linkSync(target, join(directory, 'hardlink'));
  assert.throws(() => readObserverPrivate(target, { floor }), { code: 'OBSERVER_UNSAFE_FILE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved');
});
