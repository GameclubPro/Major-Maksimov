import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  localBootstrapFailureMessage,
  parseLocalBootstrapArguments,
  runLocalBootstrap,
} from './registry-bootstrap-local.mjs';
import { seedDockerfile } from './registry-bootstrap.mjs';

const repository = 'GameclubPro/Major-Maksimov';
const packageName = 'major-maksimov-private-v1-api';
const target = `ghcr.io/gameclubpro/${packageName}`;
const token = 'synthetic.owner.credential-with-punctuation=';
const owner = { id: 12345, login: 'GameclubPro', type: 'User' };
const repo = { id: 1168895008, full_name: repository, owner };
const metadata = () => ({
  name: packageName,
  package_type: 'container',
  visibility: 'private',
  repository: { id: repo.id, full_name: repository },
});
const reply = (status, body) => ({ status, body: [Buffer.from(JSON.stringify(body))] });

async function fixture(
  callback,
  {
    packages = [reply(404, {}), reply(200, metadata())],
    user = owner,
    source = repo,
    failure,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-local-bootstrap-test-'));
  const credentialFile = join(directory, 'owner.json');
  writeFileSync(credentialFile, JSON.stringify({ username: 'GameclubPro', token }), {
    mode: 0o600,
  });
  const reads = [],
    calls = [],
    authDirectories = [],
    seedDirectories = [];
  let packageReads = 0;
  const dependencies = {
    temporaryRoot: directory,
    request: async (url, options) => {
      reads.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.ok(options.signal instanceof AbortSignal);
      if (url === 'https://api.github.com/user') return reply(200, user);
      if (url === `https://api.github.com/repos/${repository}`) return reply(200, source);
      assert.equal(
        url,
        `https://api.github.com/users/GameclubPro/packages/container/${packageName}`,
      );
      return packages[packageReads++];
    },
    execute: (binary, args, options) => {
      calls.push(args);
      assert.equal(binary, 'docker');
      assert.equal(options.timeout, 120000);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(statSync(options.env.DOCKER_CONFIG).mode & 0o777, 0o700);
      assert.deepEqual(Object.keys(options.env).sort(), [
        'DOCKER_BUILDKIT',
        'DOCKER_CONFIG',
        'LANG',
        'LC_ALL',
        'PATH',
      ]);
      authDirectories.push(options.env.DOCKER_CONFIG);
      if (args[0] === 'login') {
        assert.deepEqual(args, [
          'login',
          'ghcr.io',
          '--username',
          'GameclubPro',
          '--password-stdin',
        ]);
        assert.equal(options.input, token);
        writeFileSync(join(options.env.DOCKER_CONFIG, 'config.json'), token, { mode: 0o600 });
      } else {
        assert.equal(options.input, undefined);
        assert.ok(args.includes(`${target}:bootstrap-private-v1`));
        if (args[0] === 'build') {
          const context = args.at(-1);
          seedDirectories.push(context);
          assert.deepEqual(readdirSync(context), ['Dockerfile']);
          assert.equal(readFileSync(join(context, 'Dockerfile'), 'utf8'), seedDockerfile());
          assert.deepEqual(args.slice(0, 4), ['build', '--no-cache', '--network=none', '--tag']);
        } else assert.deepEqual(args, ['image', 'push', `${target}:bootstrap-private-v1`]);
      }
      if (failure === args[0]) throw new Error(`private-dependency-content ${token}`);
      return 'private subprocess output must never be returned';
    },
  };
  const args = ['--component', 'api', '--credential-file', credentialFile, '--apply'];
  try {
    await callback({
      directory,
      credentialFile,
      dependencies,
      args,
      reads,
      calls,
      authDirectories,
      seedDirectories,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('local preview covers only finite targets and reads no credential, network or subprocess', async () => {
  for (const component of ['api', 'miniapp', 'admin', 'eraser']) {
    const result = await runLocalBootstrap(
      {},
      ['--component', component, '--credential-file', '/missing/credential.json'],
      {
        readCredential: () => assert.fail('preview read a credential'),
        request: () => assert.fail('preview made a request'),
        execute: () => assert.fail('preview executed a command'),
      },
    );
    assert.equal(result.mode, 'PREVIEW');
    assert.equal(result.writes, false);
    assert.equal(result.package, `ghcr.io/gameclubpro/major-maksimov-private-v1-${component}`);
    assert.equal(result.workflowAccess, 'UNVERIFIED');
  }
  const process = spawnSync(
    globalThis.process.execPath,
    [
      'scripts/ci/registry-bootstrap-local.mjs',
      '--component',
      'api',
      '--credential-file',
      '/missing/credential.json',
    ],
    { env: { PATH: globalThis.process.env.PATH }, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(process.status, 0);
  assert.equal(process.stderr, '');
  assert.equal(JSON.parse(process.stdout).writes, false);
});

test('unreviewed options, duplicate flags and GitHub Actions cannot invoke local provisioning', async () => {
  for (const args of [
    [],
    ['--component', 'postgres', '--credential-file', '/safe.json'],
    ['--component', 'api', '--credential-file', 'relative.json'],
    ['--component', 'api', '--credential-file', '/safe.json', '--component', 'admin'],
    ['--component', 'api', '--credential-file', '/safe.json', '--apply', '--apply'],
    ['--component', 'api', '--credential-file', '/safe.json', '--namespace', 'other'],
  ])
    assert.throws(() => parseLocalBootstrapArguments(args));
  await fixture(async ({ args }) => {
    for (const GITHUB_ACTIONS of ['true', 'false', ''])
      await assert.rejects(
        runLocalBootstrap({ GITHUB_ACTIONS }, args, {
          readCredential: () => assert.fail('Actions read local credential'),
        }),
        { stage: 'context', code: 'REFUSED' },
      );
  });
});

test('private owner credential drives only an inert seed and all temporary authentication is removed', async () => {
  await fixture(async ({ dependencies, args, calls, reads, authDirectories, seedDirectories }) => {
    const result = await runLocalBootstrap(
      {
        GH_TOKEN: 'forbidden-control-token',
        GITHUB_TOKEN: 'forbidden-control-token',
        DOCKER_CONFIG: '/private/user-config',
      },
      args,
      dependencies,
    );
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['login', 'build', 'image'],
    );
    assert.equal(reads.length, 4);
    assert.deepEqual(result, {
      schemaVersion: 1,
      mode: 'APPLIED',
      component: 'api',
      package: target,
      action: 'PRIVATE_SEED_VERIFIED',
      visibility: 'private',
      workflowAccess: 'UNVERIFIED',
    });
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(Object.hasOwn(result, 'sourceSha'), false);
    for (const path of [...authDirectories, ...seedDirectories])
      assert.equal(existsSync(path), false);
  });
});

test('already private and exactly bound packages require no Docker login, build or push', async () => {
  await fixture(
    async ({ dependencies, args, calls, reads, directory }) => {
      const result = await runLocalBootstrap({}, args, dependencies);
      assert.equal(result.action, 'ALREADY_PRIVATE');
      assert.equal(result.workflowAccess, 'UNVERIFIED');
      assert.equal(calls.length, 0);
      assert.equal(reads.length, 3);
      assert.deepEqual(readdirSync(directory), ['owner.json']);
    },
    { packages: [reply(200, metadata())] },
  );
});

test('denied, public, malformed and unbound metadata never trigger Docker or an accepted result', async () => {
  for (const response of [
    reply(403, {}),
    reply(500, {}),
    reply(200, null),
    reply(200, { ...metadata(), visibility: 'public' }),
    reply(200, { ...metadata(), repository: { id: 1, full_name: repository } }),
    reply(200, { ...metadata(), name: 'other-package' }),
  ]) {
    await fixture(
      async ({ dependencies, args, calls, directory }) => {
        await assert.rejects(
          runLocalBootstrap({}, args, dependencies),
          (error) => error.stage === 'metadata-before',
        );
        assert.equal(calls.length, 0);
        assert.deepEqual(readdirSync(directory), ['owner.json']);
      },
      { packages: [response] },
    );
  }
});

test('owner identity and repository ownership must both be proved before any Docker operation', async () => {
  for (const changes of [
    { user: { ...owner, login: 'other-user' } },
    { user: { ...owner, type: 'Bot' } },
    { source: { ...repo, id: 1 } },
    { source: { ...repo, owner: { ...owner, id: 999 } } },
    { source: { ...repo, full_name: 'other/repo' } },
  ]) {
    await fixture(async ({ dependencies, args, calls }) => {
      await assert.rejects(runLocalBootstrap({}, args, dependencies), {
        code: 'IDENTITY_UNVERIFIED',
      });
      assert.equal(calls.length, 0);
    }, changes);
  }
});

test('unsafe local credential files and wrong owners never fall back to control credentials', async () => {
  for (const mutate of [
    (path) => chmodSync(path, 0o644),
    (path) => writeFileSync(path, 'private malformed credential'),
    (path) => writeFileSync(path, JSON.stringify({ username: 'other-user', token })),
    (path) => {
      const saved = `${path}.target`;
      writeFileSync(saved, '{}');
      rmSync(path);
      symlinkSync(saved, path);
    },
    (path) => linkSync(path, `${path}.link`),
    (path) => rmSync(path),
  ]) {
    await fixture(async ({ dependencies, args, credentialFile, reads, calls }) => {
      mutate(credentialFile);
      await assert.rejects(
        runLocalBootstrap({ GH_TOKEN: 'valid-looking-control-token' }, args, dependencies),
        { stage: 'credential', code: 'REGISTRY_CREDENTIAL_INVALID' },
      );
      assert.equal(reads.length, 0);
      assert.equal(calls.length, 0);
    });
  }
});

test('login/build/push failures preserve exact phase, remove credentials and never expose output', async () => {
  for (const [failure, stage] of [
    ['login', 'login'],
    ['build', 'seed-build'],
    ['image', 'seed-push'],
  ]) {
    await fixture(
      async ({ dependencies, args, directory }) => {
        await assert.rejects(runLocalBootstrap({}, args, dependencies), (error) => {
          assert.equal(error.stage, stage);
          assert.equal(error.code, 'DEPENDENCY_FAILED');
          assert.equal(error.cause, undefined);
          assert.equal(
            `${error.stack}${JSON.stringify(error)}${localBootstrapFailureMessage(error)}`.includes(
              token,
            ),
            false,
          );
          return true;
        });
        assert.deepEqual(readdirSync(directory), ['owner.json']);
      },
      { failure },
    );
  }
});

test('post-push public or unavailable metadata never becomes private/workflow acceptance', async () => {
  for (const after of [
    reply(200, { ...metadata(), visibility: 'public' }),
    reply(404, {}),
    reply(403, {}),
  ]) {
    await fixture(
      async ({ dependencies, args, calls, directory }) => {
        await assert.rejects(
          runLocalBootstrap({}, args, dependencies),
          (error) => error.stage === 'metadata-after',
        );
        assert.equal(calls.length, 3);
        assert.deepEqual(readdirSync(directory), ['owner.json']);
      },
      { packages: [reply(404, {}), after] },
    );
  }
});

test('failed authentication cleanup cannot return a private acceptance result or raw filesystem error', async () => {
  await fixture(
    async ({ dependencies, args }) => {
      await assert.rejects(
        runLocalBootstrap({}, args, {
          ...dependencies,
          removeDirectory: () => {
            throw new Error(`private-filesystem-output ${token}`);
          },
        }),
        (error) => {
          assert.equal(error.stage, 'auth-cleanup');
          assert.equal(error.code, 'INTERNAL');
          assert.equal(localBootstrapFailureMessage(error).includes(token), false);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    },
    { packages: [reply(200, metadata())] },
  );
});

test('oversized, invalid UTF-8 and unavailable owner responses refuse with bounded fixed diagnostics', async () => {
  for (const request of [
    async () => {
      throw new Error(`private-provider-output ${token}`);
    },
    async () => ({ status: 200, body: [Buffer.alloc(65537, 120)] }),
    async () => ({ status: 200, body: [Buffer.from([255])] }),
  ]) {
    await fixture(async ({ dependencies, args, calls }) => {
      await assert.rejects(runLocalBootstrap({}, args, { ...dependencies, request }), (error) => {
        assert.equal(error.stage, 'owner-proof');
        assert.equal(error.code, 'IDENTITY_UNVERIFIED');
        assert.equal(localBootstrapFailureMessage(error).includes(token), false);
        return true;
      });
      assert.equal(calls.length, 0);
    });
  }
  assert.equal(localBootstrapFailureMessage({ stage: token, code: token }).includes(token), false);
});
