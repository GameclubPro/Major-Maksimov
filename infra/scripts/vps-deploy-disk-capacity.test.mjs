import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deployScript = read('infra/scripts/vps-pull-build-up.sh');
const runtimeRollbackScript = read('infra/scripts/vps-runtime-rollback.sh');
const immutableRollbackScript = read('infra/scripts/vps-release-rollback.sh');
const scaleDeployScript = read('infra/scripts/vps-pull-build-up-scale.sh');
const migrationNoBuildCompose = read('infra/docker-compose.runtime-no-build.yml');
const diskCapacityLibrary = read('infra/scripts/lib/deploy-disk-capacity.sh');
const apiMinimumFreeBytes = 10 * 1024 ** 3;
const staticMinimumFreeBytes = 6 * 1024 ** 3;

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function readShellFunction(script, name, nextName) {
  const start = script.indexOf(`${name}() {\n`);
  const end = script.indexOf(`\n${nextName}() {`, start);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  assert.notEqual(end, -1, `Missing shell function after ${name}: ${nextName}`);
  return script.slice(start, end);
}

function cleanDiskEnv() {
  const env = { ...process.env };
  for (const name of [
    'MAXIM_ALLOW_CRITICAL_DISK_DEPLOY',
    'MAXIM_DEPLOY_DISK_CRITICAL_PERCENT',
    'MAXIM_DEPLOY_DISK_MAX_PERCENT',
    'MAXIM_DEPLOY_DISK_MIN_FREE_BYTES',
    'MAXIM_DEPLOY_DISK_TARGET_PERCENT',
    'MAXIM_DEPLOY_DISK_WARN_PERCENT',
  ]) {
    delete env[name];
  }
  return env;
}

function runDiskPreflight(
  availableBytes,
  {
    needsApi = 1,
    needsStatic = 0,
    minimumOverride,
    usedPercent = 79,
    emergencyOverride,
    targetPercent,
    criticalPercent,
    reuseOnly = false,
  } = {},
) {
  const env = cleanDiskEnv();
  if (minimumOverride !== undefined) {
    env.MAXIM_DEPLOY_DISK_MIN_FREE_BYTES = String(minimumOverride);
  }
  if (emergencyOverride !== undefined) {
    env.MAXIM_ALLOW_CRITICAL_DISK_DEPLOY = String(emergencyOverride);
  }
  if (targetPercent !== undefined) {
    env.MAXIM_DEPLOY_DISK_TARGET_PERCENT = String(targetPercent);
  }
  if (criticalPercent !== undefined) {
    env.MAXIM_DEPLOY_DISK_CRITICAL_PERCENT = String(criticalPercent);
  }

  const probe = `set -euo pipefail
${diskCapacityLibrary}
df() {
  [[ "$1" == "-P" && "$2" == "-B1" ]]
  printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/fake 107374182400 1 %s %s%% /\\n' "$AVAILABLE_BYTES" "$USED_PERCENT"
}
${reuseOnly ? 'maxim_check_deploy_reuse_disk_capacity' : 'maxim_check_deploy_disk_capacity'} "$NEEDS_API" "$NEEDS_STATIC"
`;

  return spawnSync('bash', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...env,
      AVAILABLE_BYTES: String(availableBytes),
      NEEDS_API: String(needsApi),
      NEEDS_STATIC: String(needsStatic),
      USED_PERCENT: String(usedPercent),
    },
  });
}

