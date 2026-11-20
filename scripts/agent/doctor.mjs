#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { resolveVerificationExecutable } from './verification-command.mjs';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'package.json'));
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const uiOnly = process.argv.includes('--ui');
const checks = [];
const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });
const version = (command, args = ['--version']) => {
  let resolved;
  try {
    resolved = resolveVerificationExecutable(command, args);
  } catch {
    return null;
  }
  const result = spawnSync(resolved.executable, resolved.args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 32_768,
  });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null;
};
add('Node 24', process.versions.node.split('.')[0] === '24', process.version);
const tools = ['npm', 'git', 'gh', 'rg'];
if (!uiOnly) tools.push('python3', 'shellcheck', 'jq');
for (const tool of tools) {
  const result = version(tool);
  add(tool, Boolean(result), result?.split('\n')[0] ?? 'missing from PATH');
}
if (!uiOnly) {
  const postgres = version('postgres');
  const redis = version('redis-server');
  add(
    'PostgreSQL 16',
    /PostgreSQL\) 16\./u.test(postgres ?? ''),
    postgres ?? 'install native PostgreSQL 16',
  );
  add('Redis 7', /v=7\./u.test(redis ?? ''), redis ?? 'install native Redis 7');
  for (const tool of ['initdb', 'pg_isready', 'createdb', 'psql', 'redis-cli']) {
    const result = version(tool);
    add(tool, Boolean(result), result?.split('\n')[0] ?? 'missing from PATH');
  }
}
const dependencies = uiOnly
  ? ['typescript', 'playwright']
  : ['typescript', 'prisma', 'playwright', 'pg', 'ioredis'];
for (const name of dependencies) {
  try {
    add(
      `dependency ${name}`,
      true,
      (['pg', 'ioredis'].includes(name) ? requireApi : require)(`${name}/package.json`).version,
    );
  } catch {
    add(`dependency ${name}`, false, 'run npm ci in this checkout');
  }
}
add(
  'lockfile',
  existsSync(resolve(root, 'package-lock.json')),
  'npm ci is the installation source',
);
if (!uiOnly) {
  add(
    'generated Prisma client',
    existsSync(resolve(root, 'apps/api/src/generated/prisma/client.ts')),
    'public API validation owns generation',
    false,
  );
  const docker = version('docker', ['info', '--format', '{{.ServerVersion}}']);
  add(
    'Docker daemon',
    Boolean(docker),
    docker ?? 'optional when native test stores are available',
    false,
  );
  const actionlint = version('actionlint');
  add(
    'actionlint',
    Boolean(actionlint),
    actionlint?.split('\n')[0] ?? 'needed when editing workflows',
    false,
  );
}
try {
  const { chromium } = require('playwright');
  add(
    'Playwright Chromium',
    existsSync(chromium.executablePath()),
    'install with npx playwright install chromium',
  );
  if (process.argv.includes('--browser')) {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<title>MAXIM local check</title>');
      add('Chromium launch', (await page.title()) === 'MAXIM local check', browser.version());
    } finally {
      await browser.close();
    }
  }
} catch {
  add('Playwright Chromium', false, 'browser/package/native dependencies unavailable');
}
const declared = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).engines.node;
console.log(
  JSON.stringify(
    {
      profile: uiOnly ? 'ui' : 'full',
      requiredNode: declared,
      checks,
      ready: checks.every((c) => !c.required || c.ok),
    },
    null,
    2,
  ),
);
process.exitCode = checks.some((c) => c.required && !c.ok) ? 1 : 0;
