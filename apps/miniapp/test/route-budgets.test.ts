import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  collectManifestAssets,
  differenceAssets,
  rankContributors,
  resolveBudgetLimit,
  resolveManifestEntry,
  validateBudgetConfig,
  validateRouteBudgetCoverage,
} from '../scripts/budget-utils.mjs';

const routeBudgets = JSON.parse(
  readFileSync(new URL('../route-budgets.json', import.meta.url), 'utf8'),
);

test('route budget config covers new route CSS surfaces', () => {
  validateBudgetConfig(routeBudgets);
  const budgetById = new Map(
    routeBudgets.budgets.map((budget: { id: string }) => [budget.id, budget]),
  );

  for (const id of [
    'publications',
    'publisher-entity-modules',
    'publisher-auto-replies',
    'events',
    'suggest',
    'legal',
    'stats',
  ]) {
    const budget = budgetById.get(id) as { limits?: { cssGzipBytes?: number } } | undefined;
    assert.ok(budget?.limits?.cssGzipBytes, `${id} must have a CSS budget`);
  }
});

test('cold comments budget includes authentication and prefetch without subtracting home assets', () => {
  const budget = routeBudgets.budgets.find((item: { id: string }) => item.id === 'comments-cold');
  assert.ok(budget);
  assert.equal(budget.baseline, undefined);
  assert.deepEqual(budget.entries, [
    'index.html',
    'src/lib/api/me-client.ts',
    'src/lib/api/miniapp-server-session.ts',
    'src/lib/comment-dialog-startup.ts',
    'src/pages/channel-dialog-page.tsx',
  ]);
  assert.ok(budget.limits.jsGzipBytes <= 180992);
  assert.ok(budget.limits.cssGzipBytes <= 41984);
});

test('commercial lazy budgets include participant search in both complete editing flows', () => {
  const entry = (name: string) => `src/pages/settings/commercial-policy-${name}.tsx`;
  const expectedEntries = {
    'commercial-filter-tools': ['tools'],
    'commercial-filter-exceptions': ['tools', 'exceptions', 'exception-editor', 'author-picker'],
    'commercial-filter-preview': ['tools', 'preview', 'author-picker'],
    'commercial-filter-author-picker': ['author-picker'],
  };
  for (const [id, entries] of Object.entries(expectedEntries)) {
    const budget = routeBudgets.budgets.find((item: { id: string }) => item.id === id);
    assert.ok(budget, `${id} must measure the lazy surface`);
    assert.equal(budget.baseline, 'commercial-filter-editor');
    assert.deepEqual(budget.entries, entries.map(entry));
    assert.ok(budget.limits.jsGzipBytes > 0);
    assert.ok(budget.limits.cssGzipBytes > 0);
  }
});

test('manifest asset collection deduplicates transitive chunks and supports baselines', () => {
  const manifest = {
    'index.html': {
      file: 'assets/index.js',
      css: ['assets/index.css'],
      imports: ['_shared.js'],
    },
    '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
    'src/pages/chats-page.tsx': {
      file: 'assets/chats.js',
      imports: ['index.html', '_shared.js'],
    },
    'src/pages/events-page.tsx': {
      file: 'assets/events.js',
      css: ['assets/events.css'],
      imports: ['index.html', '_shared.js'],
    },
  };
  const startup = collectManifestAssets(manifest, ['index.html', 'src/pages/chats-page.tsx']);
  const events = collectManifestAssets(manifest, ['src/pages/events-page.tsx']);
  const incremental = differenceAssets(events, startup);

  assert.deepEqual([...startup.js].sort(), [
    'assets/chats.js',
    'assets/index.js',
    'assets/shared.js',
  ]);
  assert.deepEqual([...incremental.js], ['assets/events.js']);
  assert.deepEqual([...incremental.css], ['assets/events.css']);
});

