#!/usr/bin/env node
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL = 'major-market-release-v1';
export const TRUST = '/etc/maxim-deploy/major-market-release';
export const MARKET_OWNER_FILES = [
  'infra/scripts/release-readback.mjs',
  'infra/scripts/verify-release-source.mjs',
  'scripts/lib/release-provenance.mjs',
];
const LOCK = '/var/lib/maxim-deploy/deploy.lock';
const MAJOR = '/var/www/Chat_bot';
const MARKET = '/var/www/svyazka';
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const COMPONENTS = ['admin-static', 'api-shared', 'eraser', 'miniapp-major-static'];
const PROFILES = ['birzhik-core@1', 'statistics-central@1'];
export const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const digest = (value) => createHash('sha256').update(value).digest('hex');
function fail(message, cause) {
  throw new Error(`Major/Market release: ${message}`, { cause });
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    fail('invalid object fields');
}
function sorted(values, allowed) {
  if (
    !Array.isArray(values) ||
    values.some((x) => typeof x !== 'string' || !allowed.includes(x)) ||
    values.join('|') !== [...new Set(values)].sort().join('|')
  )
    fail('unknown, duplicate or unsorted selection');
  return values;
}
export function parseProfiles(value = '') {
  return sorted(value ? value.split(',') : [], PROFILES);
}

