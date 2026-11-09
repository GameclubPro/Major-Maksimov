import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runSourceAbandonmentHostCli } from './source-abandonment-host.mjs';

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const request = () => ({
  version: 1,
  operation: 'preflight',
  targetSha: 'a'.repeat(40),
  selection: {
    ownerWebhookEventIds: ['owner'],
    majorBotIds: ['major'],
    protocol: 'source-abandonment-v1',
    abandonBefore: '2026-10-07T03:00:00.000Z',
  },
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'source-preflight-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nonce = '11111111-1111-4111-8111-111111111111';
  const operationDirectory = join(root, nonce);
  mkdirSync(operationDirectory, { mode: 0o700 });
  const input = request();
  const context = {
    version: 1,
    protocol: 'source-abandonment-v1',
    selection: input.selection,
    publisherBotId: 'publisher',
    networkId: 'b'.repeat(64),
    queueControlSha256: 'c'.repeat(64),
  };
  const admission = {
    version: 1,
    operation: 'admission_preview',
    applied: false,
    activationAuthorized: false,
    stoppingAuthorized: false,
    sourceSha: input.targetSha,
    imageId: `sha256:${'d'.repeat(64)}`,
    selectionSha256: digest(input.selection),
    publisherCatalogSha256: digest({ publisherBotId: 'publisher' }),
    registrySha256: 'e'.repeat(64),
    decision: 'DENY',
    sourceCoverageComplete: false,
    selectedOwners: [],
    sqlPlans: [],
    queueCounts: [],
    minimumEffectRowsForTwoReads: 0,
    issues: [{ code: 'source_candidate_refused', descriptor: 'inventory' }],
    cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
    redisCatalogs: [],
  };
  const evidencePath = join(operationDirectory, 'admission.json');
  const save = () => {
    writeFileSync(join(operationDirectory, 'context.json'), JSON.stringify(context), {
      mode: 0o600,
    });
    writeFileSync(evidencePath, JSON.stringify(admission), { mode: 0o600 });
  };
  save();
  // FLAG: Only this fixed private root is relocated. All actual file and Docker
  // absence checks execute unchanged; production has no root override.
  const source = readFileSync(
    new URL('./source-abandonment-preflight-completion.mjs', import.meta.url),
    'utf8',
  ).replace(
    "const PRIVATE_ROOT = '/var/lib/maxim-deploy/legacy-cold-private';",
    `const PRIVATE_ROOT = ${JSON.stringify(root)};`,
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const calls = [];
  const result = {
    version: 1,
    operation: 'preflight',
    decision: 'DENY',
    stopped: false,
    applied: false,
    evidencePath,
  };
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    return '';
  };
  return {
    root,
    nonce,
    operationDirectory,
    input,
    context,
    admission,
    evidencePath,
    save,
    result,
    calls,
    run,
    confirm: module.assertSourceAbandonmentPreflightCompletion,
  };
}

test('closed preflight denial requires private matching admission and both absent client identities', async (t) => {
  const h = await fixture(t);
  h.confirm(h.input, h.result, { run: h.run });
  assert.deepEqual(
    h.calls.map(({ file, args }) => [file, args]),
    [
      [
        'docker',
        [
          'ps',
          '-aq',
          '--no-trunc',
          '--filter',
          `label=com.maxim.legacy-recovery-client=${h.nonce}`,
        ],
      ],
      [
        'docker',
        ['ps', '-aq', '--no-trunc', '--filter', `name=^/maxim-legacy-recovery-${h.nonce}$`],
      ],
    ],
  );
  assert.ok(
    h.calls.every(({ options }) => options.timeout === 15000 && options.maxBuffer === 8192),
  );
});

for (const [name, mutate] of [
  [
    'prepare',
    (h) => {
      h.input.operation = 'prepare';
    },
  ],
  [
    'changed result operation',
    (h) => {
      h.result.operation = 'prepare';
    },
  ],
  [
    'stopped result',
    (h) => {
      h.result.stopped = true;
    },
  ],
  [
    'extra result field',
    (h) => {
      h.result.refused = true;
    },
  ],
  [
    'foreign path',
    (h) => {
      h.result.evidencePath = join(h.root, 'admission.json');
    },
  ],
  [
    'wrong source',
    (h) => {
      h.admission.sourceSha = 'f'.repeat(40);
      h.save();
    },
  ],
  [
    'changed selection',
    (h) => {
      h.context.selection = { ...h.input.selection, majorBotIds: ['different'] };
      h.save();
    },
  ],
  [
    'generic collector refusal',
    (h) => {
      h.admission.operation = 'inventory_preview';
      h.admission.refused = true;
      h.save();
    },
  ],
  [
    'missing stopping boundary',
    (h) => {
      delete h.admission.stoppingAuthorized;
      h.save();
    },
  ],
  [
    'missing evidence',
    (h) => {
      rmSync(h.evidencePath);
    },
  ],
  [
    'unsafe mode',
    (h) => {
      chmodSync(h.evidencePath, 0o644);
    },
  ],
  [
    'hardlinked evidence',
    (h) => {
      linkSync(h.evidencePath, join(h.root, 'duplicate'));
    },
  ],
  [
    'symlinked evidence',
    (h) => {
      const target = join(h.operationDirectory, 'other.json');
      renameSync(h.evidencePath, target);
      symlinkSync(target, h.evidencePath);
    },
  ],
  [
    'unfinished environment cleanup',
    (h) => {
      writeFileSync(join(h.operationDirectory, 'client.env'), 'private', { mode: 0o600 });
    },
  ],
])
  test(`${name} cannot nominate completed preflight`, async (t) => {
    const h = await fixture(t);
    mutate(h);
    assert.throws(() => h.confirm(h.input, h.result, { run: h.run }));
    assert.equal(h.calls.length, 0);
  });

for (const kind of ['label', 'name', 'unknown Docker result'])
  test(`${kind} client absence failure cannot nominate completion`, async (t) => {
    const h = await fixture(t);
    assert.throws(
      () =>
        h.confirm(h.input, h.result, {
          run: (file, args) => {
            if (kind === 'unknown Docker result') throw new Error('private Docker stderr');
            return args.at(-1).startsWith(`${kind}=`) ? 'a'.repeat(64) : '';
          },
        }),
      /completion_unproved/u,
    );
  });

async function cli({ operation = 'preflight', args = [], runHost, confirmCompletion } = {}) {
  let stdout = '',
    stderr = '';
  const input = { ...request(), operation };
  const result = {
    version: 1,
    operation,
    decision: 'DENY',
    stopped: false,
    applied: false,
    evidencePath: '/private/admission.json',
  };
  const status = await runSourceAbandonmentHostCli({
    args,
    input: Readable.from([JSON.stringify(input)]),
    output: {
      write: (value) => {
        stdout += value;
      },
    },
    errorOutput: {
      write: (value) => {
        stderr += value;
      },
    },
    runHost: runHost ?? (async () => result),
    confirmCompletion,
  });
  return { status, stdout, stderr, result };
}
test('direct CLI denial remains one and prepare never nominates the reserved status', async () => {
  for (const options of [{}, { args: ['--supervised-preflight'], operation: 'prepare' }]) {
    const output = await cli({
      ...options,
      confirmCompletion: () => assert.fail('cannot nominate'),
    });
    assert.equal(output.status, 1);
    assert.equal(output.stderr, '');
    assert.deepEqual(JSON.parse(output.stdout), output.result);
  }
});
test('internal profile returns three only after completed host and positive completion confirmation', async () => {
  let returned = false,
    confirmed = false;
  const output = await cli({
    args: ['--supervised-preflight'],
    runHost: async (input) => {
      returned = true;
      return {
        version: 1,
        operation: input.operation,
        decision: 'DENY',
        stopped: false,
        applied: false,
        evidencePath: '/private/admission.json',
      };
    },
    confirmCompletion: async () => {
      assert.equal(returned, true);
      await Promise.resolve();
      confirmed = true;
    },
  });
  assert.equal(confirmed, true);
  assert.equal(output.status, 3);
  assert.equal(output.stderr, '');
});
test('malformed evidence or uncertain host cleanup remains ordinary failure without a completion status', async () => {
  for (const options of [
    {
      confirmCompletion: () => {
        throw new Error('missing artifact');
      },
    },
    {
      runHost: async () => {
        throw new Error('client cleanup unknown');
      },
      confirmCompletion: () => assert.fail('cannot confirm unfinished host'),
    },
    {
      args: ['--supervised-preflight', '--bypass'],
      runHost: async () => assert.fail('invalid args'),
    },
  ]) {
    const output = await cli({ args: ['--supervised-preflight'], ...options });
    assert.equal(output.status, 1);
    assert.equal(output.stdout, '');
    assert.equal(
      output.stderr,
      'Exact-source abandonment refused; inspect its private evidence and durable journal.\n',
    );
  }
});
test('importing the host from node stdin never runs its CLI', () => {
  const source = new URL('./source-abandonment-host.mjs', import.meta.url).href;
  assert.equal(
    execFileSync(process.execPath, ['--input-type=module', '-'], {
      input: `await import(${JSON.stringify(source)});`,
      encoding: 'utf8',
      timeout: 5000,
    }),
    '',
  );
});
