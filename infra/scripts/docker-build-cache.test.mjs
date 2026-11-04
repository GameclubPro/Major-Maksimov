import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CI_LANES, ciOutputs } from '../../scripts/ci/impact.mjs';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('keeps npm downloads out of immutable Docker dependency layers', () => {
  for (const path of ['apps/api/Dockerfile', 'apps/miniapp/Dockerfile', 'apps/admin/Dockerfile']) {
    const dockerfile = read(path);
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7$/mu);
    assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm,sharing=locked/u);
  }
});

test('builds API production dependencies before copying runtime source', () => {
  const dockerfile = read('apps/api/Dockerfile');
  const prodDependencies = dockerfile.indexOf('FROM manifests AS prod-deps');
  const buildStage = dockerfile.indexOf('FROM manifests AS build');
  const apiSource = dockerfile.indexOf('COPY apps/api apps/api');

  assert.notEqual(prodDependencies, -1);
  assert.notEqual(buildStage, -1);
  assert.notEqual(apiSource, -1);
  assert.ok(prodDependencies < buildStage);
  assert.ok(prodDependencies < apiSource);
  const prodStage = dockerfile.slice(prodDependencies, buildStage);
  const prepareRemoval = prodStage.indexOf('npm pkg delete scripts.prepare');
  const prodInstall = prodStage.indexOf('npm ci --omit=dev');

  assert.notEqual(prepareRemoval, -1);
  assert.notEqual(prodInstall, -1);
  assert.ok(prepareRemoval < prodInstall);
  assert.match(
    prodStage,
    /npm ci --omit=dev --workspace @maxim\/api --workspace @maxim\/contracts/u,
  );
  const optionalWorkspaceDirectories = prodStage.indexOf(
    'mkdir -p apps/api/node_modules packages/contracts/node_modules',
  );
  assert.ok(optionalWorkspaceDirectories > prodInstall);
  for (const workspace of ['apps/api', 'packages/contracts']) {
    assert.ok(
      dockerfile.includes(
        `COPY --from=prod-deps /app/${workspace}/node_modules ./${workspace}/node_modules`,
      ),
    );
  }
  assert.doesNotMatch(prodStage, /--ignore-scripts/u);
  assert.doesNotMatch(dockerfile, /npm prune/u);
});

test('packages exact-SHA main images for reuse-only production deploys', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /org\.opencontainers\.image\.revision="\$\{\{ github\.sha \}\}"/u);
  assert.match(workflow, /docker image save "\$IMAGE_REF" \| gzip -1/u);
  assert.match(workflow, /sha256sum maxim-image\.tar\.gz/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /github\.event_name == 'push'/u);
  assert.match(workflow, /\{\{json \.RootFS\.Layers\}\}/u);
  assert.match(workflow, /maxim-image-layers\.json/u);
});

test('production build cache is scoped to trusted main and exact dependency inputs', () => {
  const workflow = read('.github/workflows/ci.yml');
  const start = workflow.indexOf('      - name: Restore trusted dependency build cache');
  const end = workflow.indexOf('      - name: Create isolated image builder', start);
  const cacheStep = workflow.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(
    cacheStep,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u,
  );
  assert.match(cacheStep, /actions\/cache@[0-9a-f]{40}/u);
  assert.match(cacheStep, /main-v1-\$\{\{ matrix\.component \}\}.*amd64/u);
  for (const input of ['package-lock.json', 'matrix.dockerfile', 'infra/certs/*.pem']) {
    assert.ok(cacheStep.includes(input), input);
  }
  assert.doesNotMatch(cacheStep, /restore-keys:/u);
  assert.match(workflow, /--driver docker-container --use/u);
  assert.match(workflow, /--platform linux\/amd64/u);
});

