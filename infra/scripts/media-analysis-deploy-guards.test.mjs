import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const topologyPath = resolve(root, 'infra/scripts/lib/deploy-topology.sh');
const apiServices = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
];

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function replaceExactlyOnce(source, anchor, replacement) {
  const matches =
    typeof anchor === 'string'
      ? source.split(anchor).length - 1
      : [...source.matchAll(new RegExp(anchor.source, `${anchor.flags.replaceAll('g', '')}g`))]
          .length;
  assert.equal(matches, 1, `mutation anchor must occur once: ${anchor}`);
  const changed = source.replace(anchor, replacement);
  assert.notEqual(changed, source, `mutation must change source: ${anchor}`);
  return changed;
}

function mutateImageBoundary(source, mutate) {
  const marker = '  private async runDeletePreDispatchGuards(';
  assert.equal(source.split(marker).length - 1, 1);
  const start = source.indexOf(marker);
  const end = source.indexOf('\n  private ', start + marker.length);
  assert.ok(end > start, 'image boundary must have a following method');
  const boundary = source.slice(start, end);
  const changed = mutate(boundary);
  assert.notEqual(changed, boundary, 'image boundary mutation must change bytes');
  return source.slice(0, start) + changed + source.slice(end);
}

function runTopologyProbe(probe, environment = {}) {
  return spawnSync('bash', ['-c', `source "$TOPOLOGY_PATH"\n${probe}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TOPOLOGY_PATH: topologyPath, ...environment },
  });
}

function commercialOcrComposeConfig(version, overrides = {}) {
  return JSON.stringify({
    services: Object.fromEntries(
      apiServices.map((service) => [
        service,
        {
          environment: {
            COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
            COMMERCIAL_OCR_VERSION: version,
            ...overrides[service],
          },
        },
      ]),
    ),
  });
}

test('detects media-analysis support from the target Git Compose source', () => {
  const present = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-ingress:' '  api-media-analysis:'
    return 0
  fi
  return 2
}
maxim_topology_git_compose_has_service target-sha "$MAXIM_MEDIA_ANALYSIS_SERVICE"
`);
  assert.equal(present.status, 0, present.stderr);

  const absent = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-ingress:' '    api-media-analysis: incidental-value'
    return 0
  fi
  return 2
}
maxim_topology_git_compose_has_service target-sha "$MAXIM_MEDIA_ANALYSIS_SERVICE"
`);
  assert.equal(absent.status, 1, absent.stderr);
});

test('detects the OCR sandbox as an auxiliary target capability', () => {
  const present = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-media-analysis:' '  ocr-native-sandbox:'
    return 0
  fi
  return 2
}
maxim_topology_git_has_ocr_native_sandbox target-sha
`);
  assert.equal(present.status, 0, present.stderr);

  const absent = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' 'services:' '  api-media-analysis:' '    ocr-native-sandbox: incidental'
    return 0
  fi
  return 2
}
if maxim_topology_git_has_ocr_native_sandbox target-sha; then exit 9; fi
`);
  assert.equal(absent.status, 0, absent.stderr);
});

test('rollback floor requires image-text binding v1 at the pre-dispatch delete boundary', () => {
  const topology = read('infra/scripts/lib/deploy-topology.sh');
  const start = topology.indexOf('maxim_topology_require_image_text_stop_list_delete_guard() {');
  const guard = topology.slice(start, topology.indexOf('\n}\n', start) + 2);
  assert.match(guard, /git cat-file/u);
  assert.match(guard, /git show/u);
  assert.doesNotMatch(guard, /\b(?:docker|psql|redis)\b|\.env/u);

  const valid = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" && "$2" == *'image-text-stop-list-binding.ts' ]]; then
    printf '%s\\n' 'export const IMAGE_TEXT_STOP_LIST_BINDING_VERSION = 1 as const;'
    return 0
  fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' \\
      "import {} from './commercial-ocr/image-text-stop-list-binding';" \\
      '  private async runDeletePreDispatchGuards(' \\
      '    await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);' \\
      '    await options?.beforeDeleteMutation?.();' \\
      '  }' \\
      '  private async assertImageTextStopListDeleteIntentStillActionable(intent: IntentRow, botId: string): Promise<void> {'
    return 0
  fi
  return 2
}
maxim_topology_require_image_text_stop_list_delete_guard target-sha
`);
  assert.equal(valid.status, 0, valid.stderr);

  const stale = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" && "$2" == *'image-text-stop-list-binding.ts' ]]; then
    printf '%s\\n' 'export const IMAGE_TEXT_STOP_LIST_BINDING_VERSION = 1 as const;'
    return 0
  fi
  if [[ "$1" == "show" ]]; then
    printf '%s\\n' \\
      "import {} from './commercial-ocr/image-text-stop-list-binding';" \\
      '  private async runDeletePreDispatchGuards(' \\
      '    await options?.beforeDeleteMutation?.();' \\
      '    await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);' \\
      '  }' \\
      '  private async assertImageTextStopListDeleteIntentStillActionable(intent: IntentRow, botId: string): Promise<void> {'
    return 0
  fi
  return 2
}
if maxim_topology_require_image_text_stop_list_delete_guard target-sha; then exit 9; fi
`);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stderr, /lacks the reviewed image-text stop-list pre-dispatch guard/u);
});

test('image-text rollback floor accepts prepared and legacy authority and rejects broken flow', async (t) => {
  const executor = read('apps/api/src/moderation/moderation-delete-intent.service.ts');
  const binding = read('apps/api/src/moderation/commercial-ocr/image-text-stop-list-binding.ts');
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-image-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executorPath = resolve(directory, 'executor.ts');
  const bindingPath = resolve(directory, 'binding.ts');
  const statusPath = resolve(directory, 'parser.status');
  const diagnosticsPath = resolve(directory, 'parser.stderr');
  const preparation = `const imageTextPreparation = finalDispatchLeaseToken
          ? await this.prepareImageTextStopListDeleteAuthority(intent, botId)
          : await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);`;
  const discriminator = `let imageTextStopListGuard = isPreparedDeleteAuthority(imageTextPreparation)
          ? undefined
          : imageTextPreparation;`;
  const absence = `if (imageTextStopListGuard === 'absent') {
          throw new ModerationDeleteGuardedMessageAbsentError(
            'guarded_image_text_stop_list_predispatch_exact_absence',
          );
        }`;
  const finalizer = 'imageTextStopListGuard = await finalizeDeleteAuthority(imageTextPreparation);';
  const checkpointAndFinalizer = `await beforeFinalAuthority?.();
              ${finalizer}`;
  const boundaryCase = (label, anchor, replacement) => [
    label,
    mutateImageBoundary(executor, (boundary) => replaceExactlyOnce(boundary, anchor, replacement)),
    1,
  ];
  // FLAG: Keep a bounded value-returning legacy route; CI must not require old Git objects.
  const legacy = `import {} from './commercial-ocr/image-text-stop-list-binding';