function runSelectedImageCapacityPreflight({
  availableBytes,
  expectedSha,
  targetSha = expectedSha,
  services = ['api-ingress'],
  localImages = [],
  apiImage = `maxim-api:${targetSha}`,
  miniappImage = `maxim-miniapp-major:${targetSha}`,
  adminImage = `maxim-admin:${targetSha}`,
  legacyImage = `maxim-miniapp-legacy:${targetSha}`,
  invalidLabelImage = '',
  invalidReceiptImage = '',
  buildApi = services.some((service) => service.startsWith('api-')) ? 1 : 0,
  usedPercent = 79,
  minimumOverride,
  emergencyOverride,
}) {
  const env = cleanDiskEnv();
  if (minimumOverride !== undefined) {
    env.MAXIM_DEPLOY_DISK_MIN_FREE_BYTES = String(minimumOverride);
  }
  if (emergencyOverride !== undefined) {
    env.MAXIM_ALLOW_CRITICAL_DISK_DEPLOY = String(emergencyOverride);
  }
  const probe = `set -euo pipefail
${diskCapacityLibrary}
${readShellFunction(deployScript, 'contains_service', 'validate_requested_services')}
${readShellFunction(
  deployScript,
  'is_exact_deploy_target_image_ref',
  'selected_target_images_are_preloaded',
)}
${readShellFunction(
  deployScript,
  'selected_target_images_are_preloaded',
  'prepare_deploy_disk_capacity',
)}
${readShellFunction(deployScript, 'prepare_deploy_disk_capacity', 'require_preloaded_target_image')}
mapfile -t SERVICES <<< "$SELECTED_SERVICES"
API_SERVICES=("api-ingress")
EXPECTED_DEPLOY_SHA="$EXPECTED_SHA"
TARGET_SHA="$TARGET_SHA_VALUE"
BUILD_API_IMAGE="$BUILD_API"
RELEASE_STATE_DIR=/unused-test-state
MAXIM_API_IMAGE="$API_IMAGE"
MAXIM_MINIAPP_MAJOR_IMAGE="$MINIAPP_IMAGE"
MAXIM_ADMIN_IMAGE="$ADMIN_IMAGE"
MAXIM_MINIAPP_LEGACY_IMAGE="$LEGACY_IMAGE"
docker() {
  [[ "$1" == "image" && "$2" == "inspect" ]]
  local image_ref="$3"
  if [[ "$3" == "--format" ]]; then
    image_ref="$5"
  fi
  grep -Fxq -- "$image_ref" <<< "$LOCAL_IMAGES" || return 1
  if [[ "$3" == "--format" ]]; then
    if [[ "$4" == "{{.Id}}" ]]; then
      printf 'sha256:%064d\\n' 0
    elif [[ "$image_ref" == "$INVALID_LABEL_IMAGE" ]]; then
      printf 'wrong-revision|false\\n'
    else
      printf '%s|true\\n' "$TARGET_SHA_VALUE"
    fi
  fi
}
df() {
  [[ "$1" == "-P" && "$2" == "-B1" ]]
  printf 'Filesystem 1-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/fake 107374182400 1 %s %s%% /\\n' "$AVAILABLE_BYTES" "$USED_PERCENT"
}
node() {
  [[ "$1" == infra/scripts/registry-preload-host.mjs && "$2" == verify ]]
  [[ "$4" == "$TARGET_SHA_VALUE" && "$6" == sha256:* ]]
  [[ "$5" != "$INVALID_RECEIPT_IMAGE" ]]
}
prepare_deploy_disk_capacity
printf 'capacity-admitted\\n'
`;

  return spawnSync('bash', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...env,
      ADMIN_IMAGE: adminImage,
      API_IMAGE: apiImage,
      AVAILABLE_BYTES: String(availableBytes),
      BUILD_API: String(buildApi),
      EXPECTED_SHA: expectedSha,
      INVALID_LABEL_IMAGE: invalidLabelImage,
      INVALID_RECEIPT_IMAGE: invalidReceiptImage,
      LEGACY_IMAGE: legacyImage,
      LOCAL_IMAGES: localImages.join('\n'),
      MINIAPP_IMAGE: miniappImage,
      SELECTED_SERVICES: services.join('\n'),
      TARGET_SHA_VALUE: targetSha,
      USED_PERCENT: String(usedPercent),
    },
  });
}

test('keeps component build floors in one shared library', () => {
  assert.match(diskCapacityLibrary, /MAXIM_API_BUILD_HARD_MIN_FREE_BYTES="10737418240"/u);
  assert.match(diskCapacityLibrary, /MAXIM_STATIC_BUILD_HARD_MIN_FREE_BYTES="6442450944"/u);
  for (const script of [deployScript, runtimeRollbackScript, scaleDeployScript]) {
    assert.match(script, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-disk-capacity\.sh"/u);
  }
});

test('enforces the 10 GiB API build floor at its exact boundary', () => {
  const below = runDiskPreflight(apiMinimumFreeBytes - 1);
  const equal = runDiskPreflight(apiMinimumFreeBytes);

  assert.equal(below.status, 1);
  assert.match(below.stderr, /at least 10737418240 bytes are required/u);
  assert.match(below.stderr, /not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /components=api/u);
  assert.match(equal.stdout, /minimum-free=10737418240B/u);
});

test('uses the smaller 6 GiB floor for static-only builds', () => {
  const below = runDiskPreflight(staticMinimumFreeBytes - 1, {
    needsApi: 0,
    needsStatic: 1,
  });
  const equal = runDiskPreflight(staticMinimumFreeBytes, {
    needsApi: 0,
    needsStatic: 1,
  });

  assert.equal(below.status, 1);
  assert.match(below.stderr, /at least 6442450944 bytes are required/u);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /components=static/u);
  assert.match(equal.stdout, /minimum-free=6442450944B/u);
});

