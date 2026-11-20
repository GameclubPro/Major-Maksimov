#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectGitChanges } from './git-changes.mjs';

const limits = Object.freeze({
  paths: 100,
  guidanceBytes: 65536,
  sourceBytes: 1048576,
  links: 100,
  flags: 200,
});
const navigationWarning =
  'Navigation only: this is not complete context or evidence of correct behavior. Include caller paths manually. Existing code and tests do not establish intended behavior; read the relevant requirements and clarify conflicts.';

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function parseContextArgs(argv) {
  const options = { repo: process.cwd(), mode: 'worktree', paths: [], json: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--path', '--repo', '--worktree', '--staged', '--json', '--help', '-h'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (arg !== '--path' && seen.has(arg)) throw new Error(`Repeated argument: ${arg}`);
    seen.add(arg);
    if (arg === '--path' || arg === '--repo') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--path') options.paths.push(value);
      else options.repo = value;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.mode = arg.slice(2);
  }
  if (seen.has('--worktree') && seen.has('--staged'))
    throw new Error('--worktree and --staged are mutually exclusive.');
  if (options.paths.length && (seen.has('--worktree') || seen.has('--staged'))) {
    throw new Error('--path cannot be combined with --worktree or --staged.');
  }
  return options;
}

function within(root, target) {
  const suffix = relative(root, target);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function normalizePath(root, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    [...path].some((character) => character.codePointAt(0) < 32 || character === '\x7f') ||
    isAbsolute(path) ||
    /^[a-z]:[\\/]/iu.test(path) ||
    path.includes('\\')
  ) {
    throw new Error(
      'Paths must be repository-relative, without control characters or backslashes.',
    );
  }
  const target = resolve(root, path);
  if (!within(root, target) || relative(root, target).split(sep).includes('.git')) {
    throw new Error(`Path is outside repository content: ${path}`);
  }
  return relative(root, target).split(sep).join('/') || '.';
}

// FLAG: Never follow a symlink, including a parent of a not-yet-created file.
function inspectPath(root, path) {
  let cursor = root;
  let stat = lstatSync(root);
  for (const part of path === '.' ? [] : path.split('/')) {
    cursor = resolve(cursor, part);
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' };
      throw error;
    }
    if (stat.isSymbolicLink()) return { kind: 'symlink' };
  }
  return {
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special',
    bytes: stat.size,
  };
}