// FLAG: No path/UID environment overrides exist. Tests relocate these fixed paths in a private copy.
export function safeParents(file, rootOnly = false) {
  if (!isAbsolute(file)) fail('absolute file path required');
  for (let path = dirname(file); ; path = dirname(path)) {
    const item = lstatSync(path);
    if (
      !item.isDirectory() ||
      item.isSymbolicLink() ||
      item.mode & 0o022 ||
      (item.uid !== 0 && (rootOnly || item.uid !== process.getuid()))
    )
      fail('unsafe file parent');
    if (path === '/') break;
  }
}
export function boundedFile(file, { rootOnly = false, maximum = 1048576, optional = false } = {}) {
  safeParents(file, rootOnly);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximum) ||
      before.mode & 0o022n ||
      (before.uid !== 0n && (rootOnly || before.uid !== BigInt(process.getuid())))
    )
      fail('unsafe bounded file');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'])
      if (before[key] !== after[key] || after[key] !== current[key])
        fail('file changed during observation');
    if (BigInt(count) !== after.size || current.isSymbolicLink())
      fail('file size/identity changed');
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
function jsonFile(file, options) {
  return JSON.parse(boundedFile(file, options).toString('utf8'));
}
export function requireLock() {
  const env = process.env;
  if (
    env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
    env.MAXIM_DEPLOY_LOCK_OWNER_PID !== String(process.ppid) ||
    !/^[1-9][0-9]{0,5}$/u.test(env.MAXIM_DEPLOY_LOCK_FD ?? '')
  )
    fail('foreign or missing lock owner');
  safeParents(LOCK);
  const item = lstatSync(LOCK);
  const descriptor = `/proc/${process.ppid}/fd/${env.MAXIM_DEPLOY_LOCK_FD}`;
  const fd = openSync(descriptor, constants.O_RDONLY);
  let opened;
  try {
    opened = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  if (
    !item.isFile() ||
    item.isSymbolicLink() ||
    item.nlink !== 1 ||
    (item.mode & 0o777) !== 0o600 ||
    item.dev !== opened.dev ||
    item.ino !== opened.ino ||
    `${item.dev}:${item.ino}` !== env.MAXIM_DEPLOY_LOCK_IDENTITY
  )
    fail('lock inode mismatch');
  const info = readFileSync(`/proc/${process.ppid}/fdinfo/${env.MAXIM_DEPLOY_LOCK_FD}`, 'utf8');
  if (!/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info))
    fail('exclusive whole-file flock is not held');
}
export function installed() {
  const marker = jsonFile(join(TRUST, 'protocol-v1.json'), { rootOnly: true, maximum: 16384 });
  exact(marker, [
    'schemaVersion',
    'protocol',
    'protocolVersion',
    'guardSha256',
    'majorSha',
    'marketSha',
    'marketOwnerFiles',
  ]);
  if (
    marker.schemaVersion !== 1 ||
    marker.protocol !== PROTOCOL ||
    marker.protocolVersion !== 1 ||
    !HASH.test(marker.guardSha256) ||
    !SHA.test(marker.majorSha) ||
    !SHA.test(marker.marketSha)
  )
    fail('invalid installed protocol');
  if (digest(boundedFile(join(TRUST, 'guard.mjs'), { rootOnly: true })) !== marker.guardSha256)
    fail('installed guard bytes differ');
  exact(marker.marketOwnerFiles, MARKET_OWNER_FILES);
  for (const file of MARKET_OWNER_FILES)
    if (
      !HASH.test(marker.marketOwnerFiles[file]) ||
      digest(boundedFile(join(TRUST, 'market-owner', file), { rootOnly: true })) !==
        marker.marketOwnerFiles[file]
    )
      fail('installed Market owner reader differs');
  return {
    protocolVersion: 1,
    guardSha256: marker.guardSha256,
    marketOwnerSha256: digest(canonical(marker.marketOwnerFiles)),
  };
}
const CORE_KEYS = {
  major: ['SVYAZKA_PROFILE_TOKEN', 'SVYAZKA_INTEGRATION_TOKEN'],
  market: ['MAXIM_PROFILE_TOKEN', 'MAJOR_INTEGRATION_TOKEN'],
};
const STAT_KEYS = {
  major: [
    'SVYAZKA_ANALYTICS_TOKEN',
    'SVYAZKA_STATISTICS_EXPORT_TOKEN',
    'STATISTICS_CENTRAL_ENABLED',
    'STATISTICS_CENTRAL_MODE',
    'STATISTICS_CENTRAL_EXCHANGE_EPOCH',
    'STATISTICS_EXCHANGE_V3_ENABLED',
    'SVYAZKA_STATISTICS_V2_USERS',
  ],
  market: [
    'MAXIM_ANALYTICS_TOKEN',
    'MAXIM_STATISTICS_EXPORT_TOKEN',
    'MAXIM_EXCHANGE_V3_ENABLED',
    'MAXIM_STATISTICS_ACTOR_IDS',
  ],
};
export function configDigest(bytes, owner, profiles) {
  const keys = [
    ...new Set([
      ...CORE_KEYS[owner],
      ...(profiles.includes('statistics-central@1') ? STAT_KEYS[owner] : []),
    ]),
  ].sort();
  const values = Object.fromEntries(keys.map((key) => [key, null]));
  const seen = new Set();
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (/^\s*(?:#|$)/u.test(line)) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) fail('invalid dotenv line');
    if (!keys.includes(match[1])) continue;
    if (seen.has(match[1])) fail('duplicate significant configuration');
    seen.add(match[1]);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.at(-1) !== quote) fail('unsupported multiline significant configuration');
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/u, '').trimEnd();
    values[match[1]] = value;
  }
  return digest(canonical({ scopeVersion: 1, owner, values }));
}
function component(id, value) {
  if (
    !COMPONENTS.includes(id) ||
    !value ||
    !SHA.test(value.sourceSha) ||
    !IMAGE.test(value.imageId) ||
    typeof value.imageRef !== 'string' ||
    !/^[a-z0-9][a-z0-9./:_-]{0,200}$/u.test(value.imageRef)
  )
    fail('invalid Major component identity');
  return { id, sourceSha: value.sourceSha, imageRef: value.imageRef, imageId: value.imageId };
}
export function snapshot(profiles, { allowTransition = false } = {}) {
  sorted(profiles, PROFILES);
  const guard = installed();
  let major;
  try {
    major = jsonFile('/var/lib/maxim-deploy/current.json');
  } catch (error) {
    if (!allowTransition || error.code !== 'ENOENT') throw error;
    requireLock();
    const names = readdirSync('/var/lib/maxim-deploy');
    if (names.length > 4096) fail('manifest inventory budget');
    const journals = names.filter((name) =>
      /^current\.invalid-(?:deploy|runtime-rollback)-\d{8}T\d{6}Z-\d+\.json$/u.test(name),
    );
    if (journals.length !== 1) fail('ambiguous/missing active transition manifest');
    major = jsonFile(join('/var/lib/maxim-deploy', journals[0]));
  }
  const market = jsonFile(join(MARKET, 'current.json'));
  if (!major.components || typeof major.components !== 'object' || Array.isArray(major.components))
    fail('missing Major component inventory');
  const components = Object.entries(major.components)
    .map(([id, value]) => component(id, value))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const id of ['api-shared', 'miniapp-major-static', 'admin-static'])
    if (!components.some((item) => item.id === id)) fail('incomplete Major component inventory');
  if (
    !SHA.test(market.sourceSha) ||
    !IMAGE.test(market.imageId) ||
    market.image !== `svyazka-app:${market.sourceSha}` ||
    market.url !== 'https://major-maksimov.ru/market/'
  )
    fail('invalid Market manifest identity');
  const floor = '/etc/maxim-deploy/market-statistics';
  const statistics = boundedFile(join(floor, 'floor.json'), {
    rootOnly: true,
    optional: true,
    maximum: 16384,
  });
  const authority = boundedFile(join(floor, 'authority-lifecycle-floor.json'), {
    rootOnly: true,
    optional: true,
    maximum: 16384,
  });
  if (profiles.includes('statistics-central@1') && (!statistics || !authority))
    fail('statistics floors are not installed');
  const state = {
    host: {
      id: 'maxim-vps',
      majorRoot: MAJOR,
      marketRoot: MARKET,
      majorUrl: 'https://major-maksimov.ru/app/',
      marketUrl: 'https://major-maksimov.ru/market/',
    },
    major: { manifestSha256: digest(canonical(components)), components },
    market: {
      manifestSha256: digest(
        canonical({
          sourceSha: market.sourceSha,
          imageRef: market.image,
          imageId: market.imageId,
          url: market.url,
        }),
      ),
      sourceSha: market.sourceSha,
      imageRef: market.image,
      imageId: market.imageId,
      url: market.url,
    },
    configuration: {
      scopeVersion: 1,
      majorSha256: configDigest(boundedFile(join(MAJOR, '.env')), 'major', profiles),
      marketSha256: configDigest(
        boundedFile(join(MARKET, 'shared/.env.production')),
        'market',
        profiles,
      ),
    },
    floors: {
      statisticsSha256: statistics ? digest(statistics) : null,
      authorityLifecycleSha256: authority ? digest(authority) : null,
      guardSha256: guard.guardSha256,
      marketOwnerSha256: guard.marketOwnerSha256,
      protocolVersion: 1,
    },
  };
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    profiles,
    state,
    stateSha256: digest(canonical({ protocol: PROTOCOL, profiles, state })),
    observedAt: new Date().toISOString(),
    installed: guard,
  };
}
export function expectationFromEnvironment() {
  const encoded = process.env.MAJOR_MARKET_RELEASE_EXPECTATION_B64 ?? '';
  const expected = process.env.MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256 ?? '';
  if (!encoded && !expected) return null;
  if (
    !HASH.test(expected) ||
    encoded.length > 65536 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  )
    fail('missing or invalid expectation transport');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail('noncanonical base64');
  const value = JSON.parse(bytes.toString('utf8'));
  exact(value, ['schemaVersion', 'protocol', 'profiles', 'stateSha256', 'step', 'compatibility']);
  exact(value.step, ['product', 'targetSha', 'components', 'archiveSha256', 'provenanceSha256']);
  exact(value.compatibility, ['fixtureSha256', 'proofRefsDigest']);
  sorted(value.profiles, PROFILES);
  sorted(value.step.components, COMPONENTS);
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== PROTOCOL ||
    !HASH.test(value.stateSha256) ||
    !SHA.test(value.step.targetSha) ||
    !['major', 'market'].includes(value.step.product) ||
    !HASH.test(value.compatibility.fixtureSha256) ||
    !HASH.test(value.compatibility.proofRefsDigest)
  )
    fail('invalid expectation identity');
  if (
    value.step.product === 'market'
      ? value.step.components.length ||
        !HASH.test(value.step.archiveSha256) ||
        !HASH.test(value.step.provenanceSha256)
      : !value.step.components.length ||
        value.step.archiveSha256 !== null ||
        value.step.provenanceSha256 !== null
  )
    fail('invalid owner target inputs');
  if (digest(canonical(value)) !== expected) fail('whole expectation digest mismatch');
  return value;
}
function shellLines(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*#/u.test(line) ? '' : line.trim()))
    .filter(Boolean);
}
function ordered(lines, expected) {
  let previous = -1;
  for (const value of expected) {
    const position = lines.indexOf(value);
    if (position <= previous) fail(`missing/reordered executable hook: ${value}`);
    previous = position;
  }
}
function onlyFunctionCall(lines, name, call) {
  const start = lines.indexOf(`${name}() {`);
  if (start < 0 || lines[start + 1] !== call || lines[start + 2] !== '}')
    fail('source guard function ignores or changes installed call');
}
const LOCK_CAPABILITIES = {
  major_market_release_trust: '9e0e0c33133a343861bfac5f39cbf64dcffd8761b9f8345c34602a301e5bc7b1',
  validate_major_market_release_admission:
    'b93aa3f7febe67de4c5d24e4fd62a25dfe57bc23dccfda77e9f6f76dcb68f095',
  require_major_market_release_dispatch:
    '078f2a13be5b2105905ac1eb2e27715822989b21c36e120b991bec6b9e1353a5',
  major_market_release_verify: 'e21dedb16694dc73188eb53950943fa69617008c6e81be9d83d33e706ce478a0',
  acquire_deploy_lock: 'bdfe3f26fca3c7ea3c64f4a4ad78836ff87cb288ece7b33d6b5dab5e7ffcd4e6',
};
export function checkSource(source, owner, ref) {
  if (!['major', 'market'].includes(owner) || !isAbsolute(source))
    fail('invalid source owner/path');
  const read = (relative) => {
    if (ref) {
      if (!/^[a-zA-Z0-9_./-]{1,200}$/u.test(ref) || ref.startsWith('-'))
        fail('invalid candidate ref');
      const size = Number(
        execFileSync('git', ['-C', source, 'cat-file', '-s', `${ref}:${relative}`], {
          timeout: 3000,
          maxBuffer: 1024,
        })
          .toString()
          .trim(),
      );
      if (!Number.isSafeInteger(size) || size < 1 || size > 262144) fail('candidate source size');
      return execFileSync('git', ['-C', source, 'show', `${ref}:${relative}`], {
        timeout: 3000,
        maxBuffer: 262145,
      }).toString();
    }
    return boundedFile(join(source, relative), { maximum: 262144 }).toString('utf8');
  };
  if (owner === 'market') {
    const lines = shellLines(read('infra/scripts/deploy-vps.sh'));
    onlyFunctionCall(
      lines,
      'major_market_release_guard',
      'node /etc/maxim-deploy/major-market-release/guard.mjs verify --owner market --phase "$1" --source "$source_dir" --target-sha "$release"',
    );
    ordered(lines, [
      'major_market_release_guard() {',
      'node /etc/maxim-deploy/major-market-release/guard.mjs verify --owner market --phase "$1" --source "$source_dir" --target-sha "$release"',
      'major_market_release_guard before-build',
      'major_market_release_guard after-image-validation',
      'major_market_release_guard before-quiesce',
      'app_changed=1',
    ]);
    return;
  }
  const lockSource = read('infra/scripts/lib/deploy-lock.sh');
  // FLAG: These small authority functions are a closed capability floor. Merely
  // retaining a dead/ignored call or a comment cannot satisfy an installed reader.
  for (const [name, expected] of Object.entries(LOCK_CAPABILITIES)) {
    const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'mu').exec(lockSource)?.[0];
    if (!body || digest(body) !== expected)
      fail('Major lock authority implementation differs from installed capability floor');
  }
  const lock = shellLines(lockSource);
  for (const line of [
    'validate_major_market_release_admission() {',
    'require_major_market_release_dispatch() {',
    'validate_major_market_release_admission || return 1',
    'if ! validate_major_market_release_admission; then',
  ])
    if (!lock.includes(line)) fail('Major shared lock loses installed guard');
  const deploy = shellLines(read('infra/scripts/vps-pull-build-up.sh'));
  ordered(deploy, [
    'require_major_market_release_dispatch "origin/$BRANCH" || return 2',
    'require_major_market_release_dispatch "refs/heads/$BRANCH" || return 2',
  ]);
  ordered(deploy, [
    'sync_branch',
    'verify_expected_deploy_sha',
    'reexec_if_current_script_changed',
    'major_market_release_verify before-build',
    'prepare_deploy_disk_capacity',
  ]);
  ordered(deploy, [
    'major_market_release_verify before-build',
    'major_market_release_verify after-image-validation',
    'major_market_release_verify before-quiesce',
    'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES',
  ]);
  const rollback = shellLines(read('infra/scripts/vps-runtime-rollback.sh'));
  ordered(rollback, [
    'require_major_market_release_dispatch "$TARGET_FULL_SHA" || exit 1',
    'git switch --detach "$TARGET_FULL_SHA"',
    'major_market_release_verify before-build',
    'maxim_topology_build_shared_api_image "$ROLLBACK_API_IMAGE" "$TARGET_FULL_SHA"',
  ]);
  ordered(rollback, [
    'major_market_release_verify before-build',
    'major_market_release_verify after-image-validation',
    'major_market_release_verify before-quiesce',
    'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES',
  ]);
  const connector = shellLines(read('infra/scripts/vps-connect.sh'));
  if (
    !connector.includes(
      'require_major_market_release_dispatch "$expected_tooling_sha" || exit 1',
    ) ||
    !connector.some((line) => line.includes('export MAJOR_MARKET_RELEASE_EXPECTATION_B64=')) ||
    !connector.some((line) => line.includes('MAJOR_MARKET_RELEASE_EXPECTED_STATE_FROM_CALLER='))
  )
    fail('Major connector loses source floor/transport');
}
function hashArchive(file) {
  safeParents(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 4294967296n ||
      before.mode & 0o022n
    )
      fail('unsafe archive');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1048576);
    let count = 0n;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      count += BigInt(read);
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])
      if (before[key] !== after[key] || after[key] !== current[key]) fail('archive changed');
    if (count !== before.size) fail('archive read incomplete');
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function gitHash(kind, bytes) {
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
}
export function verifyMarketArchive(targetSha) {
  if (!SHA.test(targetSha)) fail('invalid Market archive target');
  const source = join(MARKET, 'releases', targetSha);
  const provenance = jsonFile(`${source}.provenance.json`, { maximum: 16777216 });
  if (
    provenance.kind !== 'svyazka-committed-source-v1' ||
    provenance.sourceSha !== targetSha ||
    !SHA.test(provenance.previousSha) ||
    !SHA.test(provenance.treeSha) ||
    !HASH.test(provenance.archiveSha256) ||
    !Array.isArray(provenance.commits) ||
    !provenance.commits.length ||
    provenance.commits.length > 4096 ||
    !Array.isArray(provenance.files) ||
    !provenance.files.length ||
    provenance.files.length > 32768
  )
    fail('invalid Market archive provenance');
  const current = jsonFile(join(MARKET, 'current.json'));
  if (
    current.sourceSha !== provenance.previousSha ||
    current.image !== `svyazka-app:${current.sourceSha}`
  )
    fail('Market production changed since archive preparation');
  if (hashArchive(`${source}.tar`) !== provenance.archiveSha256)
    fail('archive provenance digest differs');
  let previous = targetSha;
  for (const [index, entry] of provenance.commits.entries()) {
    if (entry.sha !== previous || typeof entry.raw !== 'string' || entry.raw.length > 131072)
      fail('invalid commit ancestry');
    const bytes = Buffer.from(entry.raw, 'base64');
    if (bytes.toString('base64') !== entry.raw || gitHash('commit', bytes) !== entry.sha)
      fail('commit proof differs');
    const headers = bytes.toString('utf8').split('\n\n', 1)[0].split('\n');
    const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
    if (!SHA.test(tree) || (!index && tree !== provenance.treeSha)) fail('commit tree differs');
    const next = provenance.commits[index + 1];
    if (next && (!SHA.test(next.sha) || !headers.includes(`parent ${next.sha}`)))
      fail('unrelated commit ancestry');
    previous = next?.sha ?? entry.sha;
  }
  if (previous !== provenance.previousSha) fail('archive ancestry does not reach running release');
  const tree = new Map();
  const files = new Map();
  for (const entry of provenance.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      entry.path.length > 4096 ||
      entry.path.includes('\\') ||
      [...entry.path].some(
        (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
      ) ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !['100644', '100755'].includes(entry.mode) ||
      !SHA.test(entry.blob) ||
      files.has(entry.path)
    )
      fail('unsafe provenance source path');
    files.set(entry.path, entry);
    const parts = entry.path.split('/');
    const name = parts.pop();
    let directory = tree;
    for (const part of parts) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part);
      if (!(directory instanceof Map)) fail('source tree path collision');
    }
    if (directory.has(name)) fail('source tree duplicate');
    directory.set(name, entry);
  }
  const treeHash = (directory) => {
    const entries = [...directory].map(([name, value]) => ({
      name,
      mode: value instanceof Map ? '40000' : value.mode,
      sha: value instanceof Map ? treeHash(value) : value.blob,
    }));
    entries.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.name + (a.mode === '40000' ? '/' : '')),
        Buffer.from(b.name + (b.mode === '40000' ? '/' : '')),
      ),
    );
    return gitHash(
      'tree',
      Buffer.concat(
        entries.flatMap((entry) => [
          Buffer.from(`${entry.mode} ${entry.name}\0`),
          Buffer.from(entry.sha, 'hex'),
        ]),
      ),
    );
  };
  if (treeHash(tree) !== provenance.treeSha) fail('source manifest tree differs');
  let count = 0;
  let total = 0;
  const visit = (relative) => {
    const directory = join(source, relative);
    safeParents(join(directory, 'sentinel'));
    const names = readdirSync(directory);
    if (names.length > 32768) fail('source directory budget');
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const item = lstatSync(join(source, path));
      if (item.isDirectory() && !item.isSymbolicLink()) visit(path);
      else {
        const entry = files.get(path);
        if (!entry) fail('uncommitted archive source file');
        const bytes = boundedFile(join(source, path), { maximum: 16777216 });
        total += bytes.length;
        if (
          ++count > 32768 ||
          total > 536870912 ||
          gitHash('blob', bytes) !== entry.blob ||
          ((item.mode & 0o111) !== 0) !== (entry.mode === '100755')
        )
          fail('archive source bytes/mode differ');
      }
    }
  };
  visit('');
  if (count !== files.size) fail('archive source file missing');
  return {
    sourceSha: targetSha,
    archiveSha256: provenance.archiveSha256,
    provenanceSha256: digest(boundedFile(`${source}.provenance.json`, { maximum: 16777216 })),
  };
}
export function verify({ owner, phase, source, targetSha, components = [] }) {
  requireLock();
  installed();
  if (
    !['before-build', 'after-image-validation', 'before-quiesce'].includes(phase) ||
    !SHA.test(targetSha)
  )
    fail('invalid verification phase/target');
  checkSource(source, owner);
  const expected = expectationFromEnvironment();
  if (!expected) return { status: 'standalone', protocol: PROTOCOL };
  if (
    expected.step.product !== owner ||
    expected.step.targetSha !== targetSha ||
    canonical(expected.step.components) !== canonical(sorted(components, COMPONENTS))
  )
    fail('selected candidate/components differ');
  if (owner === 'market') {
    if (resolve(source) !== join(MARKET, 'releases', targetSha)) fail('Market source root differs');
    const archive = verifyMarketArchive(targetSha);
    if (
      archive.archiveSha256 !== expected.step.archiveSha256 ||
      archive.provenanceSha256 !== expected.step.provenanceSha256
    )
      fail('Market archive/provenance differs');
  } else {
    if (
      resolve(source) !== MAJOR ||
      execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { timeout: 3000, maxBuffer: 1024 })
        .toString()
        .trim() !== targetSha
    )
      fail('Major selected checkout differs');
  }
  if (
    snapshot(expected.profiles, { allowTransition: phase !== 'before-build' }).stateSha256 !==
    expected.stateSha256
  )
    fail('running state/configuration/floors changed');
  return { status: 'verified', protocol: PROTOCOL, owner, phase, targetSha };
}
const OBSERVE_SHELL = String.raw`set -euo pipefail
lock=/var/lib/maxim-deploy/deploy.lock
for path in /var /var/lib /var/lib/maxim-deploy; do
  [[ -d "$path" && ! -L "$path" ]] || exit 70
  read -r owner mode <<<"$(stat -c '%u %a' "$path")"
  [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 && (owner == 0 || owner == EUID) )) || exit 70
done
[[ -f "$lock" && ! -L "$lock" ]] || exit 70
[[ "$(stat -c '%a:%h' "$lock")" == 600:1 && "$(stat -c '%u' "$lock")" == "$(stat -c '%u' /var/lib/maxim-deploy)" ]] || exit 70
# FLAG: Read-only open cannot create or replace a missing persistent lock inode.
exec 9<"$lock"
flock -n 9 || exit 75
export MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID" MAXIM_DEPLOY_LOCK_FD=9
export MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' "$lock")"
"$1" --input-type=module -e 'const guard=await import(process.argv[2]);const result=guard.observeHeld({owner:process.argv[3],expectedSha:process.argv[4],components:process.argv[5]?process.argv[5].split(","):[],profiles:process.argv[6]?process.argv[6].split(","):[]});process.stdout.write(JSON.stringify(result)+"\n")' observe-held "$2" "$3" "$4" "$5" "$6"
observation_status=$?
exit "$observation_status"
`;
export function observeHeld({ owner, expectedSha, components, profiles }) {
  requireLock();
  installed();
  if (!['major', 'market'].includes(owner) || !SHA.test(expectedSha))
    fail('invalid observation owner/target');
  sorted(components, COMPONENTS);
  sorted(profiles, PROFILES);
  if (owner === 'market' && components.length)
    fail('Market observation cannot select Major components');
  const before = snapshot(profiles);
  const acceptance = main(
    owner === 'major'
      ? ['readback', '--expected-sha', expectedSha, '--components', components.join(',')]
      : ['market-readback', '--expected-sha', expectedSha],
  );
  if (
    acceptance?.schemaVersion !== 1 ||
    acceptance.protocol !== 'major-market-owner-readback-v1' ||
    acceptance.product !== owner ||
    acceptance.status !== 'passed' ||
    (owner === 'major' ? acceptance.controllerSha : acceptance.state?.sourceSha) !== expectedSha
  )
    fail('owner acceptance differs from locked observation');
  const after = snapshot(profiles);
  requireLock();
  if (before.stateSha256 !== after.stateSha256)
    fail('release state changed during locked observation');
  if (
    owner === 'market'
      ? after.state.market.sourceSha !== expectedSha
      : components.some(
          (id) =>
            after.state.major.components.find((component) => component.id === id)?.sourceSha !==
            expectedSha,
        )
  )
    fail('locked snapshot differs from the accepted target');
  return {
    snapshot: after,
    acceptance,
    lock: { status: 'held-during-observation', identity: process.env.MAXIM_DEPLOY_LOCK_IDENTITY },
  };
}
export function observeRelease(flags) {
  installed();
  if (
    [
      'MAXIM_DEPLOY_LOCK_VERSION',
      'MAXIM_DEPLOY_LOCK_OWNER_PID',
      'MAXIM_DEPLOY_LOCK_FD',
      'MAXIM_DEPLOY_LOCK_IDENTITY',
    ].some((key) => process.env[key])
  )
    fail('observation requires a fresh host lock acquisition');
  const owner = flags['--owner'];
  const expected = flags['--expected-sha'];
  const components = flags['--components'] ? flags['--components'].split(',') : [];
  const profiles = parseProfiles(flags['--profiles']);
  if (!['major', 'market'].includes(owner) || !SHA.test(expected))
    fail('invalid observation owner/target');
  sorted(components, COMPONENTS);
  if (owner === 'market' && components.length)
    fail('Market observation cannot select Major components');
  try {
    // FLAG: GNU timeout fences the whole observation process group. No pair lock
    // is acquired, no lock inode is created, and a busy original wrapper refuses.
    return JSON.parse(
      execFileSync(
        'timeout',
        [
          '--kill-after=5s',
          '350s',
          'bash',
          '-c',
          OBSERVE_SHELL,
          'observe-release',
          process.execPath,
          join(TRUST, 'guard.mjs'),
          owner,
          expected,
          components.join(','),
          profiles.join(','),
        ],
        { timeout: 360000, maxBuffer: 1048576, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString(),
    );
  } catch (error) {
    if (error.status === 75) fail('host lock is busy; original operation outcome remains unknown');
    fail('bounded locked observation failed; outcome remains unproved', error);
  }
}
function options(args) {
  const value = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !/^--[a-z-]+$/u.test(args[i] ?? '') ||
      args[i + 1] === undefined ||
      Object.hasOwn(value, args[i])
    )
      fail('invalid CLI options');
    value[args[i]] = args[i + 1];
  }
  return value;
}
export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const flags = options(rest);
  const allowed = {
    state: ['--profiles'],
    verify: ['--owner', '--phase', '--source', '--target-sha', '--components'],
    'check-source': ['--owner', '--source', '--ref'],
    'check-market-archive': ['--target-sha'],
    admit: ['--owner', '--source'],
    'verify-install': [],
    readback: ['--expected-sha', '--components'],
    'market-readback': ['--expected-sha'],
    'observe-release': ['--owner', '--expected-sha', '--components', '--profiles'],
  }[command];
  if (!allowed || Object.keys(flags).some((key) => !allowed.includes(key)))
    fail('unknown CLI command/option');
  if (command === 'state') return snapshot(parseProfiles(flags['--profiles']));
  if (command === 'observe-release') return observeRelease(flags);
  if (command === 'verify-install') return { protocol: PROTOCOL, ...installed() };
  if (command === 'market-readback') {
    installed();
    if (!SHA.test(flags['--expected-sha'])) fail('full Market readback source required');
    return JSON.parse(
      execFileSync(
        'node',
        [
          join(TRUST, 'market-owner/infra/scripts/release-readback.mjs'),
          '--json',
          '--expected-sha',
          flags['--expected-sha'],
          '--public',
        ],
        { timeout: 330000, maxBuffer: 1048576, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString(),
    );
  }
  if (command === 'readback') {
    installed();
    const expected = flags['--expected-sha'];
    if (!SHA.test(expected)) fail('full readback source required');
    const head = execFileSync('git', ['-C', MAJOR, 'rev-parse', 'HEAD'], {
      timeout: 3000,
      maxBuffer: 1024,
    })
      .toString()
      .trim();
    const dirty = execFileSync('git', ['-C', MAJOR, 'status', '--porcelain'], {
      timeout: 3000,
      maxBuffer: 1048576,
    }).toString();
    if (head !== expected || dirty) fail('readback requires clean exact Major controller');
    return JSON.parse(
      execFileSync(
        'node',
        [
          join(MAJOR, 'infra/scripts/major-market-release-readback.mjs'),
          expected,
          flags['--components'] ?? '',
        ],
        { timeout: 330000, maxBuffer: 1048576, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString(),
    );
  }
  if (command === 'check-market-archive') {
    requireLock();
    return verifyMarketArchive(flags['--target-sha']);
  }
  if (command === 'check-source') {
    const expected = expectationFromEnvironment();
    if (expected && expected.step.product !== flags['--owner'])
      fail('candidate owner differs from expectation');
    if (expected && flags['--ref']?.startsWith('origin/')) {
      const candidate = execFileSync(
        'git',
        ['-C', flags['--source'], 'rev-parse', '--verify', `${flags['--ref']}^{commit}`],
        { timeout: 3000, maxBuffer: 1024 },
      )
        .toString()
        .trim();
      if (candidate !== expected.step.targetSha) fail('origin candidate differs from expectation');
    }
    checkSource(flags['--source'], flags['--owner'], flags['--ref']);
    return { status: 'source-capable', protocol: PROTOCOL };
  }
  if (command === 'verify')
    return verify({
      owner: flags['--owner'],
      phase: flags['--phase'],
      source: flags['--source'],
      targetSha: flags['--target-sha'],
      components: flags['--components'] ? flags['--components'].split(',') : [],
    });
  requireLock();
  installed();
  checkSource(flags['--source'], flags['--owner']);
  const expected = expectationFromEnvironment();
  if (expected && snapshot(expected.profiles).stateSha256 !== expected.stateSha256)
    fail('running state changed before source/build');
  return { status: expected ? 'verified' : 'standalone', protocol: PROTOCOL };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