class LegacyImageGuard {
  private async runDeletePreDispatchGuards(intent: IntentRow, botId: string, options?: Options) {
    const imageTextStopListGuard = await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);
    if (imageTextStopListGuard === 'absent') {
      throw new ModerationDeleteGuardedMessageAbsentError(
        'guarded_image_text_stop_list_predispatch_exact_absence',
      );
    }
    await options?.beforeDeleteMutation?.();
  }
  private async assertImageTextStopListDeleteIntentStillActionable(
    intent: IntentRow,
    botId: string,
  ): Promise<'not_applicable' | 'absent'> {
    return 'not_applicable';
  }
}
`;
  const legacyCall =
    'const imageTextStopListGuard = await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);';
  const legacyAbsence = / {4}if \(imageTextStopListGuard === 'absent'\) \{[\s\S]*?\n {4}\}/u;
  const outsideCallback = mutateImageBoundary(executor, (boundary) =>
    replaceExactlyOnce(
      replaceExactlyOnce(boundary, finalizer, ''),
      'const proof = await this.authorizeGuardedUserDeleteReasons(',
      `${finalizer}\n        const proof = await this.authorizeGuardedUserDeleteReasons(`,
    ),
  );
  const cases = [
    ['current prepared executor', executor, 0],
    ['legacy checked value', legacy, 0],
    [
      'prepared whitespace',
      mutateImageBoundary(executor, (boundary) =>
        replaceExactlyOnce(
          boundary,
          preparation,
          `const imageTextPreparation = finalDispatchLeaseToken ? await this.prepareImageTextStopListDeleteAuthority( intent, botId, ) : await this.assertImageTextStopListDeleteIntentStillActionable( intent, botId, );`,
        ),
      ),
      0,
    ],
    [
      'legacy discarded absence',
      replaceExactlyOnce(
        replaceExactlyOnce(
          legacy,
          legacyCall,
          'await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);',
        ),
        legacyAbsence,
        '',
      ),
      1,
    ],
    [
      'legacy callback before guard',
      replaceExactlyOnce(
        legacy,
        legacyCall,
        `await options?.beforeDeleteMutation?.('recheck');\n    ${legacyCall}`,
      ),
      1,
    ],
    boundaryCase('missing preparation', preparation, 'const imageTextPreparation = undefined;'),
    boundaryCase(
      'wrong preparation arguments',
      preparation,
      replaceExactlyOnce(
        preparation,
        'prepareImageTextStopListDeleteAuthority(intent, botId)',
        'prepareImageTextStopListDeleteAuthority(botId, intent)',
      ),
    ),
    boundaryCase(
      'unawaited preparation',
      preparation,
      replaceExactlyOnce(
        preparation,
        '? await this.prepareImageTextStopListDeleteAuthority',
        '? this.prepareImageTextStopListDeleteAuthority',
      ),
    ),
    boundaryCase(
      'wrong legacy branch',
      preparation,
      replaceExactlyOnce(
        preparation,
        'assertImageTextStopListDeleteIntentStillActionable(intent, botId)',
        'assertImageTextStopListDeleteIntentStillActionable(botId, intent)',
      ),
    ),
    boundaryCase(
      'missing prepared discriminator',
      discriminator,
      'let imageTextStopListGuard = imageTextPreparation;',
    ),
    boundaryCase(
      'discriminator examines another capsule',
      discriminator,
      replaceExactlyOnce(
        discriminator,
        'isPreparedDeleteAuthority(imageTextPreparation)',
        'isPreparedDeleteAuthority(reportPreparation)',
      ),
    ),
    boundaryCase('missing exact absence rejection', absence, ''),
    boundaryCase(
      'wrong absence error',
      absence,
      replaceExactlyOnce(absence, 'ModerationDeleteGuardedMessageAbsentError', 'Error'),
    ),
    boundaryCase(
      'absence branch does not throw',
      absence,
      replaceExactlyOnce(absence, 'throw new', 'return new'),
    ),
    boundaryCase(
      'caller callback precedes absence',
      absence,
      `await options?.beforeDeleteMutation?.('initial_unattempted');\n      ${absence}`,
    ),
    boundaryCase('duplicate preparation', preparation, `${preparation}\n      ${preparation}`),
    boundaryCase('missing assigned finalizer', finalizer, 'imageTextStopListGuard = undefined;'),
    boundaryCase(
      'unawaited finalizer',
      finalizer,
      'imageTextStopListGuard = finalizeDeleteAuthority(imageTextPreparation);',
    ),
    boundaryCase(
      'wrong finalizer capsule',
      finalizer,
      'imageTextStopListGuard = await finalizeDeleteAuthority(reportPreparation);',
    ),
    boundaryCase(
      'discarded finalizer result',
      finalizer,
      'await finalizeDeleteAuthority(imageTextPreparation);',
    ),
    boundaryCase('duplicate finalizer', finalizer, `${finalizer}\n            ${finalizer}`),
    boundaryCase(
      'finalizer before checkpoint',
      checkpointAndFinalizer,
      `${finalizer}\n            await beforeFinalAuthority?.();`,
    ),
    boundaryCase(
      'unawaited checkpoint',
      checkpointAndFinalizer,
      `beforeFinalAuthority?.();\n            ${finalizer}`,
    ),
    boundaryCase(
      'unawaited composer callback',
      'const proof = await this.authorizeGuardedUserDeleteReasons(',
      'const proof = this.authorizeGuardedUserDeleteReasons(',
    ),
    ['finalizer outside callback', outsideCallback, 1],
    boundaryCase(
      'missing original deadline carry',
      'verifiedReasonDeadlines.push(...imageTextStopListGuard.reasonDeadlines);',
      'verifiedReasonDeadlines.push(...[]);',
    ),
    [
      'broken compatibility wrapper',
      replaceExactlyOnce(
        executor,
        `return finalizeDeleteAuthority(\n      await this.prepareImageTextStopListDeleteAuthority(intent, botId),\n    );`,
        `return this.prepareImageTextStopListDeleteAuthority(intent, botId);`,
      ),
      1,
    ],
    [
      'comment decoy cannot restore finalizer',
      `${mutateImageBoundary(executor, (boundary) =>
        replaceExactlyOnce(boundary, finalizer, 'imageTextStopListGuard = undefined;'),
      )}\n// ${finalizer}\n`,
      1,
    ],
    boundaryCase(
      'inline comment cannot restore callback finalizer',
      finalizer,
      `void 0; // async () => { await beforeFinalAuthority?.(); ${finalizer}`,
    ),
    [
      'method decoy cannot restore finalizer',
      `${mutateImageBoundary(executor, (boundary) =>
        replaceExactlyOnce(boundary, finalizer, 'imageTextStopListGuard = undefined;'),
      )}\n  private async decoy() { ${finalizer} }\n`,
      1,
    ],
  ];
  writeFileSync(bindingPath, binding);
  for (const [label, source, expected] of cases) {
    await t.test(label, () => {
      writeFileSync(executorPath, source);
      writeFileSync(statusPath, '');
      writeFileSync(diagnosticsPath, '');
      const result = runTopologyProbe(
        `
node() {
  local status
  if "$MAXIM_TEST_NODE" "$@" 2>>"$PARSER_DIAGNOSTICS"; then status=0; else status=$?; fi
  printf '%s\\n' "$status" >>"$PARSER_STATUS"
  return "$status"
}
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" != "show" ]]; then return 2; fi
  if [[ "$2" == *'image-text-stop-list-binding.ts' ]]; then
    cat "$BINDING_FIXTURE"
  else
    cat "$EXECUTOR_FIXTURE"
  fi
}
maxim_topology_require_image_text_stop_list_delete_guard target-sha
`,
        {
          BINDING_FIXTURE: bindingPath,
          EXECUTOR_FIXTURE: executorPath,
          MAXIM_TEST_NODE: process.execPath,
          PARSER_STATUS: statusPath,
          PARSER_DIAGNOSTICS: diagnosticsPath,
        },
      );
      const statuses = readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean);
      const diagnostics = `${label}: ${result.stderr}\n${readFileSync(diagnosticsPath, 'utf8')}`;
      assert.ok(statuses.length > 0, diagnostics);
      assert.ok(
        statuses.every((status) => status === '0' || status === '1'),
        diagnostics,
      );
      assert.equal(result.error, undefined, diagnostics);
      assert.equal(result.signal, null, diagnostics);
      assert.equal(result.status, expected, diagnostics);
    });
  }
});