export function createTaskContext(options) {
  const root = realpathSync(git(options.repo, ['rev-parse', '--show-toplevel']).trim());
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
  const suppliedPaths = options.paths.length
    ? options.paths
    : collectGitChanges({ cwd: root, mode: options.mode }).changedPaths;
  const allPaths = [...new Set(suppliedPaths.map((path) => normalizePath(root, path)))].sort();
  const paths = allPaths.slice(0, limits.paths);
  const notices = [];
  const guidance = [];
  const links = [];
  const flags = [];
  const scopes = new Set(['.']);
  let omittedLinks = 0;
  let omittedFlags = 0;
  if (allPaths.length > paths.length)
    notices.push(
      `Path limit: ${allPaths.length - paths.length} paths omitted; select a smaller scope.`,
    );
  if (!paths.length) notices.push('No changed paths. Use --path for planned files before editing.');
  if (options.mode === 'staged' && !options.paths.length)
    notices.push(
      'Paths come from the index; guidance and FLAG locations use current worktree files, not staged contents.',
    );

  function readTracked(path, maxBytes) {
    const entry = inspectPath(root, path);
    if (entry.kind !== 'file') {
      notices.push(`${path}: content not scanned (${entry.kind}).`);
      return null;
    }
    if (/(?:^|\/)(?:\.env(?:[./-]|$)|\.git(?:\/|$))/iu.test(path) || !tracked.has(path)) {
      notices.push(`${path}: content not scanned (environment or untracked file).`);
      return null;
    }
    try {
      git(root, ['check-ignore', '--quiet', '--no-index', '--', path]);
      notices.push(`${path}: content not scanned (ignored file).`);
      return null;
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    if (entry.bytes > maxBytes) {
      notices.push(
        `${path}: content not scanned (${entry.bytes} bytes exceeds ${maxBytes}-byte limit).`,
      );
      return null;
    }
    const buffer = readFileSync(resolve(root, path));
    if (buffer.includes(0)) {
      notices.push(`${path}: content not scanned (binary file).`);
      return null;
    }
    return buffer.toString('utf8');
  }

  for (const path of paths) {
    const entry = inspectPath(root, path);
    if (entry.kind === 'symlink' || entry.kind === 'special') {
      notices.push(`${path}: skipped (${entry.kind}); no linked content is read.`);
      continue;
    }
    let scope = entry.kind === 'directory' ? path : dirname(path);
    while (scope !== '.') {
      scopes.add(scope);
      scope = dirname(scope);
    }
    if (entry.kind === 'directory') {
      notices.push(
        `${path}: directory selected; no recursion. Select concrete files for FLAG locations.`,
      );
      continue;
    }
    if (entry.kind === 'missing') {
      notices.push(`${path}: source missing (planned or deleted); ancestor guidance only.`);
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?|py|sh|bash|sql|css|scss|ya?ml|md)$/iu.test(path)) {
      notices.push(`${path}: FLAG scan skipped (unsupported source extension).`);
      continue;
    }
    const contents = readTracked(path, limits.sourceBytes);
    if (contents === null) continue;
    for (const [index, line] of contents.split('\n').entries()) {
      if (!line.includes('FLAG:')) continue;
      if (flags.length < limits.flags) flags.push({ path, line: index + 1 });
      else omittedFlags += 1;
    }
  }

  for (const scope of [...scopes].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'en'),
  )) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const path = scope === '.' ? name : `${scope}/${name}`;
      if (inspectPath(root, path).kind === 'missing') continue;
      const contents = readTracked(path, limits.guidanceBytes);
      if (contents !== null && !contents.trim()) continue;
      guidance.push({ path, readable: contents !== null });
      if (contents !== null) {
        let heading = null;
        let fence = null;
        for (const [index, line] of contents.split('\n').entries()) {
          const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
          if (marker) {
            if (!fence) fence = marker;
            else if (
              fence[0] === marker[0] &&
              marker.length >= fence.length &&
              !line.trim().slice(marker.length).trim()
            )
              fence = null;
            continue;
          }
          if (fence) continue;
          const title = line.match(/^#{1,6}\s+(.+?)\s*#*$/u)?.[1];
          if (title) heading = title;
          for (const match of line.matchAll(
            /\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"]*")?\)/gu,
          )) {
            const href = match[1].replace(/^<|>$/gu, '');
            if (/^[a-z][a-z\d+.-]*:|^\/\/|\?/iu.test(href)) continue;
            const [filename, ...fragment] = href.split('#');
            let target;
            try {
              const decoded = decodeURIComponent(filename);
              if (isAbsolute(decoded) || decoded.includes('\\')) throw new Error('absolute link');
              const relativeTarget = relative(root, resolve(root, dirname(path), decoded || name));
              target = normalizePath(root, relativeTarget.split(sep).join('/'));
            } catch {
              notices.push(
                `${path}:${index + 1}: local link omitted (outside repository or invalid path).`,
              );
              continue;
            }
            if (inspectPath(root, target).kind === 'symlink') {
              notices.push(`${path}:${index + 1}: local link omitted (symlink).`);
              continue;
            }
            const link = {
              from: path,
              line: index + 1,
              heading,
              target: `${target}${fragment.length ? `#${fragment.join('#')}` : ''}`,
            };
            if (links.length < limits.links) links.push(link);
            else omittedLinks += 1;
          }
        }
      }
      break;
    }
  }
  if (omittedLinks)
    notices.push(`Link limit: ${omittedLinks} links omitted; read the listed guidance files.`);
  if (omittedFlags)
    notices.push(`FLAG limit: ${omittedFlags} locations omitted; inspect selected files directly.`);
  return {
    schemaVersion: 1,
    checkout: { root, revision: git(root, ['rev-parse', 'HEAD']).trim() },
    source: options.paths.length ? 'paths' : options.mode,
    paths,
    guidance,
    links,
    flags,
    limits,
    omitted: { paths: allPaths.length - paths.length, links: omittedLinks, flags: omittedFlags },
    notices: [...new Set(notices)],
    warning: navigationWarning,
  };
}

export function renderTaskContext(context) {
  return [
    `Task context: ${context.checkout.root} @ ${context.checkout.revision}`,
    context.warning,
    'Local inline Markdown links are navigation only; linked documents are not loaded.',
    `Limits: ${JSON.stringify(context.limits)}`,
    '',
    'Selected paths:',
    ...context.paths.map((path) => `  ${path}`),
    '',
    'Applicable guidance (root to scope; override takes precedence):',
    ...context.guidance.map(({ path, readable }) => `  ${path}${readable ? '' : ' (not scanned)'}`),
    '',
    'Local reference links:',
    ...context.links.map(
      ({ from, line, heading, target }) =>
        `  ${from}:${line}${heading ? ` [${heading}]` : ''} -> ${target}`,
    ),
    '',
    'FLAG locations in selected source files:',
    ...context.flags.map(({ path, line }) => `  ${path}:${line}`),
    '',
    'Notices:',
    ...context.notices.map((notice) => `  ${notice}`),
    '',
  ].join('\n');
}

export function runContextCli(
  argv = process.argv.slice(2),
  io = { stdout: (value) => process.stdout.write(value) },
) {
  const options = parseContextArgs(argv);
  if (options.help) {
    io.stdout(
      'Usage: node scripts/agent/context.mjs [--path repo/file ... | --worktree | --staged] [--repo directory] [--json]\nRead-only navigation before editing; paths are repository-relative. Defaults to --worktree.\n',
    );
    return 0;
  }
  const context = createTaskContext(options);
  io.stdout(options.json ? `${JSON.stringify(context, null, 2)}\n` : renderTaskContext(context));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runContextCli();
  } catch (error) {
    process.stderr.write(`agent context failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
