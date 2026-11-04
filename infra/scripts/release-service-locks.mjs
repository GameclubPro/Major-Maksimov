import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const PROTOCOL = 'major-karavan-release-v1';
const RECEIPT_KEYS = [
  'protocol',
  'token',
  'product',
  'mode',
  'target',
  'pid',
  'start',
  'boot',
  'cwd',
  'fd',
  'inode',
  'initial_state',
  'started_at',
];
const DECIMAL = /^[0-9]{1,24}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{16,128}$/u;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail() {
  const error = new Error('Release service LOCK_UNPROVED.');
  error.code = 'LOCK_UNPROVED';
  throw error;
}

function full(value, pattern) {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}
function sameFile(left, right) {
  return (
    identity(left) === identity(right) &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}
function mode(stat) {
  return stat.mode & 0o7777n;
}
function decimalPid(value) {
  return full(value, /^[1-9][0-9]{0,9}$/u) && BigInt(value) <= 2147483647n;
}
function descriptor(value) {
  return full(value, /^[1-9][0-9]{1,5}$/u);
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail();
  return path;
}

function protectedDirectory(path, context) {
  const { fileSystem, floor, uid, rootUid } = context;
  absolute(path);
  if (path !== floor && !path.startsWith(`${floor === '/' ? '' : floor}/`)) fail();
  let current = path;
  let result;
  while (true) {
    const stat = fileSystem.lstatSync(current, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (mode(stat) & 0o022n) !== 0n ||
      (uid !== rootUid && stat.uid !== rootUid && stat.uid !== uid)
    )
      fail();
    if (current === path) result = stat;
    if (current === floor) return result;
    current = dirname(current);
  }
}

function protectedFile(path, { owner, privateMode = false }, context) {
  const stat = context.fileSystem.lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== owner ||
    (privateMode ? mode(stat) !== 0o600n : (mode(stat) & 0o022n) !== 0n)
  )
    fail();
  return stat;
}

function boundedBytes(path, maximum, context, expected) {
  const { fileSystem } = context;
  const constants = fileSystem.constants ?? fs.constants;
  const fd = fileSystem.openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fileSystem.fstatSync(fd, { bigint: true });
    if (!before.isFile() || (expected && !sameFile(before, expected))) fail();
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fileSystem.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maximum || !sameFile(before, fileSystem.fstatSync(fd, { bigint: true }))) fail();
    if (expected && !sameFile(before, fileSystem.lstatSync(path, { bigint: true }))) fail();
    return buffer.subarray(0, length);
  } finally {
    fileSystem.closeSync(fd);
  }
}

function processState(pid, context) {
  const value = decoder.decode(boundedBytes(join(context.proc, pid, 'stat'), 8192, context));
  const separator = value.lastIndexOf(') ');
  if (!value.startsWith(`${pid} (`) || separator < pid.length + 2) fail();
  const fields = value
    .slice(separator + 2)
    .trimEnd()
    .split(/\s+/u);
  if (
    fields.length < 20 ||
    !full(fields[0], /^[A-Za-z]$/u) ||
    ['Z', 'X', 'x'].includes(fields[0]) ||
    !(fields[1] === '0' || decimalPid(fields[1])) ||
    !full(fields[19], DECIMAL)
  )
    fail();
  return { pid, parent: fields[1], start: fields[19] };
}

function ancestry(pid, owners, context) {
  const seen = new Map();
  let current = processState(pid, context);
  seen.set(current.pid, current);
  // FLAG: Environment ownership is evidence only when the live holder is in this
  // bounded parent chain. A sibling holding a real flock grants no authority.
  for (let depth = 0; depth < 32; depth += 1) {
    if (current.parent === '0' || seen.has(current.parent)) fail();
    current = processState(current.parent, context);
    seen.set(current.pid, current);
    if (owners.every((owner) => owner !== pid && seen.has(owner))) return [...seen.values()];
  }
  fail();
}