test('extracts a single literal behavior version from the target Git source', () => {
  const literal = runTopologyProbe(`
git() {
  printf '%s\\n' "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'tesseract-rus-eng-v1' as const;"
}
maxim_topology_git_commercial_ocr_version target-sha
`);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(literal.stdout, 'tesseract-rus-eng-v1');

  for (const source of [
    'export const COMMERCIAL_OCR_DEFAULT_VERSION = resolveVersion();',
    "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'valid';\\nexport const COMMERCIAL_OCR_DEFAULT_VERSION = 'duplicate';",
    "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'unsafe value';",
  ]) {
    const invalid = runTopologyProbe(`
git() { printf '%b\\n' '${source}'; }
if maxim_topology_git_commercial_ocr_version target-sha; then exit 9; fi
`);
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.match(invalid.stderr, /COMMERCIAL_OCR_DEFAULT_VERSION/u);
  }
});

test('target preparation skips pre-feature commits and pins OCR commits to source version', () => {
  const withoutMediaAnalysis = runTopologyProbe(`
unset COMMERCIAL_OCR_VERSION
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  if [[ "$1" == "show" ]]; then printf '%s\\n' 'services:' '  api-ingress:'; return 0; fi
  return 2
}
docker() { echo 'docker must not be called' >&2; return 8; }
compose_args=(-p infra -f infra/docker-compose.yml)
has_media=9
version=sentinel
maxim_topology_prepare_commercial_ocr_target target-sha compose_args has_media version
printf '%s|%s|%s' "$has_media" "$version" "\${COMMERCIAL_OCR_VERSION-unset}"
`);
  assert.equal(withoutMediaAnalysis.status, 0, withoutMediaAnalysis.stderr);
  assert.equal(withoutMediaAnalysis.stdout, '0||unset');

  const config = commercialOcrComposeConfig('tesseract-rus-eng-v1');
  const withMediaAnalysis = runTopologyProbe(`
git() {
  if [[ "$1" == "cat-file" ]]; then return 0; fi
  case "$2" in
    *:infra/docker-compose.yml)
      printf '%s\\n' 'services:' '  api-ingress:' '  api-media-analysis:'
      ;;
    *:apps/api/src/moderation/commercial-ocr/commercial-ocr.queue.ts)
      printf '%s\\n' "export const COMMERCIAL_OCR_DEFAULT_VERSION = 'tesseract-rus-eng-v1';"
      ;;
    *) return 2 ;;
  esac
}
docker() { printf '%s' '${config}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
has_media=0
version=''
maxim_topology_prepare_commercial_ocr_target target-sha compose_args has_media version
printf '%s|%s|%s' "$has_media" "$version" "$COMMERCIAL_OCR_VERSION"
`);
  assert.equal(withMediaAnalysis.status, 0, withMediaAnalysis.stderr);
  assert.equal(withMediaAnalysis.stdout, '1|tesseract-rus-eng-v1|tesseract-rus-eng-v1');
});

