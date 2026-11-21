#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { requestsJson } from './verify.mjs';
import { runVerificationCommand } from './verification-command.mjs';

export function parseFocusedArgs(argv) {
  const options = {
    repo: process.cwd(),
    tests: [],
    dryRun: false,
    typecheck: false,
    format: 'human',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.format = 'json';
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--typecheck') options.typecheck = true;
    else if (['--test', '--repo', '--format'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--test') options.tests.push(value);
      else options[argument.slice(2)] = value;
    } else throw new Error(`Unknown focused argument: ${argument}.`);
  }
  if (!['human', 'json'].includes(options.format))
    throw new Error('--format must be human or json.');
  if (!options.tests.length)
    throw new Error('Select at least one existing test with --test <repo-relative-path>.');
  return options;
}

export async function selectFocusedCommands(root, tests, { typecheck = false } = {}) {
  const groups = new Map();
  const nativeRequirements = new Map();
  const canonicalRoot = await realpath(root);
  for (const path of [...new Set(tests)]) {
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || ['.', '..'].includes(part))
    ) {
      throw new Error(`Test path must be repository-relative without traversal: ${path}.`);
    }
    const target = await realpath(resolve(canonicalRoot, path));
    const contained = relative(canonicalRoot, target);
    if (
      contained === '..' ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained) ||
      !(await stat(target)).isFile()
    ) {
      throw new Error(`Test must be an existing file inside this repository: ${path}.`);
    }
    let family;
    if (
      /^(?:scripts\/[^/]+|scripts\/(?:agent\/test|ci)\/[^/]+|infra\/scripts\/[^/]+)\.test\.mjs$/u.test(
        path,
      )
    )
      family = 'node';
    else if (/^apps\/(miniapp|admin)\/test\/[^/]+\.test\.ts$/u.test(path))
      family = path.split('/')[1];
    else if (/^apps\/api\/(?:src|test)\/.+\.spec\.ts$/u.test(path)) family = 'api';
    else if (/^packages\/contracts\/test\/[^/]+\.(?:spec|test)\.ts$/u.test(path))
      family = 'contracts';
    else
      throw new Error(
        `Unsupported focused test family: ${path}. Select a supported test or use its documented public runner.`,
      );
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(path);
    const native = nativeEnvironmentReads(await readFile(target, 'utf8'));
    if (family === 'api') {
      const manifest = JSON.parse(await readFile(resolve(root, 'apps/api/package.json'), 'utf8'));
      const lane =
        manifest.scripts?.['test:postgres-races:unlocked']
          ?.split('--runTestsByPath ')[1]
          ?.trim()
          .split(/\s+/u) ?? [];
      if (lane.includes(path.slice('apps/api/'.length)))
        native.add('CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL');
    }
    if (!nativeRequirements.has(family)) nativeRequirements.set(family, new Set());
    for (const name of native) nativeRequirements.get(family).add(name);
  }
  const commands = [];
  if (typecheck) {
    if (!groups.has('api')) throw new Error('--typecheck requires a focused API test.');
    const manifest = JSON.parse(await readFile(resolve(canonicalRoot, 'package.json'), 'utf8'));
    if (manifest.scripts?.['typecheck:api'] !== 'npm run typecheck --workspace @maxim/api')
      throw new Error('The public API typecheck runner changed.');
    commands.push({
      id: 'api-typecheck',
      kind: 'npm-script',
      executable: 'npm',
      args: ['run', 'typecheck:api'],
      cwd: canonicalRoot,
      resources: ['checkout'],
      requiredEnvironment: [],
      status: 'not-run',
      exitCode: null,
      signal: null,
    });
  }
  for (const [family, paths] of groups) {
    let executable = 'npm';
    let args;
    if (family === 'node') {
      executable = process.execPath;
      args = ['--test', '--test-concurrency=2', ...paths];
    } else if (family === 'api') {
      const manifest = JSON.parse(await readFile(resolve(root, 'apps/api/package.json'), 'utf8'));
      if (typeof manifest.scripts?.test !== 'string')
        throw new Error('The API public test runner is missing.');
      // FLAG: Three npm layers must forward Jest arguments through the public codegen/lock owner.
      args = [
        'run',
        'test',
        '--workspace',
        '@maxim/api',
        '--',
        '--',
        '--',
        '--runTestsByPath',
        ...paths.map((path) => path.slice('apps/api/'.length)),
      ];
    } else if (family === 'contracts') {
      const manifest = JSON.parse(
        await readFile(resolve(root, 'packages/contracts/package.json'), 'utf8'),
      );
      if (manifest.scripts?.test !== 'npm run build && npm run test:source') {
        throw new Error(
          'The contracts test runner changed; review its focused adapter before executing.',
        );
      }
      args = [
        'run',
        'test',
        '--workspace',
        '@maxim/contracts',
        '--',
        '--',
        ...paths.map((path) => path.slice('packages/contracts/'.length)),
      ];
    } else {
      const manifest = JSON.parse(
        await readFile(resolve(root, `apps/${family}/package.json`), 'utf8'),
      );
      if (manifest.scripts?.test !== 'tsx --test ./test/*.test.ts') {
        throw new Error(
          `The ${family} test runner changed; review its focused adapter before executing.`,
        );
      }
      args = [
        'exec',
        '--offline',
        '--no',
        '--workspace',
        `@maxim/${family}`,
        '--',
        'tsx',
        '--test',
        ...paths.map((path) => path.slice(`apps/${family}/`.length)),
      ];
    }
    commands.push({
      id: `${family}-tests`,
      kind: family === 'node' ? 'node-tests' : 'workspace-tests',
      executable,
      args,
      cwd: canonicalRoot,
      resources: [
        'checkout',
        ...(nativeRequirements.get(family).size ? ['postgres', 'redis'] : []),
      ],
      requiredEnvironment: [...nativeRequirements.get(family)].sort(),
      status: 'not-run',
      exitCode: null,
      signal: null,
    });
  }
  return commands;
}

