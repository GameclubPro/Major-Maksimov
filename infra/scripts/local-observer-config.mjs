import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  observerFailure,
  privateDirectory,
  readObserverPrivate,
  writeObserverPrivate,
} from './local-observer-files.mjs';

export const OBSERVER_URL =
  'https://admin.major-maksimov.ru/api/v1/safety-desk/runtime-observer/overview';
export const OBSERVER_ADDRESS = '73budchenko@mail.ru';
export const defaultObserverDirectory = () => join(homedir(), '.config/maxim-observer');
const exact = (value, keys) =>
  value &&
  !Array.isArray(value) &&
  typeof value === 'object' &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const parse = (path, options) => {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readObserverPrivate(path, options)),
    );
  } catch {
    observerFailure('OBSERVER_CONFIGURATION_UNAVAILABLE');
  }
};
function createDirectory(directory, floor) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  privateDirectory(directory, { floor });
}
export function initializeObserverConfiguration(
  directory = defaultObserverDirectory(),
  { stateDirectory = join(homedir(), '.local/state/maxim-observer'), floor = '/' } = {},
) {
  if (!isAbsolute(directory) || !isAbsolute(stateDirectory))
    observerFailure('OBSERVER_ABSOLUTE_PATH_REQUIRED');
  // FLAG: Initialize only a new private directory. Never replace existing reader/SMTP secrets.
  privateDirectory(dirname(directory), { floor, privateLeaf: false });
  if (fs.existsSync(directory)) observerFailure('OBSERVER_CONFIGURATION_EXISTS');
  createDirectory(directory, floor);
  const token = randomBytes(32).toString('hex');
  const basicPassword = randomBytes(32).toString('base64url');
  const write = (name, value) =>
    writeObserverPrivate(join(directory, name), value, { floor, exclusive: true });
  write(
    'config.json',
    JSON.stringify({ schemaVersion: 1, overviewUrl: OBSERVER_URL, stateDirectory }) + '\n',
  );
  write(
    'overview-reader.json',
    JSON.stringify({
      token,
      basicUsername: 'maxim-observer',
      basicPassword,
    }) + '\n',
  );
  write(
    'smtp.json',
    JSON.stringify({
      username: OBSERVER_ADDRESS,
      from: OBSERVER_ADDRESS,
      to: OBSERVER_ADDRESS,
    }) + '\n',
  );
  write('mailru-app-password', '');
  write(
    'server-provision.json',
    JSON.stringify({
      schemaVersion: 1,
      readerTokenSha256: createHash('sha256').update(token).digest('hex'),
      basicUsername: 'maxim-observer',
      basicPassword,
    }) + '\n',
  );
  return {
    configurationDirectory: directory,
    passwordFile: join(directory, 'mailru-app-password'),
    serverProvisionFile: join(directory, 'server-provision.json'),
    status: 'PREPARED_NOT_ACTIVATED',
  };
}
export function readObserverConfiguration(
  directory = defaultObserverDirectory(),
  { floor = '/' } = {},
) {
  privateDirectory(directory, { floor });
  const options = { floor, maxBytes: 16384 };
  const config = parse(join(directory, 'config.json'), options);
  const reader = parse(join(directory, 'overview-reader.json'), options);
  const smtp = parse(join(directory, 'smtp.json'), options);
  if (
    !exact(config, ['schemaVersion', 'overviewUrl', 'stateDirectory']) ||
    config.schemaVersion !== 1 ||
    config.overviewUrl !== OBSERVER_URL ||
    typeof config.stateDirectory !== 'string' ||
    !isAbsolute(config.stateDirectory) ||
    resolve(config.stateDirectory) !== config.stateDirectory ||
    !exact(reader, ['token', 'basicUsername', 'basicPassword']) ||
    !/^[a-f0-9]{64}$/u.test(reader.token ?? '') ||
    reader.basicUsername !== 'maxim-observer' ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(reader.basicPassword ?? '') ||
    !exact(smtp, ['username', 'from', 'to']) ||
    !Object.values(smtp).every((address) => address === OBSERVER_ADDRESS)
  )
    observerFailure('OBSERVER_CONFIGURATION_INVALID');
  const bytes = readObserverPrivate(join(directory, 'mailru-app-password'), {
    floor,
    maxBytes: 2048,
    empty: true,
  });
  const password = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/u, '');
  if (password && !/^[\x21-\x7e]{8,1024}$/u.test(password))
    observerFailure('OBSERVER_SMTP_CONFIGURATION_INVALID');
  return {
    directory,
    ...config,
    reader,
    smtp: { ...smtp, password },
    smtpConfigured: password.length > 0,
  };
}
export function ensureObserverStateDirectory(config, { floor = '/' } = {}) {
  privateDirectory(dirname(config.stateDirectory), { floor, privateLeaf: false });
  createDirectory(config.stateDirectory, floor);
  return config.stateDirectory;
}