test('effective OCR version preflight requires the target version on all 14 API roles', () => {
  const matchingConfig = commercialOcrComposeConfig('tesseract-rus-eng-v2');
  const matching = runTopologyProbe(`
docker() { printf '%s' '${matchingConfig}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_api_commercial_ocr_version_config compose_args tesseract-rus-eng-v2
`);
  assert.equal(matching.status, 0, matching.stderr);

  for (const config of [
    commercialOcrComposeConfig('tesseract-rus-eng-v2', {
      'api-action': { COMMERCIAL_OCR_VERSION: 'stale-private-value' },
    }),
    JSON.stringify({
      services: Object.fromEntries(
        apiServices.slice(0, -1).map((service) => [
          service,
          {
            environment: {
              COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
              COMMERCIAL_OCR_VERSION: 'tesseract-rus-eng-v2',
            },
          },
        ]),
      ),
    }),
  ]) {
    const rejected = runTopologyProbe(`
docker() { printf '%s' '${config}'; }
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_require_api_commercial_ocr_version_config compose_args tesseract-rus-eng-v2; then
  exit 9
fi
`);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.match(rejected.stderr, /every production API role/u);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /stale-private-value/u);
  }
});

test('running OCR version verification inspects every production API container', () => {
  const passing = runTopologyProbe(`
docker() {
  if [[ "$1 $2" == "compose -p" && "$*" == *' ps -q '* ]]; then
    printf 'container-%s' "\${!#}"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    printf '%s\\n' 'NODE_ENV=production' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2'
    return 0
  fi
  return 8
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_verify_api_commercial_ocr_version compose_args tesseract-rus-eng-v2
`);
  assert.equal(passing.status, 0, passing.stderr);

  const mismatch = runTopologyProbe(`
docker() {
  if [[ "$1 $2" == "compose -p" && "$*" == *' ps -q '* ]]; then
    printf 'container-%s' "\${!#}"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    if [[ "\${!#}" == 'container-api-action' ]]; then
      printf '%s\\n' 'COMMERCIAL_OCR_VERSION=stale-private-value'
    else
      printf '%s\\n' 'COMMERCIAL_OCR_VERSION=tesseract-rus-eng-v2'
    fi
    return 0
  fi
  return 8
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_verify_api_commercial_ocr_version compose_args tesseract-rus-eng-v2; then
  exit 9
fi
`);
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stderr, /api-action does not run with the target/u);
  assert.doesNotMatch(`${mismatch.stdout}${mismatch.stderr}`, /stale-private-value/u);
});

test('removes only media-analysis from a pre-feature target service list', () => {
  const result = runTopologyProbe(`
services=(api-ingress api-media-analysis api-action)
maxim_topology_remove_service services "$MAXIM_MEDIA_ANALYSIS_SERVICE"
printf '%s\\n' "\${services[@]}"
`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['api-ingress', 'api-action']);
});

