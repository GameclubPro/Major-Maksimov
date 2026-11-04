import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/u;
const MAX_SOURCE_BYTES = 262144;
const MARKER = '/etc/maxim-release/installed';
const HELPER = '/usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs';
const ROOT_DIRECTORIES = Object.freeze([
  '/etc',
  '/etc/maxim-release',
  '/usr',
  '/usr/local',
  '/usr/local/lib',
  '/usr/local/lib/maxim-release',
  '/usr/local/lib/maxim-release/infra',
  '/usr/local/lib/maxim-release/infra/scripts',
]);
const PATHS = Object.freeze([
  'infra/scripts/lib/deploy-lock.sh',
  'infra/scripts/vps-release-rollback.sh',
  'infra/scripts/vps-runtime-rollback.sh',
  'infra/scripts/vps-connect.sh',
]);
const DISPATCH_END =
  '"$release_source_floor_node" /usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs "$release_source_floor_sha" || return 1\n  fi\n';
const PAUSE_END =
  '"$release_policy_node" /usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs pause-rollback >/dev/null || exit $?\nfi\n';

function refuse(code) {
  const error = new Error(`Release source floor ${code}.`);
  error.code = code;
  throw error;
}

function missing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function protectedFile(path, { expectedUid, maxBytes }) {
  const observed = lstatSync(path);
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.uid !== expectedUid ||
    observed.nlink !== 1 ||
    observed.mode & 0o022 ||
    observed.size < 1 ||
    observed.size > maxBytes
  )
    refuse('UNSAFE_FILE');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino ||
      opened.size !== observed.size ||
      opened.nlink !== 1 ||
      opened.uid !== expectedUid ||
      opened.mode & 0o022
    )
      refuse('FILE_CHANGED');
    const data = Buffer.alloc(observed.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const bytes = readSync(descriptor, data, offset, data.length - offset, null);
      if (bytes === 0) break;
      offset += bytes;
    }
    if (offset !== observed.size) refuse('FILE_CHANGED');
    return data.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function git(cwd, arguments_, { allowNotAncestor = false, maxBytes = MAX_SOURCE_BYTES + 1 } = {}) {
  const result = spawnSync(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.useReplaceRefs=false',
      ...arguments_,
    ],
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        LANG: 'C.UTF-8',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 10000,
      maxBuffer: maxBytes,
    },
  );
  if (allowNotAncestor && result.status === 1 && !result.error) return null;
  if (result.status !== 0 || result.error || result.signal) refuse('GIT_READ_FAILED');
  return result.stdout;
}

function sourceBlob(cwd, sha, path) {
  const tree = git(cwd, ['ls-tree', '-z', sha, '--', path], { maxBytes: 4096 }).toString('utf8');
  const entries = tree.split('\0');
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entries[0]);
  if (entries.length !== 2 || entries[1] !== '' || !match || match[3] !== path)
    refuse('UNSAFE_SOURCE_BLOB');
  const size = git(cwd, ['cat-file', '-s', match[2]], { maxBytes: 32 }).toString('ascii').trim();
  if (!/^[1-9][0-9]{0,6}$/u.test(size) || Number(size) > MAX_SOURCE_BYTES)
    refuse('SOURCE_TOO_LARGE');
  const content = git(cwd, ['cat-file', 'blob', match[2]]);
  if (content.length !== Number(size) || content.includes(0)) refuse('INVALID_SOURCE_BYTES');
  const text = content.toString('utf8');
  if (!Buffer.from(text).equals(content) || !text.startsWith('#!/usr/bin/env bash\n'))
    refuse('INVALID_SOURCE_BYTES');
  return text;
}

