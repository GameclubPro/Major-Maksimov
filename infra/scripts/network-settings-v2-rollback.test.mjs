import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertNetworkSettingsV2Source,
  NETWORK_SETTINGS_V2_SOURCE_CHECKS,
  NETWORK_SETTINGS_V2_SCOPED_CHECKS,
  NETWORK_SETTINGS_V2_RUNTIME_IMPORTS,
} from './assert-network-settings-v2-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const marker = 'maxim_topology_require_network_settings_v2';
const compact = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--).*$/gmu, '')
    .replace(/\s+/gu, '');
const failure = /lacks network settings v2\+ readers\/writers/u;

test('v2+ rollback retains list-intent parsing, revisions and atomic receipt writers', () => {
  assert.doesNotThrow(() => assertNetworkSettingsV2Source('a'.repeat(40), read));
  for (const [path, fragments] of NETWORK_SETTINGS_V2_SOURCE_CHECKS) {
    const original = compact(read(path));
    for (const fragment of fragments) {
      const changed = original.replaceAll(compact(fragment), 'removed_reader');
      assert.notEqual(changed, original, `Missing fixture mutation: ${path}`);
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === path ? changed : read(candidate),
          ),
        /lacks network settings v2\+ readers\/writers/u,
      );
    }
    assert.throws(
      () =>
        assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
          candidate === path ? `/* ${read(path)} */` : read(candidate),
        ),
      /lacks network settings v2\+ readers\/writers/u,
    );
  }
  assert.throws(() => assertNetworkSettingsV2Source('main', read), /Exact source SHA/u);
  assert.throws(
    () =>
      assertNetworkSettingsV2Source('a'.repeat(40), () => {
        throw new Error('pre-v2 source absent');
      }),
    /lacks network settings v2/u,
  );
});

test('v2+ facade requires both canonical leaves from the selected source', () => {
  const facade = 'packages/contracts/src/network-settings.ts';
  const leaves = [
    'packages/contracts/src/network-settings-read.ts',
    'packages/contracts/src/network-settings-actions.ts',
  ];
  const visited = new Set();
  assert.doesNotThrow(() =>
    assertNetworkSettingsV2Source('a'.repeat(40), (path) => {
      visited.add(path);
      return read(path);
    }),
  );
  for (const path of [facade, ...leaves]) {
    assert.ok(visited.has(path), path);
    assert.throws(
      () =>
        assertNetworkSettingsV2Source('a'.repeat(40), (candidate) => {
          if (candidate === path) throw new Error('canonical source missing');
          return read(candidate);
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes('lacks network settings v2+ readers/writers') &&
        error.message.includes(path),
      path,
    );
  }

  for (const leaf of ['network-settings-read', 'network-settings-actions']) {
    const reexport = `export * from './${leaf}.js';`;
    const original = read(facade);
    assert.ok(original.includes(reexport));
    for (const replacement of ['', `// ${reexport}`, `export * from './${leaf}-missing.js';`]) {
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === facade ? original.replace(reexport, replacement) : read(candidate),
          ),
        /lacks network settings v2\+ readers\/writers: packages\/contracts\/src\/network-settings\.ts/u,
        `${leaf}: ${replacement}`,
      );
    }
  }
});

test('v2+ actions retain the runtime read-schema edge and request list intent', () => {
  const path = 'packages/contracts/src/network-settings-actions.ts';
  const original = read(path);
  const intent = 'navigationAllowlist: networkNavigationAllowlistIntentSchema.optional(),';
  const missingRequestIntent = original.replace(intent, '');
  assert.notEqual(missingRequestIntent, original);
  assert.ok(
    missingRequestIntent.includes(intent),
    'response intent remains present, so it cannot substitute for request parsing',
  );
  const importStart = original.indexOf('import {\n');
  assert.ok(importStart >= 0);
  for (const changed of [
    missingRequestIntent,
    original.replace("from './network-settings-read.js'", "from './network-settings-stale.js'"),
    original.slice(0, importStart) +
      original.slice(importStart).replace('import {', 'import type {'),
    original.replace('    recipients: z.array(networkSettingsRecipientSchema).min(1),', ''),
  ]) {
    assert.notEqual(changed, original);
    assert.throws(
      () =>
        assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
          candidate === path ? changed : read(candidate),
        ),
      /lacks network settings v2\+ readers\/writers: packages\/contracts\/src\/network-settings-actions\.ts/u,
    );
  }
});