function assertDescriptor(pid, fd, lock, context) {
  const path = join(context.proc, pid, 'fd', fd);
  const stat = context.fileSystem.statSync(path, { bigint: true });
  if (!sameFile(stat, lock)) fail();
  const info = decoder.decode(boundedBytes(join(context.proc, pid, 'fdinfo', fd), 16384, context));
  const major = ((lock.dev >> 8n) & 0xfffn) | ((lock.dev >> 32n) & ~0xfffn);
  const minor = (lock.dev & 0xffn) | ((lock.dev >> 12n) & ~0xffn);
  const locks = info.split('\n').filter((line) => line.startsWith('lock:'));
  // FLAG: The same inode can be open without holding its flock. Only this exact
  // open description's exclusive whole-file kernel record establishes the fence.
  if (
    !locks.some((line) => {
      const match =
        /^lock:\s+[0-9]+:\s+FLOCK\s+ADVISORY\s+WRITE\s+[0-9]+\s+([a-fA-F0-9]+):([a-fA-F0-9]+):([0-9]+)\s+0\s+EOF$/u.exec(
          line,
        );
      return (
        match?.[0] === line &&
        BigInt(`0x${match[1]}`) === major &&
        BigInt(`0x${match[2]}`) === minor &&
        BigInt(match[3]) === lock.ino
      );
    })
  )
    fail();
}

function readReceipt(path, owner, context) {
  const stat = protectedFile(path, { owner, privateMode: true }, context);
  const bytes = boundedBytes(path, 8192, context, stat);
  const value = decoder.decode(bytes);
  if (!value.endsWith('\n')) fail();
  const receipt = Object.create(null);
  for (const line of value.slice(0, -1).split('\n')) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    if (separator < 1 || !RECEIPT_KEYS.includes(key) || Object.hasOwn(receipt, key)) fail();
    receipt[key] = line.slice(separator + 1);
  }
  if (
    Object.keys(receipt).length !== RECEIPT_KEYS.length ||
    receipt.protocol !== PROTOCOL ||
    receipt.product !== 'major' ||
    !['runtime', 'tooling'].includes(receipt.mode) ||
    (receipt.target !== '' && !full(receipt.target, SHA)) ||
    !full(receipt.token, TOKEN) ||
    !decimalPid(receipt.pid) ||
    !descriptor(receipt.fd) ||
    !full(receipt.start, DECIMAL) ||
    !full(receipt.boot, BOOT) ||
    !full(receipt.cwd, HASH) ||
    !full(receipt.inode, /^[0-9]{1,24}:[0-9]{1,24}$/u) ||
    !full(receipt.initial_state, HASH) ||
    !full(
      receipt.started_at,
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u,
    ) ||
    !Number.isFinite(Date.parse(receipt.started_at)) ||
    new Date(receipt.started_at).toISOString() !== receipt.started_at
  )
    fail();
  return { receipt, fingerprint: digest(bytes), stat };
}

function pairProcess(receipt, context) {
  const process = processState(receipt.pid, context);
  const boot = decoder.decode(
    boundedBytes(join(context.proc, 'sys/kernel/random/boot_id'), 128, context),
  );
  const cwd = context.fileSystem.realpathSync(join(context.proc, receipt.pid, 'cwd'));
  if (
    process.start !== receipt.start ||
    boot !== `${receipt.boot}\n` ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd) ||
    digest(cwd) !== receipt.cwd
  )
    fail();
  return process;
}