function prefix(source, path) {
  const end = path === PATHS[0] ? DISPATCH_END : PAUSE_END;
  const index = source.indexOf(end);
  if (index < 0 || source.indexOf(end, index + end.length) !== -1) refuse('HOOK_MISSING');
  const protectedPrefix = source.slice(0, index + end.length);
  if (path === PATHS[0]) {
    for (const name of ['maxim_pair_release_required', 'require_pair_release_admission_dispatch']) {
      const definitions = [
        ...source.matchAll(new RegExp(`^\\s*(?:function\\s+)?${name}\\s*\\(\\s*\\)`, 'gmu')),
      ];
      if (definitions.length !== 1) refuse('AMBIGUOUS_DISPATCH');
    }
    if (
      !protectedPrefix.includes(
        'require_pair_release_admission_dispatch() {\n  maxim_pair_release_required || return 0\n',
      )
    )
      refuse('HOOK_MISSING');
  } else {
    if (
      !protectedPrefix.includes(
        'acquire_deploy_lock\n\n# FLAG: An installed durable release service must remain paused after an operator rollback.\n',
      )
    )
      refuse('HOOK_MISSING');
    if (
      path === 'infra/scripts/vps-connect.sh' &&
      !protectedPrefix.includes("rollback_entrypoint_bootstrap_source() {\n  cat <<'BOOTSTRAP'\n")
    )
      refuse('HOOK_MISSING');
  }
  return protectedPrefix;
}

// FLAG: Protect the deploy-lock prefix through source admission and the three rollback prefixes
// through the durable pause. Later commands may evolve; changing a protected prefix needs a
// reviewed installer upgrade. This is a tooling downgrade floor for trusted CI candidates,
// not a sandbox for arbitrary shell programs or an image-source compatibility restriction.
export function assertReleaseSourceFloor({
  candidateSha,
  cwd = process.cwd(),
  markerPath = MARKER,
  helperPath = HELPER,
  trustedDirectories = ROOT_DIRECTORIES,
  expectedUid = 0,
  repositoryRoot = '/var/www/Chat_bot',
} = {}) {
  // FLAG: A genuinely absent service marker preserves the pre-installation dispatch behavior.
  if (missing(markerPath)) return { installed: false };
  if (
    typeof candidateSha !== 'string' ||
    !SHA.test(candidateSha) ||
    !Number.isSafeInteger(expectedUid) ||
    expectedUid < 0 ||
    !Array.isArray(trustedDirectories) ||
    trustedDirectories.length < 1
  )
    refuse('INVALID_ARGUMENTS');
  for (const directory of trustedDirectories) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedUid ||
      stat.mode & 0o022
    )
      refuse('UNSAFE_DIRECTORY');
  }
  protectedFile(helperPath, { expectedUid, maxBytes: MAX_SOURCE_BYTES });
  const marker = protectedFile(markerPath, { expectedUid, maxBytes: 41 });
  if (!/^[a-f0-9]{40}\n$/u.test(marker.toString('utf8'))) refuse('INVALID_MARKER');
  const installedSha = marker.subarray(0, 40).toString('utf8');
  const repository = realpathSync(cwd);
  const root = realpathSync(repositoryRoot);
  if (repository !== root && !repository.startsWith(`${root}/.release-executors/`))
    refuse('UNSAFE_REPOSITORY');
  if (
    git(repository, ['rev-parse', '--show-toplevel'], { maxBytes: 4096 })
      .toString('utf8')
      .trim() !== repository
  )
    refuse('UNSAFE_REPOSITORY');
  const grafts = git(repository, ['rev-parse', '--git-path', 'info/grafts'], { maxBytes: 4096 })
    .toString('utf8')
    .trim();
  if (!missing(resolve(repository, grafts))) refuse('GRAFTED_HISTORY');
  for (const sha of [installedSha, candidateSha]) {
    if (
      git(repository, ['cat-file', '-t', sha], { maxBytes: 32 }).toString('ascii').trim() !==
      'commit'
    )
      refuse('INVALID_COMMIT');
  }
  if (
    git(repository, ['merge-base', '--is-ancestor', installedSha, candidateSha], {
      allowNotAncestor: true,
    }) === null
  )
    refuse('SOURCE_DOWNGRADE');
  for (const path of PATHS) {
    const installed = prefix(sourceBlob(repository, installedSha, path), path);
    const candidate = prefix(sourceBlob(repository, candidateSha, path), path);
    // FLAG: Exact protected prefixes make the admission/pause ordering survive every accepted checkout.
    // Updating these prefixes needs a separately reviewed installed floor upgrade.
    if (installed !== candidate) refuse('PROTECTED_PREFIX_CHANGED');
  }
  return { installed: true, installedSha, candidateSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) refuse('INVALID_ARGUMENTS');
    assertReleaseSourceFloor({ candidateSha: process.argv[2] });
  } catch (error) {
    process.stderr.write(`Release source admission refused: ${error.code ?? 'UNPROVED_FLOOR'}.\n`);
    process.exitCode = 1;
  }
}