test('v2+ scoped readers retain every own-revision and transactional writer witness', () => {
  for (const [path, start, end, fragments] of NETWORK_SETTINGS_V2_SCOPED_CHECKS) {
    const original = compact(read(path));
    const first = original.indexOf(compact(start));
    const last = original.indexOf(compact(end), first + compact(start).length);
    assert.ok(first >= 0 && last > first, `Missing fixture boundary: ${path} ${start}`);
    const body = original.slice(first, last);
    for (const fragment of fragments) {
      const needle = compact(fragment);
      assert.ok(body.includes(needle), `Missing fixture witness: ${path} ${fragment}`);
      const changed =
        original.slice(0, first) + body.replaceAll(needle, 'removed_reader') + original.slice(last);
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === path ? changed : read(candidate),
          ),
        failure,
        `${path}: ${fragment}`,
      );
      // FLAG: Keeping the same witness elsewhere must not rescue an incompatible parser/writer.
      const decoy = changed + `;function unrelated_reader(){${needle}}`;
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === path ? decoy : read(candidate),
          ),
        failure,
        `${path}: out-of-scope ${fragment}`,
      );
    }
    for (const changed of [
      original.slice(0, first) + 'removed_boundary' + original.slice(first + compact(start).length),
      original.slice(0, last) + 'removed_boundary' + original.slice(last + compact(end).length),
    ]) {
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === path ? changed : read(candidate),
          ),
        failure,
        `${path}: missing boundary`,
      );
    }
  }
});

test('v2+ runtime imports retain every canonical schema without pinning unrelated imports', () => {
  for (const [path, module, names] of NETWORK_SETTINGS_V2_RUNTIME_IMPORTS) {
    const original = read(path);
    const edge = [...original.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/gu)].find(
      (entry) => entry[3] === module,
    );
    assert.ok(edge, `Missing runtime edge: ${path}`);
    for (const name of names) {
      const changed = original.replace(edge[0], edge[0].replace(name, 'removed_reader'));
      assert.throws(
        () =>
          assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
            candidate === path ? changed : read(candidate),
          ),
        failure,
        name,
      );
    }
    const extended = original.replace(
      edge[0],
      edge[0].replaceAll('{', '{ networkSettingsFieldSchema,'),
    );
    assert.doesNotThrow(() =>
      assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
        candidate === path ? extended : read(candidate),
      ),
    );
  }
});

test('v2+ recipient parser permits new fields without losing retained revision witnesses', () => {
  const path = 'packages/contracts/src/network-settings-read.ts';
  const original = read(path);
  const changed = original.replace(
    '    rulesRevision:',
    '    futureRevision: z.number().optional(),\n    rulesRevision:',
  );
  assert.notEqual(changed, original);
  assert.doesNotThrow(() =>
    assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
      candidate === path ? changed : read(candidate),
    ),
  );
});

test('v2+ retains the inline v3 reader with every legacy version routing branch', () => {
  const path = 'apps/api/src/admin/network-settings.service.ts';
  const contract = 'packages/contracts/src/network-settings-read.ts';
  const original = compact(read(path));
  const v4Guard =
    "||(payload.request.changes.some((change)=>change.path==='linkRulesPolicy')&&version<4)";
  const v4Writer =
    "readerVersion:request.changes.some((change)=>change.path==='linkRulesPolicy')?4:";
  const legacy = original
    .replace('NETWORK_SETTINGS_OPERATION_READER_VERSION,', '')
    .replace(
      "export{NETWORK_SETTINGS_OPERATION_READER_VERSION}from'@maxim/contracts/network-settings';",
      'exportconstNETWORK_SETTINGS_OPERATION_READER_VERSION=3;',
    )
    .replace(v4Guard, '')
    .replace(v4Writer, 'readerVersion:');
  assert.ok(legacy.includes('exportconstNETWORK_SETTINGS_OPERATION_READER_VERSION=3;'));
  assert.ok(!legacy.includes(v4Guard));
  assert.ok(!legacy.includes(v4Writer));
  const legacyRead = (candidate) =>
    candidate === path
      ? legacy
      : candidate === contract
        ? read(candidate).replace('export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 4;', '')
        : read(candidate);
  assert.doesNotThrow(() => assertNetworkSettingsV2Source('a'.repeat(40), legacyRead));
  for (const fragment of [
    'exportconstNETWORK_SETTINGS_OPERATION_READER_VERSION=3;',
    'readerVersion:V3_SECTIONS.has(request.section)?3:request.navigationAllowlist?2:1',
    '(payload.request.navigationAllowlist&&version<2)',
    '(V3_SECTIONS.has(payload.request.section)&&version<3)',
  ]) {
    assert.ok(legacy.includes(fragment), fragment);
    const changed = legacy.replace(fragment, 'removed_reader');
    assert.throws(
      () =>
        assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
          candidate === path ? changed : legacyRead(candidate),
        ),
      failure,
      fragment,
    );
  }
});