export async function runFocusedCli(argv = process.argv.slice(2), io = defaultIo()) {
  let json = requestsJson(argv);
  let stage = 'arguments';
  let activeCommand = null;
  const result = {
    schemaVersion: 1,
    repo: 'major',
    root: null,
    head: null,
    mode: 'focused',
    dryRun: argv.includes('--dry-run'),
    status: 'failed',
    plan: null,
    tests: [],
    commands: [],
    requiresSubmissionAggregate: true,
    requiresExactShaCi: true,
    snapshotTree: null,
    requiresTestStores: false,
    error: null,
  };
  try {
    const options = parseFocusedArgs(argv);
    json = options.format === 'json';
    result.dryRun = options.dryRun;
    result.tests = [...new Set(options.tests)];
    stage = 'planning';
    result.root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: options.repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    result.head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: result.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    result.commands = await selectFocusedCommands(result.root, options.tests, options);
    result.requiresTestStores = result.commands.some(({ resources }) =>
      resources.includes('postgres'),
    );
    const log = json ? (value) => io.stderr(value) : (value) => io.stdout(value);
    if (options.dryRun) {
      result.commands.forEach((command) => {
        command.status = 'planned';
      });
      result.status = 'planned';
    } else {
      if (result.requiresTestStores) {
        stage = 'native-environment';
        assertNativeAliases(result.commands);
        await runVerificationCommand(
          {
            executable: process.execPath,
            args: ['scripts/require-postgres-race-env.mjs'],
            cwd: result.root,
          },
          log,
        );
      }
      stage = 'command';
      for (const command of result.commands) {
        activeCommand = command;
        log(`[agent:focused] ${command.id}\n`);
        await runVerificationCommand(command, json ? log : null);
        command.status = 'passed';
        command.exitCode = 0;
        activeCommand = null;
      }
      result.status = 'passed';
    }
    if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else if (options.dryRun)
      io.stdout(
        `${result.commands.map(({ executable, args }) => JSON.stringify([executable, ...args])).join('\n')}\n`,
      );
    return 0;
  } catch (error) {
    if (!json) throw error;
    if (activeCommand) {
      activeCommand.status = 'failed';
      activeCommand.exitCode = error.exitCode ?? null;
      activeCommand.signal = error.signal ?? null;
    }
    result.error = {
      stage,
      code: `${stage.replaceAll('-', '_').toUpperCase()}_FAILED`,
      message: error.message,
      commandId: activeCommand?.id ?? null,
    };
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 2;
  }
}

function nativeEnvironmentReads(source) {
  const names = new Set([
    'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL',
    'MAXIM_TEST_POSTGRES_URL',
    'MAXIM_TEST_REDIS_URL',
    'DATABASE_URL',
    'REDIS_URL',
  ]);
  const found = new Set();
  const file = ts.createSourceFile('selected-test.ts', source, ts.ScriptTarget.Latest, true);
  const isProcessEnvironment = (node) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env';
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessEnvironment(node.expression) &&
      names.has(node.name.text)
    )
      found.add(node.name.text);
    if (
      ts.isElementAccessExpression(node) &&
      isProcessEnvironment(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      names.has(node.argumentExpression.text)
    )
      found.add(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function assertNativeAliases(commands) {
  const required = new Set(commands.flatMap(({ requiredEnvironment }) => requiredEnvironment));
  for (const name of required) {
    const canonical = name.includes('REDIS')
      ? 'MAXIM_TEST_REDIS_URL'
      : 'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL';
    if (!process.env[name] || process.env[name] !== process.env[canonical]) {
      throw new Error(
        `Native test environment requires ${name} to match ${canonical}; use the public with-test-stores runner.`,
      );
    }
  }
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFocusedCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`focused verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