test('build step never imports or exports main cache for untrusted jobs', () => {
  const workflow = read('.github/workflows/ci.yml');
  const start = workflow.indexOf('      - name: Build ${{ matrix.component }} image');
  const bodyStart = workflow.indexOf('        run: |\n', start) + '        run: |\n'.length;
  const end = workflow.indexOf('      - name: Smoke native OCR', bodyStart);
  const body = workflow.slice(bodyStart, end).replace(/^ {10}/gmu, '');
  const temp = mkdtempSync(join(tmpdir(), 'maxim-cache-trust-'));
  try {
    const bin = join(temp, 'bin');
    const cachePath = join(temp, 'cache');
    mkdirSync(bin);
    mkdirSync(cachePath);
    writeFileSync(join(cachePath, 'index.json'), '{}');
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    chmodSync(join(bin, 'docker'), 0o755);
    // Substitute only immutable workflow expressions so Bash executes the real cache branch.
    const executable = body
      .replace(/\$\{\{ github\.sha \}\}/gu, 'a'.repeat(40))
      .replace(/\$\{\{ matrix\.dockerfile \}\}/gu, 'apps/api/Dockerfile');
    const runBuild = (trusted) =>
      spawnSync('bash', ['-euo', 'pipefail', '-c', executable], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TRUSTED_BUILD_CACHE: trusted,
          BUILD_CACHE_PATH: cachePath,
          VITE_API_BASE: '',
          IMAGE_REF: 'maxim-api:test',
        },
      });
    const untrusted = runBuild('false');
    assert.equal(untrusted.status, 0, untrusted.stderr);
    assert.doesNotMatch(untrusted.stdout, /--cache-from|--cache-to/u);
    const hit = runBuild('true');
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /--cache-from/u);
    assert.doesNotMatch(hit.stdout, /--cache-to/u);
    rmSync(join(cachePath, 'index.json'));
    const miss = runBuild('true');
    assert.equal(miss.status, 0, miss.stderr);
    assert.match(miss.stdout, /--cache-to/u);
    assert.match(miss.stdout, /mode=max/u);
    assert.doesNotMatch(miss.stdout, /--cache-from/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('bakes the production API URL into only the Major mini app image', () => {
  const workflow = read('.github/workflows/ci.yml');
  const dockerJobStart = workflow.indexOf('  docker:\n');
  const dockerJobEnd = workflow.indexOf('\n  required:', dockerJobStart);

  assert.notEqual(dockerJobStart, -1);
  assert.notEqual(dockerJobEnd, -1);
  const dockerJob = workflow.slice(dockerJobStart, dockerJobEnd);
  const matrix = JSON.parse(
    ciOutputs({
      lanes: Object.fromEntries(CI_LANES.map((lane) => [lane, true])),
      dockerComponents: ['eraser', 'api', 'miniapp', 'admin'],
    }).docker_matrix,
  ).include;
  assert.deepEqual(
    matrix.map(({ component, vite_api_base }) => [component, vite_api_base]),
    [
      ['eraser', ''],
      ['api', ''],
      ['miniapp', 'https://major-maksimov.ru/api/v1'],
      ['admin', ''],
    ],
  );
  assert.match(dockerJob, /matrix: \$\{\{ fromJSON\(needs\.impact\.outputs\.docker_matrix\) \}\}/u);
  assert.match(dockerJob, /VITE_API_BASE: \$\{\{ matrix\.vite_api_base \}\}/u);
  assert.match(dockerJob, /build_args=\(--build-arg "COMMIT_SHA=\$\{\{ github\.sha \}\}"\)/u);
  assert.match(dockerJob, /if \[\[ -n "\$VITE_API_BASE" \]\]; then/u);
  assert.match(dockerJob, /build_args\+=\(--build-arg "VITE_API_BASE=\$VITE_API_BASE"\)/u);
  assert.match(dockerJob, /"\$\{build_args\[@\]\}"/u);
  const buildArgsStart = dockerJob.indexOf('          build_args=');
  const buildArgsEnd = dockerJob.indexOf('          cache_args=()', buildArgsStart);
  assert.notEqual(buildArgsStart, -1);
  assert.notEqual(buildArgsEnd, -1);
  const revision = 'a'.repeat(40);
  const buildArgs = dockerJob
    .slice(buildArgsStart, buildArgsEnd)
    .replace(/\$\{\{ github\.sha \}\}/gu, revision);
  for (const { component, vite_api_base } of matrix) {
    const result = spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', `${buildArgs}\nprintf '%s\\n' "\${build_args[@]}"`],
      { encoding: 'utf8', env: { ...process.env, VITE_API_BASE: vite_api_base } },
    );
    assert.equal(result.status, 0, `${component}: ${result.stderr}`);
    assert.deepEqual(
      result.stdout.trim().split('\n'),
      [
        '--build-arg',
        `COMMIT_SHA=${revision}`,
        ...(vite_api_base ? ['--build-arg', `VITE_API_BASE=${vite_api_base}`] : []),
      ],
      component,
    );
  }
});