test('mixed API and static builds use the higher API floor', () => {
  const below = runDiskPreflight(apiMinimumFreeBytes - 1, { needsStatic: 1 });
  const equal = runDiskPreflight(apiMinimumFreeBytes, { needsStatic: 1 });

  assert.equal(below.status, 1);
  assert.match(below.stdout, /components=api\+static/u);
  assert.match(below.stderr, /at least 10737418240 bytes are required/u);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /components=api\+static/u);
  assert.match(equal.stdout, /minimum-free=10737418240B/u);
});

test('rejects malformed capacity configuration and component flags', () => {
  for (const invalidValue of ['-1', '6GiB', '1.5']) {
    const result = runDiskPreflight(apiMinimumFreeBytes, { minimumOverride: invalidValue });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be a non-negative integer\./u,
    );
  }

  const invalidFlag = runDiskPreflight(apiMinimumFreeBytes, { needsApi: 2 });
  const noComponent = runDiskPreflight(apiMinimumFreeBytes, {
    needsApi: 0,
    needsStatic: 0,
  });
  assert.equal(invalidFlag.status, 1);
  assert.match(invalidFlag.stderr, /expressed as 0 or 1/u);
  assert.equal(noComponent.status, 1);
  assert.match(noComponent.stderr, /requires at least one build component/u);
});

test('compares configured byte thresholds exactly without shell integer overflow', () => {
  const leadingZeroResult = runDiskPreflight('00010737418240', {
    minimumOverride: '00010737418240',
  });
  const hugeThresholdResult = runDiskPreflight('999999999999999999999999999998', {
    minimumOverride: '999999999999999999999999999999',
  });

  assert.equal(leadingZeroResult.status, 0, leadingZeroResult.stderr);
  assert.match(leadingZeroResult.stdout, /available=10737418240B minimum-free=10737418240B/u);
  assert.equal(hugeThresholdResult.status, 1);
  assert.match(hugeThresholdResult.stderr, /at least 999999999999999999999999999999 bytes/u);
});

test('configuration may raise but never lower the selected component floor', () => {
  const weakApi = runDiskPreflight(apiMinimumFreeBytes, {
    minimumOverride: staticMinimumFreeBytes,
  });
  const weakStatic = runDiskPreflight(staticMinimumFreeBytes, {
    needsApi: 0,
    needsStatic: 1,
    minimumOverride: staticMinimumFreeBytes - 1,
  });
  const strongerMinimum = apiMinimumFreeBytes + 1024;
  const raisedBelow = runDiskPreflight(strongerMinimum - 1, {
    minimumOverride: strongerMinimum,
  });
  const raisedEqual = runDiskPreflight(strongerMinimum, {
    minimumOverride: strongerMinimum,
  });

  assert.equal(weakApi.status, 1);
  assert.match(weakApi.stderr, /at least 10737418240 for build components: api/u);
  assert.equal(weakStatic.status, 1);
  assert.match(weakStatic.stderr, /at least 6442450944 for build components: static/u);
  assert.equal(raisedBelow.status, 1);
  assert.match(raisedBelow.stderr, /at least 10737419264 bytes are required/u);
  assert.equal(raisedEqual.status, 0, raisedEqual.stderr);
  assert.match(raisedEqual.stdout, /minimum-free=10737419264B/u);
});

test('admits the absolute reserve while reporting percentage pressure', () => {
  const belowTarget = runDiskPreflight(apiMinimumFreeBytes, { usedPercent: 89 });
  const atTarget = runDiskPreflight(apiMinimumFreeBytes, { usedPercent: 90 });

  assert.equal(belowTarget.status, 0, belowTarget.stderr);
  assert.match(belowTarget.stdout, /target=90% critical=95%/u);
  assert.equal(atTarget.status, 0, atTarget.stderr);
  assert.match(atTarget.stderr, /WARNING: deploy host disk utilization is 90%/u);
  const critical = runDiskPreflight(apiMinimumFreeBytes, { usedPercent: 95 });
  assert.equal(critical.status, 0, critical.stderr);
  assert.match(critical.stderr, /CRITICAL: deploy host disk utilization is 95%/u);
});

