import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  BOOTSTRAP_WORKFLOW,
  bootstrapContext,
  bootstrapPrivatePackage,
  bootstrapFailureMessage,
  runBootstrap,
  seedDockerfile,
} from './registry-bootstrap.mjs';

const expected = {
  repository: 'GameclubPro/Major-Maksimov',
  repositoryId: '1168895008',
  sha: 'a'.repeat(40),
  component: 'api',
};
function environment(patch = {}) {
  return {
    GITHUB_REPOSITORY: expected.repository,
    GITHUB_REPOSITORY_ID: expected.repositoryId,
    GITHUB_SHA: expected.sha,
    MAXIM_IMAGE_COMPONENT: 'api',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `${expected.repository}/${BOOTSTRAP_WORKFLOW}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: expected.sha,
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    ...patch,
  };
}
function response(patch = {}) {
  return {
    status: 200,
    body: {
      name: 'major-maksimov-release-api',
      package_type: 'container',
      visibility: 'private',
      repository: { full_name: expected.repository, id: Number(expected.repositoryId) },
      ...patch,
    },
  };
}

test('CLI distinguishes context and credential refusals without rendering supplied values', () => {
  const secret = 'synthetic-sensitive-marker';
  for (const [patch, stage] of [
    [{ GITHUB_REF: `refs/heads/${secret}`, GH_TOKEN: 'x'.repeat(40) }, 'context'],
    [{ GH_TOKEN: `${secret} invalid` }, 'credential-shape'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/ci/registry-bootstrap.mjs'], {
      env: environment(patch),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `Registry bootstrap stopped; private package admission did not pass (stage=${stage}, code=REFUSED).\n`,
    );
    assert.equal(result.stderr.includes(secret), false);
  }
});

test('injected dependency failures retain their exact phase through successful cleanup', async (t) => {
  const secret = 'synthetic-private-dependency-output';
  const cases = [
    { stage: 'login', code: 'DEPENDENCY_FAILED', failCommand: 'login', calls: ['login'], reads: 0 },
    { stage: 'metadata-before', code: 'UNVERIFIED', failRead: 1, calls: ['login'], reads: 1 },
    {
      stage: 'metadata-before',
      code: 'UNVERIFIED',
      replies: [{ status: 403 }],
      calls: ['login'],
      reads: 1,
    },
    {
      stage: 'metadata-before',
      code: 'REGISTRY_PACKAGE_UNVERIFIED',
      replies: [{ status: 200, body: null }],
      calls: ['login'],
      reads: 1,
    },
    {
      stage: 'metadata-before',
      code: 'REGISTRY_PACKAGE_PUBLIC',
      replies: [response({ visibility: 'public' })],
      calls: ['login'],
      reads: 1,
    },
    {
      stage: 'metadata-before',
      code: 'REGISTRY_PACKAGE_NOT_PRIVATE',
      replies: [response({ visibility: 'internal' })],
      calls: ['login'],
      reads: 1,
    },
    {
      stage: 'metadata-before',
      code: 'REGISTRY_PACKAGE_UNBOUND',
      replies: [response({ repository: { id: 1, full_name: expected.repository } })],
      calls: ['login'],
      reads: 1,
    },
    {
      stage: 'seed-build',
      code: 'DEPENDENCY_FAILED',
      failCommand: 'build',
      replies: [{ status: 404 }],
      calls: ['login', 'build'],
      reads: 1,
    },
    {
      stage: 'seed-push',
      code: 'DEPENDENCY_FAILED',
      failCommand: 'push',
      replies: [{ status: 404 }],
      calls: ['login', 'build', 'push'],
      reads: 1,
    },
    {
      stage: 'metadata-after',
      code: 'UNVERIFIED',
      failRead: 2,
      replies: [{ status: 404 }],
      calls: ['login', 'build', 'push'],
      reads: 2,
    },
    {
      stage: 'metadata-after',
      code: 'UNVERIFIED',
      replies: [{ status: 404 }, { status: 403 }],
      calls: ['login', 'build', 'push'],
      reads: 2,
    },
    {
      stage: 'metadata-after',
      code: 'REGISTRY_PACKAGE_PUBLIC',
      replies: [{ status: 404 }, response({ visibility: 'public' })],
      calls: ['login', 'build', 'push'],
      reads: 2,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    await t.test(`${index + 1}: ${scenario.stage} ${scenario.code}`, async () => {
      const token = 'synthetic_token_'.padEnd(40, 'x');
      const calls = [];
      const directories = new Set();
      let reads = 0;
      const diagnostic = await runBootstrap(environment({ GH_TOKEN: token }), [], {
        execute: (binary, args, options) => {
          assert.equal(binary, 'docker');
          const command = args[0] === 'image' ? args[1] : args[0];
          calls.push(command);
          directories.add(options.env.DOCKER_CONFIG);
          assert.equal(statSync(options.env.DOCKER_CONFIG).mode & 0o777, 0o700);
          assert.equal(options.input, command === 'login' ? token : undefined);
          if (command === 'build') directories.add(args.at(-1));
          if (scenario.failCommand === command) throw new Error(secret);
          return '';
        },
        request: async (url, options) => {
          reads++;
          assert.equal(
            url,
            'https://api.github.com/users/GameclubPro/packages/container/major-maksimov-release-api',
          );
          assert.equal(options.headers.authorization, `Bearer ${token}`);
          assert.equal(options.redirect, 'error');
          if (scenario.failRead === reads) throw new Error(secret);
          const reply = scenario.replies?.[reads - 1];
          assert.ok(reply, 'unexpected additional metadata request');
          return new Response(JSON.stringify(reply.body ?? null), { status: reply.status });
        },
      }).then(
        () => assert.fail('admission must remain blocked'),
        (error) => error,
      );
      assert.equal(diagnostic.stage, scenario.stage);
      assert.equal(diagnostic.code, scenario.code);
      assert.deepEqual(calls, scenario.calls);
      assert.equal(reads, scenario.reads);
      assert.ok([...directories].every((directory) => !existsSync(directory)));
      const message = bootstrapFailureMessage(diagnostic);
      assert.equal(message.includes(secret), false);
      assert.equal(message.includes(token), false);
      assert.equal(Object.hasOwn(diagnostic, 'cause'), false);
      assert.equal(diagnostic.message.includes(secret), false);
      assert.equal(
        message.includes('package is public; choose a new reserved name'),
        scenario.code === 'REGISTRY_PACKAGE_PUBLIC',
      );
    });
  }
});

test('diagnostics reject arbitrary stage and code text', () => {
  assert.equal(
    bootstrapFailureMessage({
      stage: 'sensitive-stage',
      code: 'sensitive-code',
      message: 'sensitive-message',
    }),
    'Registry bootstrap stopped; private package admission did not pass (stage=unknown, code=INTERNAL).\n',
  );
});

test('empty, oversized and non-printable ASCII credentials reach no dependency', async () => {
  for (const token of [
    undefined,
    null,
    123,
    false,
    {},
    '',
    'x'.repeat(4097),
    ' x',
    'x ',
    'x y',
    'x\t',
    'x\r',
    'x\n',
    'x\0',
    'x\x1f',
    'x\x7f',
    'x\x80',
    'x\u00a0',
    'x\u200b',
    'x\u2028',
    'x\ufeff',
  ]) {
    await assert.rejects(
      runBootstrap(environment({ GH_TOKEN: token }), [], {
        execute: () => assert.fail('invalid credential must not reach Docker'),
        request: () => assert.fail('invalid credential must not reach metadata'),
      }),
      { stage: 'credential-shape', code: 'REFUSED' },
    );
  }
});

test('bounded printable ASCII credentials reach injected login without normalization', async () => {
  for (const token of [
    'x',
    'x'.repeat(19),
    'x'.repeat(20),
    'x'.repeat(255),
    'x'.repeat(256),
    'x'.repeat(4096),
    Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).join(''),
  ]) {
    await assert.rejects(
      runBootstrap(environment({ GH_TOKEN: token }), [], {
        execute: (_binary, _args, options) => {
          assert.equal(options.input, token);
          throw new Error('synthetic login failure');
        },
        request: () => assert.fail('failed login must not reach metadata'),
      }),
      { stage: 'login', code: 'DEPENDENCY_FAILED' },
    );
  }
});

test('an opaque printable workflow token longer than 255 characters reaches only injected login', async () => {
  const token = `synthetic.header-${'x'.repeat(300)}.signature=`;
  let logins = 0;
  await assert.rejects(
    runBootstrap(environment({ GH_TOKEN: token }), [], {
      execute: (binary, args, options) => {
        logins++;
        assert.equal(binary, 'docker');
        assert.deepEqual(args, [
          'login',
          'ghcr.io',
          '--username',
          'GameclubPro',
          '--password-stdin',
        ]);
        assert.equal(options.input, token);
        throw new Error('synthetic login refusal');
      },
      request: () => assert.fail('failed login must not reach metadata'),
    }),
    { stage: 'login', code: 'DEPENDENCY_FAILED' },
  );
  assert.equal(logins, 1);
});

test('opaque credentials reach metadata unchanged and denied metadata still blocks seed writes', async () => {
  const token = `synthetic.header-${'x'.repeat(300)}.signature=`;
  const calls = [];
  let auth;
  const diagnostic = await runBootstrap(environment({ GH_TOKEN: token }), [], {
    execute: (binary, args, options) => {
      calls.push(args[0]);
      assert.equal(binary, 'docker');
      assert.equal(args[0], 'login', 'denied metadata must prevent build and push');
      assert.equal(options.input, token);
      auth = options.env.DOCKER_CONFIG;
    },
    request: async (_url, options) => {
      calls.push('metadata');
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      return new Response('{}', { status: 403 });
    },
  }).then(
    () => assert.fail('denied metadata must refuse admission'),
    (error) => error,
  );
  assert.equal(diagnostic.stage, 'metadata-before');
  assert.equal(diagnostic.code, 'UNVERIFIED');
  assert.deepEqual(calls, ['login', 'metadata']);
  assert.equal(existsSync(auth), false);
  assert.equal(bootstrapFailureMessage(diagnostic).includes(token), false);
});

test('cleanup failures retain existing precedence and expose only their fixed stage', () => {
  for (const stage of ['seed-cleanup', 'auth-cleanup']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { runBootstrap, bootstrapFailureMessage } from ${JSON.stringify(pathToFileURL(resolve('scripts/ci/registry-bootstrap.mjs')).href)};
      const remove = fs.rmSync;
      const directories = new Set();
      fs.rmSync = (directory, options) => {
        remove(directory, options);
        if (directory.includes(${JSON.stringify(stage === 'seed-cleanup' ? 'maxim-inert-registry-seed-' : 'maxim-bootstrap-auth-')})) throw new Error('synthetic-private-cleanup-output');
      };
      syncBuiltinESMExports();
      const error = await runBootstrap(${JSON.stringify(environment({ GH_TOKEN: 'x'.repeat(40) }))}, [], {
        execute: (_binary, args, options) => {
          directories.add(options.env.DOCKER_CONFIG);
          if (args[0] === 'build') {
            directories.add(args.at(-1));
            throw new Error('synthetic-private-build-output');
          }
        },
        request: async () => new Response('{}', { status: 404 }),
      }).then(() => assert.fail('expected refusal'), (failure) => failure);
      assert.ok([...directories].every((directory) => !fs.existsSync(directory)));
      process.stdout.write(bootstrapFailureMessage(error));
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      `Registry bootstrap stopped; private package admission did not pass (stage=${stage}, code=INTERNAL).\n`,
    );
  }
});

test('an existing private package still produces the same receipt after login and one lookup', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-bootstrap-receipt-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { runBootstrap } from ${JSON.stringify(pathToFileURL(resolve('scripts/ci/registry-bootstrap.mjs')).href)};
    let auth;
    const calls = [];
    const result = await runBootstrap(${JSON.stringify(environment({ GH_TOKEN: 'x'.repeat(40) }))}, [], {
      execute: (_binary, args, options) => { auth = options.env.DOCKER_CONFIG; calls.push(args[0]); },
      request: async () => { calls.push('metadata'); return new Response(${JSON.stringify(JSON.stringify(response().body))}, { status: 200 }); },
    });
    assert.deepEqual(calls, ['login', 'metadata']);
    assert.equal(existsSync(auth), false);
    assert.equal(result.action, 'ALREADY_PRIVATE');
  `,
    ],
    { cwd: directory, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const receipt = join(directory, 'registry-bootstrap-api.json');
  assert.equal(statSync(receipt).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), {
    schemaVersion: 1,
    component: 'api',
    package: 'ghcr.io/gameclubpro/major-maksimov-release-api',
    action: 'ALREADY_PRIVATE',
    visibility: 'private',
    sourceSha: expected.sha,
    runId: '123',
    runAttempt: '1',
  });
});

