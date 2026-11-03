import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  findDocumentationLinkViolations,
  readDocumentation,
} from './check-documentation-links.mjs';

const shellFencePattern = /```(?:bash|sh|shell)[\t ]*\r?\n([\s\S]*?)```/gu;
const bannedExecutablePattern =
  /(?:app2\.major-maksimov\.ru|s3:\/\/|\byc\s+storage\b|object[ -]?storage|cdn-cache)/iu;
const composeServiceCommands = new Set(['exec', 'run', 'logs', 'restart']);

// Project budgets, not a claim about a particular agent's configured context limit.
const rootGuidanceBudget = 8 * 1024;
const scopedGuidanceBudget = 16 * 1024;
const guidanceChainBudget = 24 * 1024;

export function findAgentGuidanceViolations(root, documents = readDocumentation(root).documents) {
  const entries = [...documents]
    .filter(([path]) => /(?:^|\/)AGENTS(?:\.override)?\.md$/u.test(path))
    .map(([path, contents]) => ({
      path,
      directory: dirname(path),
      bytes: Buffer.byteLength(contents),
    }));
  const violations = [];
  for (const entry of entries) {
    const budget = entry.directory === '.' ? rootGuidanceBudget : scopedGuidanceBudget;
    if (entry.bytes > budget) {
      violations.push(
        `${entry.path} exceeds the ${budget}-byte agent entry budget (${entry.bytes} bytes). Move task-specific detail to linked references; preserve safety invariants.`,
      );
    }
    const chainBytes = entries
      .filter(
        (ancestor) =>
          ancestor.directory === '.' ||
          ancestor.directory === entry.directory ||
          entry.directory.startsWith(`${ancestor.directory}/`),
      )
      .reduce((total, ancestor) => total + ancestor.bytes, 0);
    if (chainBytes > guidanceChainBudget) {
      violations.push(
        `${entry.path} has ${chainBytes} bytes of ancestor guidance; the project budget is ${guidanceChainBudget} bytes. Keep entry files short and route detailed constraints by task.`,
      );
    }
  }
  return [...new Set(violations)].sort();
}

function isCommandWhitespace(character) {
  const code = character?.charCodeAt(0) ?? -1;
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function tokenizeCommandLine(line) {
  const tokens = [];
  let index = 0;

  while (index < line.length) {
    while (index < line.length && isCommandWhitespace(line[index])) {
      index += 1;
    }
    if (index >= line.length) {
      break;
    }

    const start = index;
    while (index < line.length && !isCommandWhitespace(line[index])) {
      index += 1;
    }
    tokens.push(line.slice(start, index));
  }

  return tokens;
}

function isAsciiLetterOrDigit(character) {
  const code = character?.charCodeAt(0) ?? -1;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function readComposeServiceName(token) {
  if (!isAsciiLetterOrDigit(token[0])) {
    return null;
  }

  let end = 1;
  while (end < token.length && (isAsciiLetterOrDigit(token[end]) || token[end] === '-')) {
    end += 1;
  }
  return token.slice(0, end);
}

function findComposeServiceReferences(contents) {
  const references = [];
  const lines = contents.split('\n');

  for (const [lineIndex, line] of lines.entries()) {
    const tokens = tokenizeCommandLine(line);
    let index = 0;
    while (index + 1 < tokens.length) {
      if (
        tokens[index]?.toLowerCase() !== 'docker' ||
        tokens[index + 1]?.toLowerCase() !== 'compose'
      ) {
        index += 1;
        continue;
      }

      index += 2;
      while (
        index < tokens.length &&
        !composeServiceCommands.has(tokens[index]?.toLowerCase() ?? '')
      ) {
        index += 1;
      }
      if (index >= tokens.length) {
        break;
      }

      index += 1;
      while (
        index < tokens.length &&
        (tokens[index]?.length ?? 0) > 1 &&
        tokens[index]?.startsWith('-')
      ) {
        index += 1;
      }

      const service = readComposeServiceName(tokens[index] ?? '');
      if (service) {
        references.push({ line: lineIndex + 1, service });
      }
      index += 1;
    }
  }

  return references;
}

export async function findDocumentationViolations(root) {
  const { documents, violations } = readDocumentation(root);
  violations.push(...findAgentGuidanceViolations(root, documents));
  violations.push(...(await findDocumentationLinkViolations(root, documents)));
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const workspacePackages = new Map();

  for (const workspaceRoot of ['apps', 'packages']) {
    const directory = resolve(root, workspaceRoot);
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of readdirSync(directory)) {
      const workspacePackagePath = resolve(directory, entry, 'package.json');
      if (!existsSync(workspacePackagePath)) {
        continue;
      }
      const workspacePackage = JSON.parse(readFileSync(workspacePackagePath, 'utf8'));
      workspacePackages.set(workspacePackage.name, workspacePackage);
    }
  }

  for (const [repoPath, contents] of documents) {
    for (const match of contents.matchAll(shellFencePattern)) {
      const block = match[1];
      const startLine = contents.slice(0, match.index).split('\n').length + 1;
      for (const [offset, line] of block.split('\n').entries()) {
        const command = line.trim();
        if (!command || command.startsWith('#')) continue;
        const location = `${repoPath}:${startLine + offset}`;
        if (bannedExecutablePattern.test(command)) {
          violations.push(`${location} contains a dormant CDN/Object Storage command.`);
        }
        if (/(?:^|\s)docker-compose(?:\s|$)/u.test(command)) {
          violations.push(`${location} uses docker-compose; use docker compose.`);
        }
        if (/<[a-z][^>]*>/iu.test(command)) {
          violations.push(`${location} contains a non-executable angle-bracket placeholder.`);
        }

        for (const npmMatch of command.matchAll(/\bnpm\s+run\s+([a-z0-9:_-]+)/giu)) {
          const script = npmMatch[1];
          const workspaceMatch = command.match(/--workspace\s+([^\s'";]+)/u);
          if (workspaceMatch) {
            const workspace = workspacePackages.get(workspaceMatch[1]);
            if (!workspace) {
              violations.push(`${location} references unknown workspace ${workspaceMatch[1]}.`);
            } else if (typeof workspace.scripts?.[script] !== 'string') {
              violations.push(
                `${location} references missing ${workspaceMatch[1]} script ${script}.`,
              );
            }
          } else if (!scripts.has(script)) {
            violations.push(`${location} references missing root npm script ${script}.`);
          }
        }

        const executableMatch = command.match(/(?:^|\s)(\.\/[a-zA-Z0-9_./-]+)/u);
        if (executableMatch && !existsSync(resolve(root, executableMatch[1]))) {
          violations.push(`${location} references missing executable ${executableMatch[1]}.`);
        }
      }
    }
  }

  const composeServices = new Set(
    execFileSync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'config', '--services'], {
      cwd: root,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  for (const [repoPath, contents] of documents) {
    for (const reference of findComposeServiceReferences(contents)) {
      if (!composeServices.has(reference.service)) {
        violations.push(
          `${repoPath}:${reference.line} references unknown Compose service ${reference.service}.`,
        );
      }
    }
  }

  return [...new Set(violations)].sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const violations = await findDocumentationViolations(root);
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
