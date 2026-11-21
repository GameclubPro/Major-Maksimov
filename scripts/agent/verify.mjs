#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectGitChanges } from './git-changes.mjs';
import { createImpactPlan, renderImpactPlanHuman } from './impact-plan.mjs';
import { DEFAULT_CONFIG_PATH, loadImpactConfig } from './impact-config.mjs';
import { parseImpactPlanArgs } from './plan.mjs';
import { assessPrismaSchemaImpact } from './prisma-impact.mjs';
import { runPreflight } from './preflight.mjs';
import { selectEarlyCommands } from './early-checks.mjs';
import { buildMigrationReadiness, renderMigrationReadiness } from './migration-readiness.mjs';
import { runVerificationCommand } from './verification-command.mjs';
import {
  assertStagedWorktreeMatches,
  assertStagedSnapshotUnchanged,
} from './verification-snapshot.mjs';

export function parseVerifyArgs(argv) {
  let full = false;
  let dryRun = false;
  const planArgs = [];

  for (const argument of argv) {
    if (argument === '--full') {
      full = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else {
      planArgs.push(argument);
    }
  }

  const planOptions = parseImpactPlanArgs(planArgs);
  if (full && (planOptions.mode !== 'worktree' || planOptions.base || planOptions.head)) {
    throw new Error('--full cannot be combined with staged or range selection.');
  }

  return { ...planOptions, full, dryRun };
}

export function selectVerificationScripts({ config, plan, full = false }) {
  let checkIds = full ? ['full'] : [...plan.checks];
  const scriptOverrides = new Map();
  if (checkIds.includes('full')) {
    // The root check script covers builds/tests, but not the browser smoke.
    checkIds = ['full', 'miniapp-visual-local'];
  } else {
    const covered = new Set();
    // FLAG: Core tooling covers local tooling edits. Infrastructure runs when its
    // boundary is selected; CI Static still validates the complete inventory.
    if (checkIds.includes('repo-static') && checkIds.includes('agent-tools')) {
      covered.add('agent-tools');
    } else if (checkIds.includes('agent-tools')) {
      scriptOverrides.set('agent-tools', 'test:agent-tools:core');
    }
    if (checkIds.includes('miniapp')) covered.add('miniapp-css');
    checkIds = checkIds.filter((id) => !covered.has(id));
  }

  return checkIds.map((id) => {
    const definition = config.checkById[id];
    if (!definition?.script) {
      throw new Error(`Impact check ${id} has no npm script mapping.`);
    }
    return Object.freeze({ id, script: scriptOverrides.get(id) ?? definition.script });
  });
}

export async function runVerifyCli(
  argv = process.argv.slice(2),
  io = defaultIo(),
  dependencies = {},
) {
  let json = requestsJson(argv);
  let stage = 'arguments';
  let activeCommand = null;
  const result = {
    schemaVersion: 1,
    repo: 'major',
    root: null,
    head: null,
    mode: null,
    dryRun: argv.includes('--dry-run'),
    status: 'failed',
    plan: null,
    commands: [],
    requiresSubmissionAggregate: true,
    requiresExactShaCi: true,
    snapshotTree: null,
    migrationReadiness: null,
    error: null,
  };

  try {
    const options = parseVerifyArgs(argv);
    json = options.format === 'json';
    result.mode = options.full ? 'full' : options.mode;
    result.dryRun = options.dryRun;
    const log = json ? (value) => (io.stderr ?? defaultIo().stderr)(value) : io.stdout;
    stage = 'planning';
    const config = await loadImpactConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
    let plan = null;
    let changedPaths;

    if (!options.full) {
      const changeSet = collectGitChanges({
        cwd: options.repo,
        mode: options.mode,
        base: options.base,
        head: options.head,
        since: options.since,
      });
      result.root = changeSet.repoRoot;
      changedPaths = changeSet.changedPaths;
      plan = createImpactPlan({
        config,
        changeSet,
        prismaSchemaImpact: assessPrismaSchemaImpact(changeSet),
      });
      result.plan = plan;
      if (!json) io.stdout(renderImpactPlanHuman(plan, config));
    }
    result.root ??= gitText(options.repo, ['rev-parse', '--show-toplevel']);
    if (json) result.head = gitText(result.root, ['rev-parse', '--verify', 'HEAD']);
    changedPaths ??= collectGitChanges({ cwd: result.root }).changedPaths;
    result.migrationReadiness = buildMigrationReadiness(changedPaths);
    if (result.migrationReadiness) log(`${renderMigrationReadiness(result.migrationReadiness)}\n`);
    stage = 'migration';
    if (plan?.migration.reviewRequired) {
      throw new Error('Verification stopped: a Prisma migration review is required.');
    }

    stage = 'commands';
    const scripts = selectVerificationScripts({ config, plan, full: options.full });
    const cwd = result.root;
    const earlyCommands = await selectEarlyCommands(cwd, changedPaths);
    const aggregateCommands = scripts.map(({ id, script }) => ({
      id,
      kind: 'npm-script',
      executable: 'npm',
      args: ['run', script],
      cwd: resolve(cwd),
      resources: ['checkout'],
      status: options.dryRun ? 'planned' : 'not-run',
      exitCode: null,
      signal: null,
    }));
    if (options.dryRun) earlyCommands.forEach((command) => (command.status = 'planned'));
    result.commands = [...earlyCommands, ...aggregateCommands];
    await assertScriptsExist(cwd, scripts);
    if (!json) {
      io.stdout(
        `Verification commands:\n${result.commands
          .map(({ executable, args }) => `  ${executable} ${args.join(' ')}`)
          .join('\n')}\n`,
      );
    }

    if (options.dryRun) {
      result.status = 'planned';
    } else {
      stage = 'snapshot';
      const stagedTree = options.mode === 'staged' ? assertStagedWorktreeMatches(cwd) : null;
      result.snapshotTree = stagedTree;
      stage = 'preflight';
      (dependencies.runPreflight ?? runPreflight)(cwd, (line) => log(`${line}\n`));
      stage = 'snapshot-after-preflight';
      if (stagedTree) assertStagedSnapshotUnchanged(cwd, stagedTree);
      for (const command of result.commands) {
        activeCommand = command;
        stage = 'command';
        log(`\n[agent:verify] ${command.id}\n`);
        await runVerificationCommand(activeCommand, json ? log : null);
        activeCommand.status = 'passed';
        activeCommand.exitCode = 0;
        stage = 'snapshot-after-command';
        if (stagedTree) assertStagedSnapshotUnchanged(cwd, stagedTree);
        activeCommand = null;
      }
      result.status = 'passed';
    }
    if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (!json) throw error;
    if (activeCommand && stage === 'command') {
      activeCommand.status = 'failed';
      activeCommand.exitCode = error.exitCode ?? null;
      activeCommand.signal = error.signal ?? null;
    }
    result.error = {
      stage,
      code:
        stage === 'migration'
          ? 'MIGRATION_REVIEW_REQUIRED'
          : `${stage.replaceAll('-', '_').toUpperCase()}_FAILED`,
      message: error.message,
      commandId: activeCommand?.id ?? null,
    };
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 2;
  }
}

async function assertScriptsExist(repo, scripts) {
  const packageJson = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
  for (const { script } of scripts) {
    if (typeof packageJson.scripts?.[script] !== 'string') {
      throw new Error(`package.json is missing the mapped npm script ${script}.`);
    }
  }
}

function defaultIo() {
  return {
    stdout(value) {
      process.stdout.write(value);
    },
    stderr(value) {
      process.stderr.write(value);
    },
  };
}

export function requestsJson(argv) {
  let json = false;
  for (const [index, argument] of argv.entries()) {
    if (argument === '--json') json = true;
    if (argument === '--format') json = argv[index + 1] === 'json';
  }
  return json;
}

function gitText(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runVerifyCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`agent verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