test('bootstrap accepts only its dedicated explicit trusted main GitHub-hosted invocation', () => {
  assert.deepEqual(bootstrapContext(environment()), expected);
  for (const patch of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_WORKFLOW_REF: `${expected.repository}/.github/workflows/ci.yml@refs/heads/main` },
    { GITHUB_REPOSITORY: 'other/repository' },
    { GITHUB_REPOSITORY_ID: '1' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { MAXIM_IMAGE_COMPONENT: 'unknown' },
    { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_RUN_ID: '' },
  ])
    assert.throws(() => bootstrapContext(environment(patch)));
});

test('existing positively private bound package is idempotent and performs no registry writes', async () => {
  let reads = 0;
  const result = await bootstrapPrivatePackage(expected, {
    getPackage: async () => {
      reads++;
      return response();
    },
    run: () => assert.fail('no Docker operation needed'),
  });
  assert.equal(result.action, 'ALREADY_PRIVATE');
  assert.equal(reads, 1);
});

test('denied, unavailable, malformed and known public metadata cannot cause a bootstrap write', async () => {
  for (const reply of [
    { status: 403 },
    { status: 500 },
    null,
    { status: 200, body: null },
    response({ visibility: 'public' }),
    response({ visibility: 'internal' }),
    response({ repository: { id: 1, full_name: expected.repository } }),
  ])
    await assert.rejects(
      bootstrapPrivatePackage(expected, {
        getPackage: async () => reply,
        run: () => assert.fail('must not write'),
      }),
    );
});

