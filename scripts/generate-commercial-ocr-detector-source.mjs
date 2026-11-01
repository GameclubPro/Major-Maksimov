#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const outputPath = resolve(
  root,
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-detector-source.generated.ts',
);
const detectorSupportFiles = [
  'apps/api/src/common/url-text.util.ts',
  'packages/contracts/src/url-text.ts',
  'apps/api/src/moderation/commercial-campaign.util.ts',
  'apps/api/src/moderation/duplicate-semantic-text.ts',
  'apps/api/src/moderation/rule-engine-commercial-second-stage-cache.ts',
  'apps/api/src/moderation/rule-engine-commercial-thresholds.ts',
  'apps/api/src/moderation/rule-engine-detection-context.ts',
  'apps/api/src/moderation/moderation-message-length.ts',
  'apps/api/src/moderation/rule-engine-normalization.ts',
];
const policySourceFiles = [
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-album-scheduler.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-decision-policy.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-evidence.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-letter-script.ts',
];
const preprocessSourceFiles = [
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-preprocess-config.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-preprocessor.ts',
  'apps/api/src/moderation/commercial-ocr/native-ocr-image-preprocessor.ts',
  'apps/api/src/moderation/photo-duplicate/photo-image-format.ts',
];
const auditToolDependencyFiles = [
  'packages/contracts/src/safety-desk.ts',
  'packages/contracts/src/commercial-ai-quality.ts',
  'packages/contracts/src/commercial-review-semantics.ts',
  'apps/api/src/moderation/commercial-ocr/commercial-ocr-settings-profile.ts',
  'scripts/generate-commercial-ocr-detector-source.mjs',
];

const runtimeDockerfilePath = 'apps/api/Dockerfile';
const packageLockPath = 'package-lock.json';
const productionComposePath = 'infra/docker-compose.yml';
const productionNativeEnvironmentNames = [
  'COMMERCIAL_OCR_TESSERACT_CONCURRENCY',
  'COMMERCIAL_OCR_TESSERACT_MAX_QUEUE',
  'COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS',
  'OMP_THREAD_LIMIT',
];

export function resolveCommercialOcrDetectorSourceFiles(repositoryRoot = root) {
  const sourceDirectory = resolve(repositoryRoot, 'apps/api/src/moderation/commercial');
  const commercialFiles = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => resolve(sourceDirectory, name));
  return [...commercialFiles, ...detectorSupportFiles.map((path) => resolve(repositoryRoot, path))]
    .map((path) => relative(repositoryRoot, path).split('\\').join('/'))
    .sort((left, right) => left.localeCompare(right));
}

export function calculateCommercialOcrDetectorSourceIdentity(repositoryRoot = root) {
  const files = resolveCommercialOcrDetectorSourceFiles(repositoryRoot);
  return calculateSourceIdentity(repositoryRoot, files);
}

export function resolveCommercialOcrRuntimeSourceFiles(repositoryRoot = root) {
  const sourceDirectory = resolve(repositoryRoot, 'apps/api/src/moderation/commercial-ocr');
  const commercialOcrFiles = readdirSync(sourceDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.generated.ts'),
    )
    .map((entry) => relative(repositoryRoot, resolve(sourceDirectory, entry.name)));
  return [
    ...commercialOcrFiles,
    'apps/api/src/moderation/native-sandbox-recycle.ts',
    'apps/api/src/common/url-text.util.ts',
    'apps/api/src/moderation/rule-engine-blocked-domains.detector.ts',
    'apps/api/src/moderation/rule-engine-blocked-words.detector.ts',
    'apps/api/src/moderation/rule-engine-normalization.ts',
    'apps/api/src/moderation/photo-duplicate/photo-image-format.ts',
    'apps/api/src/moderation/photo-duplicate/secure-photo-downloader.ts',
    'packages/contracts/src/core.ts',
    'packages/contracts/src/settings.ts',
    'packages/contracts/src/settings-field-schemas.ts',
    'packages/contracts/src/channel-settings-field-schemas.ts',
    'packages/contracts/src/settings-message-field-schemas.ts',
    'packages/contracts/src/bot-speech-fields.ts',
    'packages/contracts/src/broadcast-buttons.ts',
    'packages/contracts/src/broadcast-schedule-fields.ts',
    'packages/contracts/src/managed-broadcast-summary.ts',
    'packages/contracts/src/channel-settings.ts',
    'packages/contracts/src/settings-sections.ts',
    'packages/contracts/src/stop-words.ts',
    'packages/contracts/src/stop-words-matcher.ts',
    'packages/contracts/src/stop-words-legacy-phrases.ts',
    'packages/contracts/src/stop-words-legacy.ts',
    'packages/contracts/src/url-text.ts',
    'packages/contracts/src/button-url.ts',
    'packages/contracts/src/broadcast-common.ts',
    'apps/api/src/moderation/stop-words/stop-words.policy.ts',
    'apps/api/src/moderation/stop-words/stop-words.matcher.ts',
  ]
    .map((path) => path.split('\\').join('/'))
    .sort((left, right) => left.localeCompare(right));
}