test('full OCR smoke requires shadow mode, raster recognition, and internal readiness', () => {
  const passing = runTopologyProbe(`
order_file="$(mktemp)"
trap 'rm -f "$order_file"' EXIT
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' '/opt/ocr/tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*)
      printf '%s\\n' raster >> "$order_file"
      printf '%s\\n' 'Commercial OCR worker smoke passed.'
      ;;
    *'health/ready'*)
      printf '%s\\n' internal-ready >> "$order_file"
      return 0
      ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args required
cat "$order_file"
`);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /internal OCR readiness smokes passed/u);
  assert.match(passing.stdout, /internal-ready\nraster/u);

  const missingRussian = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus_old ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(missingRussian.status, 0, missingRussian.stderr);
  assert.match(missingRussian.stderr, /exact Tesseract language entries: rus and eng/u);

  const failedRaster = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'health/ready'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) return 7 ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(failedRaster.status, 0, failedRaster.stderr);
  assert.match(failedRaster.stderr, /Native OCR worker raster smoke failed/u);

  const notReady = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) return 7 ;;
    *'health/ready'*) return 1 ;;
    *) return 8 ;;
  esac
}
sleep() { :; }
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(notReady.status, 0, notReady.stderr);
  assert.match(notReady.stderr, /did not reach internal OCR readiness/u);
});

test('cold native admission accepts only fresh queue-only failure and keeps release readiness strict', () => {
  const script = read('infra/scripts/lib/deploy-topology.sh').match(
    /'(fetch\("http:\/\/127\.0\.0\.1:3001\/api\/health\/ready"[^\n]+)' "\$readiness_policy"/u,
  )?.[1];
  assert.ok(script);
  const healthyNativeBacklog = {
    ok: false,
    checks: {
      database: true,
      redis: true,
      queueLag: {
        rawOk: false,
        effectiveLagSec: 40000,
        sampleGeneratedAt: new Date().toISOString(),
      },
      ocr: { ready: true, behaviorIdentity: { complete: true, verified: true } },
    },
    systemMode: { source: 'auto', condition: 'queue_backlog', manualMode: null },
  };
  const run = (policy, body, status = 503) =>
    spawnSync(
      process.execPath,
      [
        '-e',
        `global.fetch = async () => ({ ok: ${status === 200}, status: ${status}, json: async () => (${JSON.stringify(body)}) });\n${script}`,
        policy,
      ],
      { encoding: 'utf8' },
    ).status;
  assert.equal(run('cold-recovery', healthyNativeBacklog), 0);
  assert.equal(run('strict', healthyNativeBacklog), 1);
  assert.equal(run('cold-recovery', healthyNativeBacklog, 500), 1);
  for (const mutate of [
    (b) => {
      b.checks.database = false;
    },
    (b) => {
      b.checks.redis = false;
    },
    (b) => {
      b.checks.ocr.ready = false;
    },
    (b) => {
      b.checks.ocr.behaviorIdentity.complete = false;
    },
    (b) => {
      b.checks.ocr.behaviorIdentity.verified = false;
    },
    (b) => {
      b.systemMode.source = 'manual';
    },
    (b) => {
      b.systemMode.manualMode = 'degrade';
    },
    (b) => {
      b.systemMode.condition = 'action_errors';
    },
    (b) => {
      b.checks.queueLag.sampleGeneratedAt = '2000-01-01T00:00:00.000Z';
    },
    (b) => {
      b.checks.queueLag.sampleGeneratedAt = new Date(Date.now() + 60000).toISOString();
    },
    (b) => {
      b.checks.queueLag.effectiveLagSec = null;
    },
  ]) {
    const body = structuredClone(healthyNativeBacklog);
    mutate(body);
    assert.equal(run('cold-recovery', body), 1);
  }
  const ready = structuredClone(healthyNativeBacklog);
  ready.ok = true;
  assert.equal(run('strict', ready, 200), 0);
  ready.checks.ocr.ready = false;
  assert.equal(run('strict', ready, 200), 1);
});

test('sandbox OCR smoke uses only the attested UDS probe and never spawns Tesseract directly', () => {
  const result = runTopologyProbe(`
maxim_topology_require_ocr_native_sandbox_config() { :; }
maxim_topology_wait_for_ocr_native_sandbox() { :; }
maxim_topology_verify_ocr_native_sandbox_runtime() { :; }
docker() {
  case "$*" in
    *'--list-langs'*) printf '%s\\n' 'direct Tesseract probe is forbidden' >&2; return 9 ;;
    *'native-ocr-sandbox.entrypoint.js --probe'*) printf '%s\\n' 'Native OCR sandbox probe passed.' ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' present ;;
    *'checks?.ocr?.ready'*) return 0 ;;
    *'smoke-commercial-ocr-worker.js'*) printf '%s\\n' 'Commercial OCR worker smoke passed.' ;;
    *'ps --status running -q ocr-native-sandbox'*) printf '%s' sandbox-container ;;
    'top sandbox-container -eo pid,comm') printf '%s\\n' 'PID COMMAND' '1 node' ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args required sandbox
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No-network OCR sandbox/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /direct Tesseract probe is forbidden/u);
});

test('legacy rollback keeps exact language smoke while new images require the raster marker', () => {
  const legacy = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_smoke_media_analysis_tesseract compose_args if-present
`);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /legacy .* image: rus\+eng; raster smoke unavailable/u);

  const enforcingLegacy = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 1 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args if-present; then exit 9; fi
`);
  assert.equal(enforcingLegacy.status, 0, enforcingLegacy.stderr);
  assert.match(enforcingLegacy.stderr, /must match the reviewed OCR deployment mode/u);

  const required = runTopologyProbe(`
docker() {
  case "$*" in
    *'COMMERCIAL_OCR_TESSERACT_BINARY'*) printf '%s' 'tesseract' ;;
    *'--list-langs'*) printf '%s\\n' 'List of available languages (2):' eng rus ;;
    *'COMMERCIAL_OCR_ROLLOUT_MODE'*) return 0 ;;
    *'if [ -f apps/api/dist/apps/api/src/scripts/smoke-commercial-ocr-worker.js ]'*) printf '%s' absent ;;
    *) return 8 ;;
  esac
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_smoke_media_analysis_tesseract compose_args required; then exit 9; fi
`);
  assert.equal(required.status, 0, required.stderr);
  assert.match(required.stderr, /missing the required native OCR worker raster smoke/u);
});

test('shadow preflight is fail-closed without printing the effective value', () => {
  const shadow = runTopologyProbe(`
