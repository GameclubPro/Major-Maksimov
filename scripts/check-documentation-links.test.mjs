import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  findDocumentationLinkViolations,
  readDocumentation,
} from './check-documentation-links.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

async function check(root) {
  const { documents, violations } = readDocumentation(root);
  return [...violations, ...(await findDocumentationLinkViolations(root, documents))];
}

test('resolves local links, encoded paths, Unicode and repeated heading anchors', async (t) => {
  const root = fixture(t, {
    'README.md': [
      '[one](docs/My%20Guide.md#привет-api)',
      '[two](docs/My%20Guide.md?plain=1#привет-api-1)',
      '[collision](/docs/My%20Guide.md#привет-api-1-1)',
      '[explicit](docs/My%20Guide.md#custom-id)',
      '[image](docs/My%20Guide.md#diagram-alt)',
      '[directory](docs/)',
    ].join('\n'),
    'docs/My Guide.md':
      '# Привет, **API**!\n# Привет, `API`!\n# Привет API-1\n<a id="custom-id"></a>\n# Diagram ![alt](../icon.svg)\n',
    'icon.svg': '<svg/>',
  });
  assert.deepEqual(await check(root), []);
});

test('checks reference links and images at the usage line', async (t) => {
  const root = fixture(t, {
    'README.md':
      '[guide][Guide]\n![picture][icon]\n\n[Guide]: docs/guide.md#old\n[icon]: missing.png\n',
    'docs/guide.md': '# New\n',
  });
  assert.deepEqual(await check(root), [
    'README.md:1 references missing section docs/guide.md#old.',
    'README.md:2 references missing local target missing.png.',
  ]);
});

test('ignores code examples and external URLs without network access', async (t) => {
  const root = fixture(t, {
    'README.md':
      '[site](https://example.invalid/missing)\n[mail](mailto:test@example.invalid)\n[cdn](//example.invalid)\n`[example](missing.md)`\n```markdown\n[example](missing.md)\n```\n\n    [example](missing.md)\n',
  });
  assert.deepEqual(await check(root), []);
});

test('checks tracked and nonignored Markdown including instructions, with no archive exemption', async (t) => {
  const root = fixture(t, {
    '.gitignore': 'node_modules/\nignored.md\n',
    'AGENTS.md': '[guide](deleted.md)\n',
    'apps/api/AGENTS.override.md': '[guide](../../missing.md)\n',
    'docs/operations/archive/old.md': '[gone](missing.md)\n',
    'deleted.md': '# Deleted\n',
    'ignored.md': '[private](missing.md)\n',
    'node_modules/dependency/README.md': '[example](missing.md)\n',
  });
  execFileSync('git', ['add', 'deleted.md'], { cwd: root });
  rmSync(join(root, 'deleted.md'));
  assert.deepEqual(
    [...readDocumentation(root).documents.keys()],
    ['AGENTS.md', 'apps/api/AGENTS.override.md', 'docs/operations/archive/old.md'],
  );
  const violations = await check(root);
  assert.equal(violations.length, 3);
  assert.match(violations[0], /AGENTS.md:1 references missing local target deleted.md/u);
});

test('rejects traversal and symlinks without following their contents', async (t) => {
  const root = fixture(t, {
    'README.md':
      '[outside](../private.md)\n[linked](linked/secret.md#secret)\n[direct](alias.md)\n',
  });
  symlinkSync(tmpdir(), join(root, 'linked'), 'dir');
  symlinkSync(join(root, 'missing.md'), join(root, 'alias.md'));
  const violations = (await check(root)).join('\n');
  assert.match(violations, /alias.md cannot be checked: symlink/u);
  assert.match(violations, /README.md:1 references outside repository/u);
  assert.match(violations, /README.md:2 references symlink/u);
  assert.match(violations, /README.md:3 references symlink/u);
});

test('reports malformed paths and ignored Markdown anchors instead of silently passing', async (t) => {
  const root = fixture(t, {
    '.gitignore': 'private.md\n',
    'private.md': '# Secret\n',
    'README.md':
      '[bad](%ZZ.md)\n[null](%00)\n[private](private.md#secret)\n[bad child](README.md/child)\n',
  });
  const violations = await check(root);
  assert.equal(violations.length, 4);
  assert.match(violations[0], /invalid URL encoding/u);
  assert.match(violations[1], /invalid local path/u);
  assert.match(violations[2], /outside the checked files/u);
  assert.match(violations[3], /missing local target/u);
});