export function resolveCommercialOcrAuditToolSourceFiles(repositoryRoot = root) {
  const scriptsDirectory = resolve(repositoryRoot, 'apps/api/src/scripts');
  const evalDirectory = resolve(repositoryRoot, 'apps/api/src/moderation/commercial-ocr/eval');
  const scriptFiles = readdirSync(scriptsDirectory)
    .filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.spec.ts') &&
        (name.startsWith('commercial-') ||
          name === 'run-commercial-ocr-eval.ts' ||
          name === 'sign-commercial-ocr-certification.ts' ||
          name === 'verify-commercial-ocr-certification.ts' ||
          /^(?:audit|build|evaluate|export|remap|replay|report|validate)-commercial-/u.test(name)),
    )
    .map((name) => relative(repositoryRoot, resolve(scriptsDirectory, name)));
  const evalFiles = readdirSync(evalDirectory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => relative(repositoryRoot, resolve(evalDirectory, name)));
  return [...scriptFiles, ...evalFiles, ...auditToolDependencyFiles]
    .map((path) => path.split('\\').join('/'))
    .sort((left, right) => left.localeCompare(right));
}

export function calculateCommercialOcrSourceIdentities(repositoryRoot = root) {
  return {
    detector: calculateSourceIdentity(
      repositoryRoot,
      resolveCommercialOcrDetectorSourceFiles(repositoryRoot),
    ),
    runtime: calculateSourceIdentity(
      repositoryRoot,
      resolveCommercialOcrRuntimeSourceFiles(repositoryRoot),
    ),
    policy: calculateSourceIdentity(repositoryRoot, policySourceFiles),
    preprocess: calculateSourceIdentity(repositoryRoot, preprocessSourceFiles),
    auditTool: calculateSourceIdentity(
      repositoryRoot,
      resolveCommercialOcrAuditToolSourceFiles(repositoryRoot),
    ),
  };
}

export function resolveCommercialOcrBuildIdentity(repositoryRoot = root) {
  const dockerfile = readFileSync(resolve(repositoryRoot, runtimeDockerfilePath), 'utf8');
  const packageLock = JSON.parse(readFileSync(resolve(repositoryRoot, packageLockPath), 'utf8'));
  const runtimeBaseImageMatch = dockerfile.match(
    /^FROM\s+([^\s@]+)@(sha256:[a-f0-9]{64})\s+AS\s+runtime\s*$/mu,
  );
  if (!runtimeBaseImageMatch) {
    throw new Error('API runtime base image must be pinned by SHA-256 in apps/api/Dockerfile');
  }

  return {
    nodeBaseImage: {
      reference: runtimeBaseImageMatch[1],
      digest: runtimeBaseImageMatch[2],
    },
    packages: {
      sharp: resolveLockedNpmPackage(packageLock, 'sharp'),
      tesseract: resolvePinnedApkPackage(dockerfile, 'tesseract-ocr'),
      traineddataEng: resolvePinnedApkPackage(dockerfile, 'tesseract-ocr-data-eng'),
      traineddataRus: resolvePinnedApkPackage(dockerfile, 'tesseract-ocr-data-rus'),
    },
  };
}

export function resolveCommercialOcrProductionNativeEnvironment(repositoryRoot = root) {
  const compose = readFileSync(resolve(repositoryRoot, productionComposePath), 'utf8');
  const serviceStart = compose.indexOf('\n  api-media-analysis:');
  if (serviceStart < 0) {
    throw new Error('infra/docker-compose.yml has no api-media-analysis service');
  }
  const followingService = compose.indexOf('\n  api-', serviceStart + 1);
  const service = compose.slice(
    serviceStart,
    followingService < 0 ? compose.length : followingService,
  );
  return Object.fromEntries(
    productionNativeEnvironmentNames.map((name) => {
      const match = service.match(new RegExp(`^\\s{6}${name}: ['"]?([0-9]+)['"]?\\s*$`, 'mu'));
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
        throw new Error(`api-media-analysis must pin ${name} to a positive integer`);
      }
      return [name, Number(match[1])];
    }),
  );
}