test('only an inert isolated scratch context and a reserved seed tag may cross a 404 bootstrap boundary', async () => {
  const calls = [];
  let reads = 0;
  let contextDirectory;
  const result = await bootstrapPrivatePackage(expected, {
    getPackage: async (name) => {
      assert.equal(name, 'major-maksimov-release-api');
      return ++reads === 1 ? { status: 404 } : response();
    },
    run: (binary, args) => {
      calls.push([binary, args]);
      assert.equal(binary, 'docker');
      assert.ok(
        args.includes('ghcr.io/gameclubpro/major-maksimov-release-api:bootstrap-private-v1'),
      );
      assert.equal(
        args.some((argument) => argument.includes(expected.sha) || argument.includes('maxim-api:')),
        false,
      );
      if (args[0] === 'build') {
        contextDirectory = args.at(-1);
        assert.notEqual(resolve(contextDirectory), process.cwd());
        assert.deepEqual(readdirSync(contextDirectory), ['Dockerfile']);
        assert.equal(readFileSync(`${contextDirectory}/Dockerfile`, 'utf8'), seedDockerfile());
        assert.match(seedDockerfile(), /^FROM scratch\n/u);
        assert.doesNotMatch(seedDockerfile(), /(?:^|\n)(?:COPY|ADD|RUN|CMD|ENTRYPOINT)\s/u);
      }
    },
  });
  assert.equal(result.action, 'PRIVATE_SEED_VERIFIED');
  assert.equal(calls.length, 2);
  assert.equal(existsSync(contextDirectory), false);
  assert.equal(reads, 2);
});

test('a seed with failed or public post-push metadata never becomes accepted application proof', async () => {
  for (const after of [{ status: 404 }, { status: 403 }, response({ visibility: 'public' })]) {
    let reads = 0;
    const calls = [];
    await assert.rejects(
      bootstrapPrivatePackage(expected, {
        getPackage: async () => (++reads === 1 ? { status: 404 } : after),
        run: (_binary, args) => calls.push(args),
      }),
    );
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['build', 'image'],
    );
    assert.equal(
      calls.some((args) => args.includes('tag')),
      false,
    );
  }
});

test('bootstrap workflow has no PR/push trigger, runner option, release attestation or production access', () => {
  const workflow = parse(readFileSync(BOOTSTRAP_WORKFLOW, 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const job = workflow.jobs.seed;
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(job.strategy.matrix.component, ['api', 'miniapp', 'admin', 'eraser']);
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  assert.equal(commands.trim(), 'node scripts/ci/registry-bootstrap.mjs');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.doesNotMatch(
    readFileSync(BOOTSTRAP_WORKFLOW, 'utf8'),
    /(?:id-token:|attestations:|ssh |vps-connect|preload-ci-image)/u,
  );
});