test('a legacy emergency flag cannot bypass the absolute reserve', () => {
  const percentOverride = runDiskPreflight(apiMinimumFreeBytes, {
    usedPercent: 95,
    emergencyOverride: 1,
  });
  const absoluteShortfall = runDiskPreflight(apiMinimumFreeBytes - 1, {
    usedPercent: 95,
    emergencyOverride: 1,
  });

  assert.equal(percentOverride.status, 0, percentOverride.stderr);
  assert.match(percentOverride.stderr, /CRITICAL: deploy host disk utilization is 95%/u);
  assert.equal(absoluteShortfall.status, 1);
  assert.match(absoluteShortfall.stderr, /not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});

test('normalizes percentage thresholds before comparing them', () => {
  const result = runDiskPreflight(apiMinimumFreeBytes, {
    usedPercent: '080',
    targetPercent: '080',
    criticalPercent: '090',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARNING: deploy host disk utilization is 80%/u);
});

test('exact-SHA API image reuse enforces the same 10 GiB reserve as a build', () => {
  const targetSha = 'a'.repeat(40);
  const localImages = [
    `maxim-api:${targetSha}`,
    `maxim-miniapp-major:${targetSha}`,
    `maxim-admin:${targetSha}`,
  ];
  const options = {
    expectedSha: targetSha,
    services: ['api-ingress', 'miniapp-major-static', 'admin-static'],
    localImages,
    usedPercent: 95,
  };
  const below = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: apiMinimumFreeBytes - 1,
    emergencyOverride: 1,
  });
  const equal = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: apiMinimumFreeBytes,
  });

  assert.equal(below.status, 1);
  assert.match(below.stderr, /at least 10737418240 bytes are required/u);
  assert.match(below.stderr, /not bypassed by MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
  assert.doesNotMatch(below.stdout, /capacity-admitted/u);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /Reusing every selected exact immutable target image/u);
  assert.match(equal.stdout, /components=api\+static/u);
  assert.match(equal.stdout, /minimum-free=10737418240B/u);
  assert.match(equal.stdout, /mode=reuse/u);
  assert.match(equal.stdout, /capacity-admitted/u);
  assert.match(equal.stderr, /CRITICAL: deploy host disk utilization is 95%/u);
});

test('exact-SHA static image reuse still enforces the smaller 6 GiB reserve', () => {
  const targetSha = 'f'.repeat(40);
  const options = {
    expectedSha: targetSha,
    services: ['miniapp-major-static', 'admin-static'],
    localImages: [`maxim-miniapp-major:${targetSha}`, `maxim-admin:${targetSha}`],
    usedPercent: 95,
  };
  const below = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: staticMinimumFreeBytes - 1,
  });
  const equal = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: staticMinimumFreeBytes,
  });

  assert.equal(below.status, 1);
  assert.match(below.stderr, /at least 6442450944 bytes are required/u);
  assert.doesNotMatch(below.stdout, /capacity-admitted/u);
  assert.equal(equal.status, 0, equal.stderr);
  assert.match(equal.stdout, /components=static/u);
  assert.match(equal.stdout, /minimum-free=6442450944B/u);
  assert.match(equal.stdout, /mode=reuse/u);
  assert.match(equal.stdout, /capacity-admitted/u);
});

test('reuse reserve configuration may raise but never lower the component floor', () => {
  const targetSha = '1'.repeat(40);
  const options = {
    expectedSha: targetSha,
    localImages: [`maxim-api:${targetSha}`],
    usedPercent: 95,
  };
  const weak = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: apiMinimumFreeBytes,
    minimumOverride: staticMinimumFreeBytes,
  });
  const strongerMinimum = apiMinimumFreeBytes + 1024;
  const raisedBelow = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: strongerMinimum - 1,
    minimumOverride: strongerMinimum,
  });
  const raisedEqual = runSelectedImageCapacityPreflight({
    ...options,
    availableBytes: strongerMinimum,
    minimumOverride: strongerMinimum,
  });

  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /at least 10737418240 for build components: api/u);
  assert.equal(raisedBelow.status, 1);
  assert.match(raisedBelow.stderr, /at least 10737419264 bytes are required/u);
  assert.equal(raisedEqual.status, 0, raisedEqual.stderr);
  assert.match(raisedEqual.stdout, /minimum-free=10737419264B/u);
  assert.match(raisedEqual.stdout, /capacity-admitted/u);
});

