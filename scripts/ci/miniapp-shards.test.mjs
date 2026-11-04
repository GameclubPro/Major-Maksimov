import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const jobs = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')).jobs;
const miniapp = jobs.miniapp;
const shards = ['1/4', '2/4', '3/4', '4/4'];
const browserFiles = [
  'karavan-shop-formats',
  'karavan-shop-simple',
  'karavan-server-recovery',
  'karavan-binding-hook',
  'personal-access-entry',
  'entity-presentation',
  'moderator-choice',
  'settings-reports',
  'report-journal-races',
  'settings-required-subscription',
  'settings-draft',
  'settings-search-layout',
  'settings-antiduplicate',
  'settings-duplicate-diagnostics',
  'settings-rules',
  'rules-image-picker',
  'publication-list',
  'publication-actions',
  'publication-session',
  'publication-shared-media',
  'publication-video-picker',
  'publication-composer-usability',
  'max-rich-text-formatting',
  'bot-speech-style',
].map((name) => `apps/miniapp/test/${name}.browser.mjs`);
const expectedCommands = [
  'npm run check:miniapp',
  'npm run build:miniapp:production',
  'npm run screenshots:miniapp:smoke',
  ...browserFiles.map((path) => `node ${path}`),
  ...['categories', 'boundaries', 'queue'].map(
    (group) => `SHOP_SIMPLE_ONLY=${group} node apps/miniapp/test/karavan-shop-simple.browser.mjs`,
  ),
];

function selectedSteps(shard) {
  return miniapp.steps.filter((step) => {
    if (!step.if) return true;
    const match = step.if.match(/^matrix\.shard (==|!=) '([1-4]\/4)'$/u);
    assert.ok(match, `Unreviewed browser condition: ${step.if}`);
    return match[1] === '==' ? shard === match[2] : shard !== match[2];
  });
}

test('four isolated browser jobs retain every existing validation command exactly once', () => {
  assert.deepEqual(miniapp.strategy, { 'fail-fast': false, matrix: { shard: shards } });
  assert.equal(miniapp['timeout-minutes'], 15);
  assert.equal(miniapp['continue-on-error'], undefined);
  assert.equal(miniapp.if, "needs.impact.outputs.miniapp == 'true'");
  assert.ok(jobs.required.needs.includes('miniapp'));
  const commands = shards.flatMap((shard) =>
    selectedSteps(shard)
      .flatMap((step) => (step.run ?? '').trim().split('\n'))
      .filter(
        (command) =>
          command.includes('node apps/miniapp/test/') || expectedCommands.includes(command),
      ),
  );
  assert.deepEqual(commands.sort(), [...expectedCommands].sort());
  assert.equal(new Set(commands).size, commands.length);
  for (const path of browserFiles) assert.ok(statSync(resolve(root, path)).isFile(), path);
  for (const step of miniapp.steps) assert.equal(step['continue-on-error'], undefined);
});

test('each browser partition owns dependencies and builds contracts before its first case', () => {
  for (const shard of shards) {
    const steps = selectedSteps(shard);
    const index = (run) => steps.findIndex((step) => step.run === run);
    const firstBrowser = steps.findIndex((step) => step.run?.startsWith('node apps/miniapp/test/'));
    assert.ok(firstBrowser >= 0, `Empty browser partition: ${shard}`);
    for (const run of ['npm ci --no-audit', 'npx playwright install --with-deps chromium']) {
      assert.ok(index(run) >= 0 && index(run) < firstBrowser, `${shard}: missing ${run}`);
    }
    const build =
      shard === '1/4'
        ? 'npm run build:miniapp:production'
        : 'npm run build --workspace @maxim/contracts';
    assert.ok(index(build) >= 0 && index(build) < firstBrowser, `${shard}: missing ${build}`);
    const shop = index('node apps/miniapp/test/karavan-shop-formats.browser.mjs');
    const webkit = index('npx playwright install --with-deps webkit');
    if (shop >= 0) assert.ok(webkit >= 0 && webkit < shop);
    else assert.equal(webkit, -1, 'Only the complete Android/iOS shop matrix needs WebKit');
  }
});