test('v2+ canonical v4 reader requires its selected contract and live runtime edge', () => {
  const path = 'apps/api/src/admin/network-settings.service.ts';
  const contract = 'packages/contracts/src/network-settings-read.ts';
  const original = read(path);
  const runtime = [...original.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/gu)].find(
    (entry) => entry[3] === '@maxim/contracts/network-settings',
  );
  assert.ok(runtime);
  const reexport =
    "export { NETWORK_SETTINGS_OPERATION_READER_VERSION } from '@maxim/contracts/network-settings';";
  assert.ok(original.includes(reexport));
  const guard =
    "(payload.request.changes.some((change) => change.path === 'linkRulesPolicy') && version < 4)";
  const writer =
    "readerVersion:request.changes.some((change)=>change.path==='linkRulesPolicy')?4:";
  const compactOriginal = compact(original);
  assert.ok(original.includes(guard));
  assert.ok(compactOriginal.includes(writer));
  for (const [candidatePath, changed] of [
    [contract, read(contract).replace('READER_VERSION = 4;', 'READER_VERSION = 3;')],
    [path, original.replace(reexport, '')],
    [path, original.replace(runtime[0], runtime[0].replace('import {', 'import type {'))],
    [
      path,
      original.replace(
        runtime[0],
        runtime[0].replace('@maxim/contracts/network-settings', '@maxim/contracts/stale-network-settings'),
      ),
    ],
    [path, original.replace(guard, 'false') + `;function unrelated_reader(){return ${guard};}`],
    [path, compactOriginal.replace(writer, 'readerVersion:') + `;const unrelated={${writer}1};`],
  ]) {
    assert.notEqual(changed, read(candidatePath), candidatePath);
    assert.throws(
      () =>
        assertNetworkSettingsV2Source('a'.repeat(40), (candidate) =>
          candidate === candidatePath ? changed : read(candidate),
        ),
      failure,
      candidatePath,
    );
  }
});

test('both API rollback paths check v2+ before runtime or Git mutation', () => {
  for (const [path, argument, transition] of [
    [
      'infra/scripts/vps-runtime-rollback.sh',
      'TARGET_FULL_SHA',
      'begin_runtime_rollback_transition',
    ],
    ['infra/scripts/vps-release-rollback.sh', 'API_SOURCE_SHA', 'begin_release_runtime_transition'],
  ]) {
    const source = read(path);
    const call = `${marker} "$${argument}"`;
    const offset = source.indexOf(call);
    assert.ok(offset > 0, path);
    assert.equal(source.indexOf(call, offset + call.length), -1, path);
    assert.ok(source.lastIndexOf(`\n${transition}\n`) > offset, path);
    if (argument === 'TARGET_FULL_SHA')
      assert.ok(source.indexOf('\ngit switch --detach "$TARGET_FULL_SHA"') > offset);
    assert.match(source, /_prisma_migrations WHERE finished_at IS NOT NULL/u);
  }
  assert.match(
    read('infra/scripts/lib/deploy-topology.sh'),
    /assert-network-settings-v2-source\.mjs/u,
  );
});

test('static-only rollback keeps the offline path without v2 API source probes', () => {
  const source = read('infra/scripts/vps-release-rollback.sh');
  const call = source.indexOf(`${marker} "$API_SOURCE_SHA"`);
  const start = source.lastIndexOf('if [[ "$SELECT_API" -eq 1 ]]; then', call);
  const end = source.indexOf('\nfi\n', call) + 4;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
SELECT_API=0
require_command() { echo forbidden-command >&2; return 1; }
git() { echo forbidden-git >&2; return 1; }
docker() { echo forbidden-docker >&2; return 1; }
${marker}() { echo forbidden-v2-floor >&2; return 1; }
${source.slice(start, end)}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