function resolveLockedNpmPackage(packageLock, packageName) {
  const entry = packageLock?.packages?.[`node_modules/${packageName}`];
  if (
    !entry ||
    typeof entry.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(entry.version) ||
    typeof entry.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
  ) {
    throw new Error(`package-lock.json has no canonical ${packageName} package identity`);
  }
  return { name: packageName, version: entry.version, integrity: entry.integrity };
}

function resolvePinnedApkPackage(dockerfile, packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = dockerfile.match(
    new RegExp(`(?:^|\\s)${escapedName}=([A-Za-z0-9][A-Za-z0-9._+~-]*)`, 'u'),
  );
  if (!match) {
    throw new Error(`${packageName} must be pinned to an exact APK version in apps/api/Dockerfile`);
  }
  return { name: packageName, version: match[1] };
}

function calculateSourceIdentity(repositoryRoot, files) {
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(resolve(repositoryRoot, path)));
    hash.update('\0');
  }
  return {
    sourceSha256: hash.digest('hex'),
    sourceFileCount: files.length,
  };
}

export function renderCommercialOcrDetectorSourceIdentity(repositoryRoot = root) {
  const identities = calculateCommercialOcrSourceIdentities(repositoryRoot);
  const buildIdentity = resolveCommercialOcrBuildIdentity(repositoryRoot);
  const productionNativeEnvironment =
    resolveCommercialOcrProductionNativeEnvironment(repositoryRoot);
  return [
    '// Generated by scripts/generate-commercial-ocr-detector-source.mjs. Do not edit by hand.',
    `export const COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 = '${identities.detector.sourceSha256}' as const;`,
    `export const COMMERCIAL_OCR_DETECTOR_SOURCE_FILE_COUNT = ${identities.detector.sourceFileCount} as const;`,
    `export const COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256 = '${identities.runtime.sourceSha256}' as const;`,
    `export const COMMERCIAL_OCR_RUNTIME_SOURCE_FILE_COUNT = ${identities.runtime.sourceFileCount} as const;`,
    `export const COMMERCIAL_OCR_POLICY_SOURCE_SHA256 = '${identities.policy.sourceSha256}' as const;`,
    `export const COMMERCIAL_OCR_POLICY_SOURCE_FILE_COUNT = ${identities.policy.sourceFileCount} as const;`,
    `export const COMMERCIAL_OCR_PREPROCESS_SOURCE_SHA256 = '${identities.preprocess.sourceSha256}' as const;`,
    `export const COMMERCIAL_OCR_PREPROCESS_SOURCE_FILE_COUNT = ${identities.preprocess.sourceFileCount} as const;`,
    `export const COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_SHA256 = '${identities.auditTool.sourceSha256}' as const;`,
    `export const COMMERCIAL_OCR_AUDIT_TOOL_SOURCE_FILE_COUNT = ${identities.auditTool.sourceFileCount} as const;`,
    `export const COMMERCIAL_OCR_BUILD_IDENTITY = ${JSON.stringify(buildIdentity, null, 2)} as const;`,
    `export const COMMERCIAL_OCR_PRODUCTION_NATIVE_ENVIRONMENT = ${JSON.stringify(productionNativeEnvironment, null, 2)} as const;`,
    '',
  ].join('\n');
}

export function assertCommercialOcrDetectorSourceIdentityCurrent(repositoryRoot = root) {
  const expected = renderCommercialOcrDetectorSourceIdentity(repositoryRoot);
  const target = resolve(
    repositoryRoot,
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-detector-source.generated.ts',
  );
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== expected) {
    throw new Error(
      'Commercial OCR detector source identity is stale. Run: node scripts/generate-commercial-ocr-detector-source.mjs',
    );
  }
}

function runCli(argv) {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}`);
  }
  if (argv.includes('--check')) {
    assertCommercialOcrDetectorSourceIdentityCurrent(root);
    return;
  }
  writeFileSync(outputPath, renderCommercialOcrDetectorSourceIdentity(root));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