test('reuse capacity helper keeps exact decimal comparisons and rejects malformed thresholds', () => {
  const exact = runDiskPreflight('00010737418240', {
    minimumOverride: '00010737418240',
    reuseOnly: true,
    usedPercent: 95,
  });
  const huge = runDiskPreflight('999999999999999999999999999998', {
    minimumOverride: '999999999999999999999999999999',
    reuseOnly: true,
  });
  const malformed = runDiskPreflight(apiMinimumFreeBytes, {
    minimumOverride: '10GiB',
    reuseOnly: true,
  });

  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /available=10737418240B minimum-free=10737418240B/u);
  assert.equal(huge.status, 1);
  assert.match(huge.stderr, /at least 999999999999999999999999999999 bytes/u);
  assert.equal(malformed.status, 1);
  assert.match(
    malformed.stderr,
    /MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be a non-negative integer/u,
  );
});

test('missing selected images stop before runtime with no production build fallback', () => {
  const targetSha = 'b'.repeat(40);
  const mixedResult = runSelectedImageCapacityPreflight({
    availableBytes: apiMinimumFreeBytes - 1,
    expectedSha: targetSha,
    services: ['api-ingress', 'miniapp-major-static'],
    localImages: [`maxim-api:${targetSha}`],
  });
  const staticResult = runSelectedImageCapacityPreflight({
    availableBytes: staticMinimumFreeBytes,
    expectedSha: targetSha,
    services: ['miniapp-major-static'],
    localImages: [],
    buildApi: 0,
  });

  assert.equal(mixedResult.status, 1);
  assert.match(mixedResult.stderr, /prepare and preload it from CI\/GHCR: maxim-miniapp-major:/u);
  assert.match(mixedResult.stderr, /Release image coverage is incomplete/u);
  assert.equal(staticResult.status, 1, staticResult.stderr);
  assert.match(staticResult.stderr, /Release image coverage is incomplete/u);
  assert.doesNotMatch(staticResult.stdout, /capacity-admitted/u);
});

test('wrong-SHA and unknown targets cannot bypass the API floor', () => {
  const targetSha = 'c'.repeat(40);
  const wrongSha = 'd'.repeat(40);
  const wrongImage = `maxim-api:${wrongSha}`;
  const wrongShaResult = runSelectedImageCapacityPreflight({
    availableBytes: apiMinimumFreeBytes - 1,
    expectedSha: targetSha,
    services: ['api-ingress'],
    localImages: [wrongImage],
    apiImage: wrongImage,
  });
  const unknownResult = runSelectedImageCapacityPreflight({
    availableBytes: apiMinimumFreeBytes - 1,
    expectedSha: targetSha,
    services: ['manual-unknown-static'],
    localImages: [`maxim-api:${targetSha}`],
    buildApi: 0,
  });

  assert.equal(wrongShaResult.status, 1);
  assert.match(wrongShaResult.stderr, /non-target image ref/u);
  assert.match(wrongShaResult.stderr, /Release image coverage is incomplete/u);
  assert.equal(unknownResult.status, 1);
  assert.match(unknownResult.stderr, /unknown target: manual-unknown-static/u);
  assert.match(unknownResult.stderr, /Release image coverage is incomplete/u);
});