export function assertReleaseLocks({
  env = process.env,
  fileSystem = fs,
  proc = '/proc',
  floor = '/',
  productLock = '/var/lib/maxim-deploy/deploy.lock',
  pairDirectory = '/var/lib/major-karavan-release',
  pid = process.pid,
  uid = process.getuid(),
  rootUid = 0,
} = {}) {
  try {
    const context = {
      fileSystem,
      proc: absolute(proc),
      floor: absolute(floor),
      uid: BigInt(uid),
      rootUid: BigInt(rootUid),
    };
    absolute(productLock);
    absolute(pairDirectory);
    const ownPid = String(pid);
    const productPid = env.MAXIM_DEPLOY_LOCK_OWNER_PID;
    const productFd = env.MAXIM_DEPLOY_LOCK_FD;
    const pairPid = env.PAIR_RELEASE_ADMISSION_OWNER_PID;
    const pairFd = env.PAIR_RELEASE_ADMISSION_FD;
    if (
      !decimalPid(ownPid) ||
      !decimalPid(productPid) ||
      !decimalPid(pairPid) ||
      !descriptor(productFd) ||
      !descriptor(pairFd) ||
      env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
      !full(env.MAXIM_DEPLOY_LOCK_IDENTITY, /^[0-9]{1,24}:[0-9]{1,24}$/u) ||
      !full(env.PAIR_RELEASE_ADMISSION_TOKEN, TOKEN) ||
      (env.PAIR_RELEASE_EXPECTED_STATE_SHA256 !== undefined &&
        env.PAIR_RELEASE_EXPECTED_STATE_SHA256 !== '' &&
        !full(env.PAIR_RELEASE_EXPECTED_STATE_SHA256, HASH))
    )
      fail();
    const chain = ancestry(ownPid, [productPid, pairPid], context);
    const productDirectory = protectedDirectory(dirname(productLock), context);
    const product = protectedFile(
      productLock,
      { owner: productDirectory.uid, privateMode: true },
      context,
    );
    const pair = protectedDirectory(pairDirectory, context);
    const stateDirectory = join(pairDirectory, 'state');
    const state = protectedDirectory(stateDirectory, context);
    if (
      pair.uid !== context.rootUid ||
      mode(state) !== 0o700n ||
      (context.uid !== context.rootUid && state.uid !== context.uid)
    )
      fail();
    for (const name of ['protocol-v1', 'admission.sh', 'state.mjs']) {
      const path = join(pairDirectory, name);
      const installed = protectedFile(path, { owner: context.rootUid }, context);
      if (name === 'protocol-v1') {
        const value = decoder.decode(boundedBytes(path, 128, context, installed));
        if (value !== PROTOCOL && value !== `${PROTOCOL}\n`) fail();
      }
    }
    const pairLock = join(stateDirectory, 'admission.lock');
    const pairStat = protectedFile(pairLock, { owner: state.uid, privateMode: true }, context);
    const receiptPath = join(stateDirectory, 'admission.owner');
    const before = readReceipt(receiptPath, state.uid, context);
    const { receipt } = before;
    if (
      env.MAXIM_DEPLOY_LOCK_IDENTITY !== identity(product) ||
      receipt.pid !== pairPid ||
      receipt.fd !== pairFd ||
      receipt.token !== env.PAIR_RELEASE_ADMISSION_TOKEN ||
      receipt.inode !== identity(pairStat) ||
      (env.PAIR_RELEASE_EXPECTED_STATE_SHA256 &&
        receipt.initial_state !== env.PAIR_RELEASE_EXPECTED_STATE_SHA256)
    )
      fail();
    pairProcess(receipt, context);
    assertDescriptor(productPid, productFd, product, context);
    assertDescriptor(pairPid, pairFd, pairStat, context);
    const after = readReceipt(receiptPath, state.uid, context);
    if (
      after.fingerprint !== before.fingerprint ||
      !sameFile(after.stat, before.stat) ||
      !sameFile(
        protectedFile(productLock, { owner: productDirectory.uid, privateMode: true }, context),
        product,
      ) ||
      !sameFile(
        protectedFile(pairLock, { owner: state.uid, privateMode: true }, context),
        pairStat,
      ) ||
      JSON.stringify(ancestry(ownPid, [productPid, pairPid], context)) !== JSON.stringify(chain)
    )
      fail();
    pairProcess(receipt, context);
    assertDescriptor(productPid, productFd, product, context);
    assertDescriptor(pairPid, pairFd, pairStat, context);
    return true;
  } catch {
    fail();
  }
}