test('runs the compiled native OCR raster smoke through an isolated UDS sidecar', () => {
  const workflow = read('.github/workflows/ci.yml');
  const apiDockerfile = read('apps/api/Dockerfile');
  const smoke = workflow.indexOf('Smoke native OCR in API image');
  const packaging = workflow.indexOf('Package immutable production image');

  assert.notEqual(smoke, -1);
  assert.notEqual(packaging, -1);
  assert.ok(smoke < packaging);
  assert.match(apiDockerfile, /^LABEL com\.maxim\.ocr-native-sandbox-capable="true"$/mu);
  assert.match(apiDockerfile, /mkdir -p \/run\/maxim-ocr/u);
  const smokeStep = workflow.slice(smoke, packaging);
  assert.match(smokeStep, /if: matrix\.component == 'api'/u);
  assert.match(smokeStep, /docker volume create "\$socket_volume"/u);
  assert.match(smokeStep, /docker run -d --name "\$sandbox_name"/u);
  assert.match(smokeStep, /--network none/u);
  assert.match(smokeStep, /--label com\.maxim\.ocr-native-sandbox=true/u);
  assert.match(smokeStep, /--user 1000:1000/u);
  assert.match(smokeStep, /--cap-drop ALL/u);
  assert.match(smokeStep, /--memory 1g/u);
  assert.match(smokeStep, /--cpus 1/u);
  assert.match(smokeStep, /--tmpfs '\/tmp:rw,nosuid,size=64m,uid=1000,gid=1000'/u);
  assert.match(smokeStep, /--mount "type=volume,source=\$socket_volume,target=\/run\/maxim-ocr"/u);
  assert.match(smokeStep, /target=\/run\/maxim-ocr,readonly/u);
  assert.match(smokeStep, /--env APP_SERVICE_NAME=api-media-analysis/u);
  assert.match(smokeStep, /--env APP_ROLE=moderation/u);
  assert.match(smokeStep, /COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH="\$socket_path"/u);
  assert.match(smokeStep, /native-ocr-sandbox\.entrypoint\.js/u);
  assert.match(smokeStep, /"\$entrypoint" --probe/u);
  assert.match(smokeStep, /docker top "\$sandbox_name" -eo pid,comm/u);
  assert.match(
    smokeStep,
    /apps\/api\/dist\/apps\/api\/src\/scripts\/smoke-commercial-ocr-worker\.js/u,
  );
});

test('registry preload uses the proof gate and protected server pull without archive or build fallback', () => {
  const connect = read('infra/scripts/vps-connect.sh');
  const start = connect.indexOf('preload_ci_image() (');
  const end = connect.indexOf('\ndeploy_scale() {', start);
  const preload = connect.slice(start, end);
  assert.match(preload, /node infra\/scripts\/registry-preload\.mjs/u);
  assert.match(preload, /--prepare-missing/u);
  assert.match(preload, /source infra\/scripts\/lib\/deploy-lock\.sh/u);
  assert.match(preload, /acquire_deploy_lock/u);
  assert.match(preload, /require_deploy_lock/u);
  assert.match(preload, /node infra\/scripts\/registry-preload-host\.mjs pull/u);
  assert.doesNotMatch(preload, /docker (?:image load|build|.*prune)|maxim-image\.tar/u);
});