test('an exact-SHA tag with unverified release labels cannot bypass the API floor', () => {
  const targetSha = 'e'.repeat(40);
  const imageRef = `maxim-api:${targetSha}`;
  const result = runSelectedImageCapacityPreflight({
    availableBytes: apiMinimumFreeBytes - 1,
    expectedSha: targetSha,
    services: ['api-ingress'],
    localImages: [imageRef],
    invalidLabelImage: imageRef,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unverified release labels/u);
  assert.match(result.stderr, /Release image coverage is incomplete/u);
});

test('missing registry receipts cannot authorize reuse from labels alone', () => {
  const targetSha = 'f'.repeat(40);
  const imageRef = `maxim-api:${targetSha}`;
  const result = runSelectedImageCapacityPreflight({
    availableBytes: apiMinimumFreeBytes,
    expectedSha: targetSha,
    localImages: [imageRef],
    invalidReceiptImage: imageRef,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release image coverage is incomplete/u);
});

test('runtime and scale builds run capacity checks before destructive work', () => {
  assert.ok(
    runtimeRollbackScript.indexOf('maxim_check_deploy_disk_capacity 1 0') <
      runtimeRollbackScript.indexOf('git switch --detach'),
  );
  const scalePreflight = scaleDeployScript.indexOf(
    'maxim_check_deploy_disk_capacity "$BUILD_API_IMAGE" "$BUILD_STATIC_IMAGE"',
  );
  assert.ok(scalePreflight < scaleDeployScript.lastIndexOf('prepare_scale_redis_named_volume'));
  assert.ok(scalePreflight < scaleDeployScript.lastIndexOf('stop_conflicting_stacks'));
});

test('runtime recreation and migrations cannot trigger implicit image builds', () => {
  for (const script of [
    deployScript,
    runtimeRollbackScript,
    immutableRollbackScript,
    scaleDeployScript,
  ]) {
    const upCommands = script
      .split('\n')
      .filter((line) => line.includes('docker compose') && line.includes(' up -d '));

    assert.ok(upCommands.length > 0, 'expected runtime docker compose up commands');
    for (const command of upCommands) {
      assert.match(command, / --no-build /u);
    }
  }

  for (const script of [deployScript, runtimeRollbackScript, scaleDeployScript]) {
    const runCommands = script
      .split('\n')
      .filter((line) => line.includes('docker compose') && line.includes(' run --rm '));

    assert.ok(runCommands.length > 0, 'expected migration docker compose run commands');
    for (const command of runCommands) {
      assert.match(command, /"\$\{(?:ERASER_)?MIGRATION_COMPOSE_FILES\[@\]\}"/u);
      assert.match(command, / --pull never /u);
      assert.doesNotMatch(command, / --no-build /u);
    }
  }

  assert.equal(
    migrationNoBuildCompose,
    [
      'services:',
      '  api-ingress:',
      '    image: ${MAXIM_MIGRATION_API_IMAGE:?MAXIM_MIGRATION_API_IMAGE must reference a prebuilt API image}',
      '    build: !reset null',
      '',
    ].join('\n'),
  );
  assert.equal(
    read('infra/docker-compose.eraser-no-build.yml'),
    [
      'services:',
      '  eraser:',
      '    image: ${MAXIM_ERASER_IMAGE:?MAXIM_ERASER_IMAGE must reference a prebuilt Lastik image}',
      '    build: !reset null',
      '',
    ].join('\n'),
  );

  const migrationComposeDefinition =
    'MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f "infra/docker-compose.runtime-no-build.yml")';
  assert.ok(deployScript.includes(migrationComposeDefinition));
  assert.ok(scaleDeployScript.includes(migrationComposeDefinition));
  assert.ok(deployScript.includes('MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \\'));
  assert.ok(
    scaleDeployScript.includes(
      'MAXIM_MIGRATION_API_IMAGE="${SCALE_PROJECT_NAME}-api-ingress:latest" \\',
    ),
  );
  assert.ok(runtimeRollbackScript.includes('MAXIM_MIGRATION_API_IMAGE="$ROLLBACK_API_IMAGE" \\'));

  const preservedCopy =
    'cp infra/docker-compose.runtime-no-build.yml "$PRESERVED_MIGRATION_COMPOSE_FILE"';
  const preservedDefinition =
    'MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f "$PRESERVED_MIGRATION_COMPOSE_FILE")';
  const preservedCleanup =
    '[[ -z "$PRESERVED_MIGRATION_COMPOSE_FILE" ]] || rm -f "$PRESERVED_MIGRATION_COMPOSE_FILE"';
  const copyIndex = runtimeRollbackScript.indexOf(preservedCopy);
  const definitionIndex = runtimeRollbackScript.indexOf(preservedDefinition);
  const switchIndex = runtimeRollbackScript.indexOf('git switch --detach');
  assert.notEqual(copyIndex, -1);
  assert.notEqual(definitionIndex, -1);
  assert.notEqual(switchIndex, -1);
  assert.ok(runtimeRollbackScript.includes(preservedCleanup));
  assert.ok(
    copyIndex < definitionIndex && definitionIndex < switchIndex,
    'runtime rollback must preserve and select the no-build overlay before switching refs',
  );
});