docker() {
  printf '%s' '{"services":{"api-media-analysis":{"environment":{"COMMERCIAL_OCR_ROLLOUT_MODE":"shadow"}}}}'
}
compose_args=(-p infra -f infra/docker-compose.yml)
maxim_topology_require_media_analysis_shadow_config compose_args
`);
  assert.equal(shadow.status, 0, shadow.stderr);

  const enforcing = runTopologyProbe(`
docker() {
  printf '%s' '{"services":{"api-media-analysis":{"environment":{"COMMERCIAL_OCR_ROLLOUT_MODE":"canary-sensitive-value"}}}}'
}
compose_args=(-p infra -f infra/docker-compose.yml)
if maxim_topology_require_media_analysis_shadow_config compose_args; then exit 9; fi
`);
  assert.equal(enforcing.status, 0, enforcing.stderr);
  assert.match(enforcing.stderr, /effective COMMERCIAL_OCR_ROLLOUT_MODE=shadow/u);
  assert.doesNotMatch(`${enforcing.stdout}${enforcing.stderr}`, /canary-sensitive-value/u);
});

test('deploy and rollback pin OCR identity and order media before webhook roles', () => {
  const topology = read('infra/scripts/lib/deploy-topology.sh');
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const scaleDeploy = read('infra/scripts/vps-pull-build-up-scale.sh');
  const immutableRollback = read('infra/scripts/vps-release-rollback.sh');
  const refRollback = read('infra/scripts/vps-runtime-rollback.sh');

  assert.match(topology, /maxim_topology_git_commercial_ocr_version "\$commit_sha"/u);
  assert.match(topology, /maxim_topology_smoke_ocr_native_sandbox_uds\(\)/u);
  assert.match(
    topology,
    /run --rm --no-deps --pull never[\s\S]*--entrypoint node "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(topology, /docker ps --no-trunc -q --filter "volume=\$socket_volume_name"/u);
  assert.match(deploy, /maxim_topology_prepare_commercial_ocr_target/u);
  assert.match(topology, /export COMMERCIAL_OCR_VERSION="\$resolved_version"/u);
  assert.match(deploy, /DEPLOY_RUNTIME_STARTED=0/u);
  assert.match(deploy, /DEPLOY_MANIFEST_RECORDED=0/u);
  assert.match(deploy, /invalidate_stale_release_inventory/u);
  assert.match(deploy, /current\.invalid-deploy-/u);
  assert.match(deploy, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
  assert.ok(
    deploy.lastIndexOf('maxim_topology_prepare_commercial_ocr_target') <
      deploy.lastIndexOf('prepare_deploy_disk_capacity'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      deploy.lastIndexOf('recreate_service_wave "action, publisher and retention"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "ingress"') <
      deploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      deploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      deploy.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      deploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      deploy.lastIndexOf('maxim_webhook_resume_after_api_fence'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "media analysis"') <
      deploy.lastIndexOf('recreate_service_wave "moderation"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "moderation"') <
      deploy.lastIndexOf('recreate_service_wave "enqueue"'),
  );
  assert.ok(
    deploy.lastIndexOf('recreate_service_wave "enqueue"') <
      deploy.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    deploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      deploy.lastIndexOf('record_successful_release'),
  );

  assert.match(scaleDeploy, /maxim_topology_prepare_commercial_ocr_target/u);
  assert.match(
    scaleDeploy,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_prepare_commercial_ocr_target') <
      scaleDeploy.lastIndexOf('prepare_scale_redis_named_volume'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      scaleDeploy.lastIndexOf('recreate_service_wave "worker"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('recreate_service_wave "worker"') <
      scaleDeploy.lastIndexOf('ensure_requested_services_running'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      scaleDeploy.lastIndexOf('recreate_service_wave "worker"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('recreate_service_wave "ingress"') <
      scaleDeploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      scaleDeploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      scaleDeploy.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      scaleDeploy.lastIndexOf('recreate_service_wave "media analysis"'),
  );
  assert.ok(
    scaleDeploy.lastIndexOf('recreate_service_wave "media analysis"') <
      scaleDeploy.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );

  assert.match(
    immutableRollback,
    /maxim_topology_git_compose_has_service "\$API_SOURCE_SHA" "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.ok(
    immutableRollback.indexOf(
      'maxim_topology_require_image_text_stop_list_delete_guard "$API_SOURCE_SHA"',
    ) < immutableRollback.lastIndexOf('begin_release_runtime_transition'),
  );
  assert.match(
    immutableRollback,
    /maxim_topology_remove_service SERVICES "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_git_has_commercial_ocr_raster_smoke "\$API_SOURCE_SHA"/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.match(
    immutableRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES if-present/u,
  );
  assert.ok(
    immutableRollback.indexOf('maxim_topology_prepare_commercial_ocr_target') <
      immutableRollback.indexOf('for component in "${SELECTED_COMPONENTS[@]}"'),
  );
  assert.match(immutableRollback, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(immutableRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(
    immutableRollback,
    /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u,
  );
  assert.match(immutableRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(immutableRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      immutableRollback.lastIndexOf('recreate_service api-admin'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service api-ingress') <
      immutableRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      immutableRollback.lastIndexOf('recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      immutableRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      immutableRollback.lastIndexOf('recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      immutableRollback.lastIndexOf('maxim_webhook_resume_after_api_fence'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service "$MAXIM_MEDIA_ANALYSIS_SERVICE"') <
      immutableRollback.lastIndexOf('recreate_service "$service"'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service "$service"') <
      immutableRollback.lastIndexOf('recreate_service api-enqueue'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('recreate_service api-enqueue') <
      immutableRollback.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    immutableRollback.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      immutableRollback.lastIndexOf('node infra/scripts/release-manifest.mjs'),
  );

  assert.match(
    refRollback,
    /maxim_topology_git_compose_has_service "\$TARGET_FULL_SHA" "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.ok(
    refRollback.indexOf(
      'maxim_topology_require_image_text_stop_list_delete_guard "$TARGET_FULL_SHA"',
    ) < refRollback.indexOf('git switch --detach "$TARGET_FULL_SHA"'),
  );
  assert.match(
    refRollback,
    /maxim_topology_remove_service SERVICES "\$MAXIM_MEDIA_ANALYSIS_SERVICE"/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_git_has_commercial_ocr_raster_smoke "\$TARGET_FULL_SHA"/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u,
  );
  assert.match(
    refRollback,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES if-present/u,
  );
  assert.ok(
    refRollback.indexOf('maxim_topology_prepare_commercial_ocr_target') <
      refRollback.indexOf('git switch --detach'),
  );
  assert.match(refRollback, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(refRollback, /label=com\.docker\.compose\.project=infra/u);
  assert.match(refRollback, /label=com\.docker\.compose\.service=\$MAXIM_MEDIA_ANALYSIS_SERVICE/u);
  assert.match(refRollback, /docker stop --time 30 "\$\{container_ids\[@\]\}"/u);
  assert.match(refRollback, /docker rm -f "\$\{container_ids\[@\]\}"/u);
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_stop_media_analysis_before_api_transition') <
      refRollback.lastIndexOf('recreate_runtime_api_wave non-webhook'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave non-webhook') <
      refRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      refRollback.lastIndexOf('recreate_runtime_api_wave media-analysis'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_recreate_ocr_native_sandbox') <
      refRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      refRollback.lastIndexOf('recreate_runtime_api_wave media-analysis'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_smoke_ocr_native_sandbox_uds') <
      refRollback.lastIndexOf('maxim_webhook_resume_after_api_fence'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave media-analysis') <
      refRollback.lastIndexOf('recreate_runtime_api_wave moderation'),
  );
  assert.ok(
    refRollback.lastIndexOf('recreate_runtime_api_wave moderation') <
      refRollback.lastIndexOf('recreate_runtime_api_wave enqueue'),
  );
  assert.ok(
    refRollback.lastIndexOf('wait_for_service_running "$service" 180') <
      refRollback.lastIndexOf('maxim_topology_verify_api_commercial_ocr_version'),
  );
  assert.ok(
    refRollback.lastIndexOf('maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES') <
      refRollback.lastIndexOf('record_runtime_rollback_release'),
  );
});

test('read-only BullMQ monitor includes commercial image OCR', () => {
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  assert.equal([...monitor.matchAll(/^ {2}commercial-image-ocr$/gmu)].length, 1);
});

test('read-only BullMQ monitor batches counters and includes every Publisher queue', () => {
  const monitor = read('infra/scripts/vps-monitor-readonly.sh');
  const queueBlock = monitor.match(/\nqueues=\(\n(?<queues>[\s\S]*?)\n\)\n/u)?.groups?.queues ?? '';
  assert.notEqual(queueBlock, '');
  assert.equal([...queueBlock.matchAll(/^ {2}moderation-default$/gmu)].length, 1);

  for (const queue of [
    'admin-manual-fanout',
    'admin-manual-commands',
    'publisher-binding-refresh',
    'publisher-chat-comments',
    'publisher-auto-replies',
    'publisher-auto-reply-authoring',
    'publisher-post-import',
    'publisher-publication-wakeup',
    'publisher-suggestion-publication',
    'publisher-suggestion-admin',
    'publisher-start',
    'vk-parsing-publisher',
  ]) {
    assert.equal([...queueBlock.matchAll(new RegExp(`^ {2}${queue}$`, 'gmu'))].length, 1);
  }
  assert.doesNotMatch(monitor, /^ {2}managed-broadcast$/mu);
  assert.match(monitor, /redis-cli --raw eval "\$queue_counts_script"/u);
  assert.match(monitor, /local marker = redis\.call\(\\"LINDEX\\", key, -1\)/u);
  assert.match(monitor, /string\.sub\(marker, 1, 2\) == \\"0:\\"/u);
  assert.match(monitor, /failedTotal=%d/u);
  assert.match(monitor, /failedFresh=%d/u);
  assert.match(monitor, /failedFreshWindowSec=%d/u);
  assert.match(monitor, /failedFuture=%d/u);
  assert.match(monitor, /failedNewestAgeSec=%d/u);
  assert.match(monitor, /redis\.call\(\\"TIME\\"\)/u);
  assert.match(monitor, /ZCOUNT\\", KEYS\[5\], failedFreshCutoffMs, nowMs/u);
  assert.match(monitor, /ZCOUNT\\", KEYS\[5\], \\"\(\\" \.\. tostring\(nowMs\)/u);
  assert.match(monitor, /ZREVRANGE\\", KEYS\[5\], 0, 0, \\"WITHSCORES\\"/u);
  assert.doesNotMatch(monitor, /now_ms=.*date \+%s/u);
  assert.doesNotMatch(monitor, /RPOP/u);
  assert.doesNotMatch(monitor, /redis_count/u);
});

test('production OCR uses a singleton no-network sandbox connected only over UDS', () => {
  for (const [name, path] of [
    ['main', 'infra/docker-compose.yml'],
    ['scale', 'infra/docker-compose.scale.yml'],
  ]) {
    const compose = read(path);
    const media = compose.match(
      /\n {2}api-media-analysis:\n([\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:|\nvolumes:|$)/u,
    )?.[1];
    const sandbox = compose.match(
      /\n {2}ocr-native-sandbox:\n([\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:|\nvolumes:|$)/u,
    )?.[1];

    assert.ok(media, `missing api-media-analysis service in ${name} Compose`);
    assert.ok(sandbox, `missing ocr-native-sandbox service in ${name} Compose`);
    assert.match(
      media,
      /COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH:\s+\/run\/maxim-ocr\/native-ocr\.sock/u,
    );
    assert.match(media, /ocr_native_ipc:\/run\/maxim-ocr:ro/u);
    assert.match(media, /ocr-native-sandbox:\n\s+condition:\s+service_healthy/u);
    assert.doesNotMatch(sandbox, /^\s+env_file:/mu);
    assert.doesNotMatch(sandbox, /^\s+secrets:/mu);
    assert.doesNotMatch(sandbox, /^\s+APP_(?:ROLE|SERVICE_NAME):/mu);
    assert.match(sandbox, /^\s+labels:\n\s+com\.maxim\.ocr-native-sandbox:\s+'true'\s*$/mu);
    assert.match(sandbox, /^\s+network_mode:\s+none\s*$/mu);
    assert.match(sandbox, /^\s+user:\s+'1000:1000'\s*$/mu);
    assert.match(sandbox, /^\s+init:\s+true\s*$/mu);
    assert.match(sandbox, /^\s+deploy:\n\s+replicas:\s+1\s*$/mu);
    assert.match(sandbox, /^\s+COMMERCIAL_OCR_TESSERACT_CONCURRENCY:\s+1\s*$/mu);
    assert.match(sandbox, /^\s+OMP_THREAD_LIMIT:\s+1\s*$/mu);
    assert.match(sandbox, /^\s+read_only:\s+true\s*$/mu);
    assert.match(sandbox, /^\s+cap_drop:\n\s+- ALL\s*$/mu);
    assert.match(
      sandbox,
      new RegExp(
        `^\\s+security_opt:${name === 'scale' ? ' !override' : ''}\\n\\s+- no-new-privileges:true\\s*$`,
        'mu',
      ),
    );
    assert.match(sandbox, /^\s+tmpfs:\n\s+- \/tmp:size=64m,mode=1777,uid=1000,gid=1000\s*$/mu);
    assert.match(sandbox, /ocr_native_ipc:\/run\/maxim-ocr\s*$/mu);
    assert.equal(
      [...compose.matchAll(/^\s+- ocr_native_ipc:\/run\/maxim-ocr(?::ro)?\s*$/gmu)].length,
      2,
      `${name} Compose must expose OCR IPC only to sandbox and media`,
    );
  }
});

test('runtime OCR attestation accepts only Docker empty or none network metadata', () => {
  const topology = read('infra/scripts/lib/deploy-topology.sh');

  assert.match(
    topology,
    /const networkNames = Object\.keys\(sandbox\?\.NetworkSettings\?\.Networks \?\? \{\}\);/u,
  );
  assert.match(topology, /networkNames\.every\(\(networkName\) => networkName === "none"\)/u);
  assert.doesNotMatch(
    topology,
    /Object\.keys\(sandbox\?\.NetworkSettings\?\.Networks \?\? \{\}\)\.length === 0/u,
  );
});

test('native OCR cleanup wait tolerates reaping but rejects a retained process', () => {
  const reaped = runTopologyProbe(`
count_file="$(mktemp)"
printf '0' >"$count_file"
trap 'rm -f "$count_file"' EXIT
docker() {
  local count
  count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  printf '%s\\n' 'PID COMMAND'
  if [[ "$count" -eq 1 ]]; then printf '%s\\n' '1 tesseract'; else printf '%s\\n' '1 node'; fi
}
sleep() { :; }
maxim_topology_wait_for_no_ocr_native_processes sandbox-container 3
cat "$count_file"
`);
  assert.equal(reaped.status, 0, reaped.stderr);
  assert.equal(reaped.stdout.trim(), '2');

  const retained = runTopologyProbe(`
docker() { printf '%s\\n' 'PID COMMAND' '1 tesseract'; }
sleep() { :; }
if maxim_topology_wait_for_no_ocr_native_processes sandbox-container 3; then exit 9; fi
`);
  assert.equal(retained.status, 0, retained.stderr);
});