test('network editing budgets count the lazy signature stylesheet and deduplicate shared CSS', () => {
  const stylesheet = 'src/styles/channel-post-signature.css';
  for (const id of ['network-settings', 'network-settings-full']) {
    const budget = routeBudgets.budgets.find((item: { id: string }) => item.id === id);
    assert.ok(budget?.entries.includes(stylesheet), `${id} must measure the lazy editor CSS`);
  }
  const recovery = routeBudgets.budgets.find(
    (item: { id: string }) => item.id === 'network-settings-recovery-cold',
  );
  assert.ok(recovery && !recovery.entries.includes(stylesheet));

  const manifest = {
    'src/pages/settings/channel-post-signature-fields.tsx': {
      file: 'assets/signature-fields.js',
      css: ['assets/shared.css'],
    },
    [stylesheet]: {
      file: 'assets/signature.css',
      isDynamicEntry: true,
      css: ['assets/shared.css'],
    },
  };
  const assets = collectManifestAssets(manifest, [
    'src/pages/settings/channel-post-signature-fields.tsx',
    resolveManifestEntry(manifest, stylesheet),
  ]);
  assert.deepEqual([...assets.js], ['assets/signature-fields.js']);
  assert.deepEqual([...assets.css].sort(), ['assets/shared.css', 'assets/signature.css']);
});

test('route coverage fails when a dynamic page manifest entry has no budget', () => {
  const manifest = {
    'src/pages/chats-page.tsx': { isDynamicEntry: true },
    'src/pages/events-page.tsx': { isDynamicEntry: true },
    'src/pages/home-entity-sheets.tsx': { isDynamicEntry: true },
  };
  const config = {
    manifestRouteEntryPattern: '^src/pages/[^/]+-page\\.tsx$',
    budgets: [{ entries: ['src/pages/chats-page.tsx'] }],
  };

  assert.throws(
    () => validateRouteBudgetCoverage(manifest, config),
    /src\/pages\/events-page\.tsx/u,
  );
});

test('budget allowances and top contributors are deterministic', () => {
  const budget = {
    limits: { jsGzipBytes: 1_000 },
    allowances: [
      {
        asset: 'js',
        bytes: 512,
        when: { env: 'VITE_API_BASE', matches: '^https?://' },
      },
      {
        asset: 'js',
        bytes: 128,
        when: { env: 'VITE_ROUTER_MODE', equals: 'hash' },
      },
    ],
  };
  assert.equal(resolveBudgetLimit(budget, 'js', {}), 1_000);
  assert.equal(
    resolveBudgetLimit(budget, 'js', {
      VITE_API_BASE: 'https://major-maksimov.ru/api/v1',
      VITE_ROUTER_MODE: 'hash',
    }),
    1_640,
  );
  assert.deepEqual(
    rankContributors(new Set(['small.js', 'large.js', 'medium.js']), (file) => file.length),
    [
      { file: 'medium.js', gzipBytes: 9 },
      { file: 'large.js', gzipBytes: 8 },
      { file: 'small.js', gzipBytes: 8 },
    ],
  );
});

test('script source references select JavaScript before a same-named CSS chunk', () => {
  const manifest = {
    '_confirm-hash.css': {
      file: 'assets/action-confirm-sheet-hash.css',
      name: 'action-confirm-sheet',
    },
    '_confirm-hash.js': {
      file: 'assets/action-confirm-sheet-hash.js',
      name: 'action-confirm-sheet',
      imports: ['_focus.js'],
      css: ['assets/action-confirm-sheet-hash.css'],
    },
    '_focus.js': { file: 'assets/dialog-focus.js' },
  };
  const entry = resolveManifestEntry(manifest, 'src/components/ui/action-confirm-sheet.tsx');
  assert.equal(entry, '_confirm-hash.js');
  assert.deepEqual(
    [...collectManifestAssets(manifest, [entry]).js],
    ['assets/action-confirm-sheet-hash.js', 'assets/dialog-focus.js'],
  );
});

test('a CSS-only match cannot satisfy a required script body', () => {
  assert.throws(
    () =>
      resolveManifestEntry(
        { '_confirm.css': { file: 'assets/action-confirm-sheet-hash.css' } },
        'src/components/ui/action-confirm-sheet.tsx',
      ),
    /Manifest entry not found/u,
  );
});

test('an exact script manifest key takes priority over fallback names', () => {
  const key = 'src/components/ui/action-confirm-sheet.tsx';
  const manifest = {
    '_confirm.js': { file: 'assets/action-confirm-sheet-old.js', name: 'action-confirm-sheet' },
    [key]: { file: 'assets/action-confirm-sheet-current.js' },
  };
  assert.equal(resolveManifestEntry(manifest, key), key);
});
