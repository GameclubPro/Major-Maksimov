import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  BOOTSTRAP_WORKFLOW,
  bootstrapContext,
  bootstrapPrivatePackage,
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
