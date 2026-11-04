import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  preloadRegistryImage,
  receiptPath,
  registryArtifactName,
  validatePreloadRequest,
  verifyPreloadedImage,
} from './registry-preload-host.mjs';

const sha = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;
const digest = `sha256:${'c'.repeat(64)}`;
const now = Date.parse('2026-11-04T03:00:00Z');

export function preloadFixture(component = 'api') {
  const alias = {
    api: 'maxim-api',
    miniapp: 'maxim-miniapp-major',
    admin: 'maxim-admin',
    eraser: 'maxim-eraser',
  }[component];
  const record = {
    schemaVersion: 1,
    component,
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runId: '123',
      runAttempt: '2',
      runnerEnvironment: 'github-hosted',
      event: 'push',
    },
    image: { alias: `${alias}:${sha}`, imageId, platform: 'linux/amd64', sizeBytes: 123456 },
    registry: { repository: `ghcr.io/gameclubpro/major-maksimov-release-${component}`, digest },
  };
  return {
    schemaVersion: 1,
    record,
    artifact: { id: 456, name: registryArtifactName(record), digest: `sha256:${'d'.repeat(64)}` },
    verifiedAt: new Date(now).toISOString(),
  };
}

function withHost(
  callback,
  {
    component = 'api',
    inspectionPatch = {},
    previous = null,
    token = 'fixture_token_not_a_real_secret_123456',
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-registry-host-test-'));
  const credentialFile = join(directory, 'credential.json');
  const stateDir = join(directory, 'state');
  writeFileSync(credentialFile, JSON.stringify({ username: 'deploy-user', token }), {
    mode: 0o600,
  });
  const request = preloadFixture(component);
  const calls = [];
  let alias = previous;
  const inspection = {
    Id: imageId,
    Os: 'linux',
    Architecture: 'amd64',
    Size: request.record.image.sizeBytes,
    Config: {
      Labels: { 'org.opencontainers.image.revision': sha, 'com.maxim.release-protected': 'true' },
    },
    ...inspectionPatch,
  };
  const options = {
    sha,
    component,
    stateDir,
    credentialFile,
    now,
    availableBytes: 30 * 1024 ** 3,
    runCommand(binary, args, input = {}) {
      calls.push({ binary, args, options: input });
      assert.equal(binary, 'docker');
      if (args[0] === 'login') {
        assert.equal(input.input, token);
        return 'Login Succeeded';
      }
      if (args[1] === 'pull') return 'pulled';
      if (args[1] === 'inspect') {
        if (args[2] === request.record.image.alias) {
          if (!alias && input.allowMissingImage) return null;
          assert.ok(alias, 'unexpected missing alias inspection');
          return JSON.stringify([alias]);
        }
        assert.equal(args[2], `${request.record.registry.repository}@${digest}`);
        return JSON.stringify([inspection]);
      }
      if (args[1] === 'tag') {
        alias = inspection;
        return '';
      }
      throw new Error(`Unexpected Docker command ${args.join(' ')}`);
    },
  };
  try {
    callback({ request, options, calls, directory, credentialFile, stateDir });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('pulls the immutable digest, preserves distinct config ID and writes a bound receipt after validation', () => {
  withHost(({ request, options, calls, stateDir }) => {
    const reference = preloadRegistryImage(request, options);
    assert.equal(reference, `${request.record.registry.repository}@${digest}`);
    const receipt = verifyPreloadedImage({
      stateDir,
      component: 'api-shared',
      sha,
      imageRef: request.record.image.alias,
      imageId,
    });
    assert.equal(receipt.record.image.imageId, imageId);
    assert.equal(receipt.record.registry.digest, digest);
    assert.deepEqual(receipt.artifact, request.artifact);
    const pull = calls.findIndex(({ args }) => args[1] === 'pull');
    const tag = calls.findIndex(({ args }) => args[1] === 'tag');
    assert.ok(pull >= 0 && tag > pull);
    assert.deepEqual(calls[tag].args, ['image', 'tag', reference, request.record.image.alias]);
    for (const call of calls) {
      assert.ok(['login', 'image'].includes(call.args[0]));
      assert.equal(
        existsSync(call.options.env.DOCKER_CONFIG),
        false,
        'temporary registry credentials survive completion',
      );
    }
  });
});

test('keeps API and static rollout reserves while admitting compressed and extracted pull storage', () => {
  for (const component of ['api', 'admin']) {
    withHost(
      ({ request, options, calls }) => {
        const required =
          (component === 'api' ? 10 : 6) * 1024 ** 3 + 2 * request.record.image.sizeBytes;
        assert.throws(
          () => preloadRegistryImage(request, { ...options, availableBytes: required - 1 }),
          /capacity refused/u,
        );
        assert.equal(calls.length, 0);
        assert.doesNotThrow(() =>
          preloadRegistryImage(request, { ...options, availableBytes: required }),
        );
      },
      { component },
    );
  }
});

test('rejects wrong image identity, platform, source labels and size before assigning any SHA alias', () => {
  for (const inspectionPatch of [
    { Id: `sha256:${'e'.repeat(64)}` },
    { Os: 'windows' },
    { Architecture: 'arm64' },
    { Size: 123457 },
    {
      Config: {
        Labels: {
          'org.opencontainers.image.revision': sha,
          'com.maxim.release-protected': 'false',
        },
      },
    },
  ]) {
    withHost(
      ({ request, options, calls, stateDir }) => {
        assert.throws(() => preloadRegistryImage(request, options), /image|Image/u);
        assert.equal(
          calls.some(({ args }) => args[1] === 'tag'),
          false,
        );
        assert.equal(existsSync(receiptPath(stateDir, 'api-shared', sha)), false);
        for (const call of calls) assert.equal(existsSync(call.options.env.DOCKER_CONFIG), false);
      },
      { inspectionPatch },
    );
  }
});

test('an existing immutable alias with another config ID is preserved', () => {
  withHost(
    ({ request, options, calls }) => {
      assert.throws(() => preloadRegistryImage(request, options), /refusing overwrite/u);
      assert.equal(
        calls.some(({ args }) => ['tag', 'rm'].includes(args[1])),
        false,
      );
    },
    { previous: { Id: `sha256:${'f'.repeat(64)}` } },
  );
});

test('identical accepted pulls can be repeated without changing runtime or alias identity', () => {
  withHost(({ request, options, stateDir }) => {
    preloadRegistryImage(request, options);
    preloadRegistryImage(request, options);
    const receipt = JSON.parse(readFileSync(receiptPath(stateDir, 'api-shared', sha), 'utf8'));
    assert.equal(receipt.record.image.imageId, imageId);
  });
});

test('fresh requests bind the exact artifact/run attempt and repository', () => {
  for (const mutate of [
    (value) => {
      value.record.source.runAttempt = '3';
    },
    (value) => {
      value.record.source.repositoryId = '999';
    },
    (value) => {
      value.record.image.sizeBytes = 64 * 1024 ** 3 + 1;
    },
    (value) => {
      value.record.registry.repository = 'ghcr.io/other/image';
    },
    (value) => {
      value.record.registry.repository = 'ghcr.io/gameclubpro/major-maksimov-api';
    },
    (value) => {
      value.verifiedAt = new Date(now - 30 * 60_000 - 1).toISOString();
    },
    (value) => {
      value.verifiedAt = new Date(now + 120_001).toISOString();
    },
  ]) {
    const value = preloadFixture();
    mutate(value);
    assert.throws(() => validatePreloadRequest(value, { sha, component: 'api', now }));
  }
});

test('read credentials must be a private regular file; unsafe files trigger no Docker call', () => {
  for (const symlink of [false, true]) {
    withHost(({ request, options, calls, credentialFile }) => {
      if (symlink) {
        const original = `${credentialFile}.target`;
        writeFileSync(original, '{}', { mode: 0o600 });
        rmSync(credentialFile);
        symlinkSync(original, credentialFile);
      } else chmodSync(credentialFile, 0o644);
      assert.throws(() => preloadRegistryImage(request, options), /private regular file/u);
      assert.equal(calls.length, 0);
    });
  }
});

test('host preload accepts opaque printable credentials unchanged and removes temporary auth', () => {
  for (const token of ['x', `synthetic.header-${'x'.repeat(300)}.signature=`, 'x'.repeat(4096)]) {
    withHost(
      ({ request, options, calls }) => {
        preloadRegistryImage(request, options);
        assert.equal(calls[0].options.input, token);
        assert.equal(existsSync(calls[0].options.env.DOCKER_CONFIG), false);
      },
      { token },
    );
  }
});

test('host credential refusals never print supplied content or call Docker', () => {
  const marker = 'private-credential-content';
  for (const content of [
    `{"${marker}"`,
    ...[
      null,
      {},
      '',
      'x'.repeat(4097),
      `${marker}\n`,
      `${marker}\0`,
      `${marker}\x7f`,
      `${marker}é`,
    ].map((token) => JSON.stringify({ username: 'deploy-user', token })),
  ]) {
    withHost(({ request, options, calls, credentialFile }) => {
      writeFileSync(credentialFile, content);
      assert.throws(
        () => preloadRegistryImage(request, options),
        (error) => {
          assert.match(error.message, /Invalid read-only GHCR credential configuration/u);
          assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(marker), false);
          return true;
        },
      );
      assert.equal(calls.length, 0);
    });
  }
});

test('host Docker inspection decoding refuses raw content before aliases or receipts', () => {
  const marker = 'private-docker-response';
  for (const [output, reason] of [
    [`{"${marker}"`, 'INSPECTION_JSON_INVALID'],
    ['[]', 'INSPECTION_CARDINALITY'],
  ]) {
    withHost(({ request, options, calls, stateDir }) => {
      assert.throws(
        () =>
          preloadRegistryImage(request, {
            ...options,
            runCommand(binary, args, settings) {
              return args[1] === 'inspect' ? output : options.runCommand(binary, args, settings);
            },
          }),
        (error) => {
          assert.equal(error.code, 'IMAGE_INSPECTION_REFUSED');
          assert.equal(error.reason, reason);
          assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(marker), false);
          return true;
        },
      );
      assert.equal(
        calls.some(({ args }) => args[1] === 'tag'),
        false,
      );
      assert.equal(existsSync(receiptPath(stateDir, 'api-shared', sha)), false);
      assert.equal(existsSync(calls[0].options.env.DOCKER_CONFIG), false);
    });
  }
});

test('receipt verification rejects a replaced alias or changed evidence and preserves legacy filesystem boundaries', () => {
  withHost(({ request, options, stateDir }) => {
    preloadRegistryImage(request, options);
    assert.throws(
      () =>
        verifyPreloadedImage({
          stateDir,
          component: 'api-shared',
          sha,
          imageRef: request.record.image.alias,
          imageId: digest,
        }),
      /does not match/u,
    );
    const path = receiptPath(stateDir, 'api-shared', sha);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    receipt.record.source.runAttempt = '4';
    writeFileSync(path, JSON.stringify(receipt));
    assert.throws(() =>
      verifyPreloadedImage({
        stateDir,
        component: 'api-shared',
        sha,
        imageRef: request.record.image.alias,
        imageId,
      }),
    );
    assert.throws(() => receiptPath(stateDir, '../outside', sha));
  });
});

test('receipt directory symlinks cannot redirect durable release evidence', () => {
  withHost(({ request, options, stateDir, directory }) => {
    mkdirSync(stateDir);
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(stateDir, 'registry-images'));
    assert.throws(() => preloadRegistryImage(request, options), /receipt directory/u);
    assert.equal(existsSync(join(outside, `api-shared-${sha}.json`)), false);
  });
});
