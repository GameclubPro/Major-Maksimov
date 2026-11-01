import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import sharp from 'sharp';

import {
  createCommercialOcrNativeBuildManifest,
  serializeCommercialOcrNativeBuildManifest,
} from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';
import {
  calculateCommercialAuditToolSourceDigest,
  calculateCommercialDetectorSourceDigest,
  calculateCommercialOcrSourceDigest,
  COMMERCIAL_OCR_RUNTIME_SOURCE_FILES,
  COMMERCIAL_RUN_PROVENANCE_PROBE_TIMEOUT_MS,
  resolveCommercialOcrEvalRunProvenance,
  resolveCommercialRunProvenance,
} from './commercial-run-provenance.util';

const REPOSITORY_ROOT = resolve(__dirname, '../../../..');

describe('commercial run provenance', () => {
  it('binds a run to detector sources and explicit policy versions', async () => {
    const startedAt = '2026-07-23T18:00:00.000Z';
    const provenance = await resolveCommercialRunProvenance({
      startedAt,
      repositoryRoot: REPOSITORY_ROOT,
    });

    expect(provenance).toEqual(
      expect.objectContaining({
        startedAt,
        git: expect.objectContaining({
          commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
          dirty: expect.any(Boolean),
        }),
        detector: expect.objectContaining({
          digestKind: 'SOURCE_FILES',
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          decisionVersion: 'commercial-deterministic-v5',
          patternPolicyVersion: 'commercial-patterns-v2',
          classifierVersion: '2026-service-private-v6',
        }),
        auditTool: {
          digestKind: 'SOURCE_FILES',
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      }),
    );
  });

  it('calculates a deterministic detector source digest', async () => {
    const first = await calculateCommercialDetectorSourceDigest(REPOSITORY_ROOT);
    const second = await calculateCommercialDetectorSourceDigest(REPOSITORY_ROOT);

    expect(first).toEqual(second);
    expect(first.digestKind).toBe('SOURCE_FILES');
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('calculates a deterministic audit-tool source digest', async () => {
    const first = await calculateCommercialAuditToolSourceDigest(REPOSITORY_ROOT);
    const second = await calculateCommercialAuditToolSourceDigest(REPOSITORY_ROOT);

    expect(first).toEqual(second);
    expect(first.digestKind).toBe('SOURCE_FILES');
    expect(first.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds the audit digest to the eval schema, runner, gates, and CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-tool-provenance-'));
    const sources = [
      'apps/api/src/moderation/commercial-ocr/eval/commercial-ocr-eval.schema.ts',
      'apps/api/src/moderation/commercial-ocr/eval/commercial-ocr-eval-runner.ts',
      'apps/api/src/moderation/commercial-ocr/eval/commercial-ocr-eval-gates.ts',
      'apps/api/src/scripts/run-commercial-ocr-eval.ts',
    ];

    try {
      for (const relativePath of sources) {
        const pathname = join(directory, relativePath);
        await mkdir(dirname(pathname), { recursive: true });
        await writeFile(pathname, `export const source = ${JSON.stringify(relativePath)};\n`);
      }
      const baseline = await calculateCommercialAuditToolSourceDigest(directory);
      for (const relativePath of sources) {
        const pathname = join(directory, relativePath);
        const original = `export const source = ${JSON.stringify(relativePath)};\n`;
        await writeFile(pathname, `${original}export const changed = true;\n`);
        const changed = await calculateCommercialAuditToolSourceDigest(directory);
        expect(changed).toMatchObject({ digestKind: 'SOURCE_FILES' });
        expect(changed.sourceSha256).not.toBe(baseline.sourceSha256);
        await writeFile(pathname, original);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('changes the detector digest when shared normalization changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-provenance-normalization-'));
    const normalizationPath = join(
      directory,
      'apps/api/src/moderation/rule-engine-normalization.ts',
    );
    const sourceFiles = [
      'apps/api/src/common/url-text.util.ts',
      'apps/api/src/moderation/commercial-campaign.util.ts',
      'apps/api/src/moderation/commercial/example.ts',
      'apps/api/src/moderation/rule-engine-commercial-second-stage-cache.ts',
      'apps/api/src/moderation/rule-engine-commercial-thresholds.ts',
      'apps/api/src/moderation/rule-engine-detection-context.ts',
      'apps/api/src/moderation/rule-engine-normalization.ts',
    ];

    try {
      for (const relativePath of sourceFiles) {
        const pathname = join(directory, relativePath);
        await mkdir(dirname(pathname), { recursive: true });
        await writeFile(pathname, `export const source = ${JSON.stringify(relativePath)};\n`);
      }
      const before = await calculateCommercialDetectorSourceDigest(directory);
      await writeFile(normalizationPath, 'export const source = "changed";\n');
      const after = await calculateCommercialDetectorSourceDigest(directory);

      expect(before.digestKind).toBe('SOURCE_FILES');
      expect(after.digestKind).toBe('SOURCE_FILES');
      expect(after.sourceSha256).not.toBe(before.sourceSha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds the OCR digest to runtime-only adapter and worker orchestration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-ocr-provenance-'));
    const adapterPath = join(
      directory,
      'apps/api/src/moderation/commercial-ocr/native-tesseract-ocr.adapter.ts',
    );

    try {
      for (const relativePath of COMMERCIAL_OCR_RUNTIME_SOURCE_FILES) {
        const pathname = join(directory, relativePath);
        await mkdir(dirname(pathname), { recursive: true });
        await writeFile(pathname, `export const source = ${JSON.stringify(relativePath)};\n`);
      }
      const before = await calculateCommercialOcrSourceDigest(directory);
      await writeFile(adapterPath, 'export const source = "runtime-deadline-changed";\n');
      const after = await calculateCommercialOcrSourceDigest(directory);

      expect(before.digestKind).toBe('SOURCE_FILES');
      expect(after.digestKind).toBe('SOURCE_FILES');
      expect(after.sourceSha256).not.toBe(before.sourceSha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures Tesseract inventory, traineddata digests, and normalized artifact identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-ocr-runtime-provenance-'));
    const binaryPath = join(directory, 'fake-tesseract');
    const manifestPath = join(directory, 'manifest.json');
    const nativeBuildManifestPath = join(directory, 'native-build-manifest.json');
    const tessdataPath = join(directory, 'tessdata');
    const manifest = '{"schemaVersion":2}\n';
    const rusTraineddata = 'rus-traineddata';
    const engTraineddata = 'eng-traineddata';
    const binarySource = [
      '#!/bin/sh',
      'case "$1" in',
      "  --version) printf 'tesseract 5.5.2\\n' ;;",
      '  --list-langs) printf \'List of available languages in "%s" (2):\\neng\\nrus\\n\' "$TESSDATA_PREFIX" ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n');

    try {
      await mkdir(tessdataPath, { recursive: true });
      await writeFile(manifestPath, manifest);
      await writeFile(join(tessdataPath, 'rus.traineddata'), rusTraineddata);
      await writeFile(join(tessdataPath, 'eng.traineddata'), engTraineddata);
      await writeFile(binaryPath, binarySource);
      await chmod(binaryPath, 0o755);
      await writeFile(
        nativeBuildManifestPath,
        serializeCommercialOcrNativeBuildManifest(
          createCommercialOcrNativeBuildManifest({
            runtime: {
              nodeVersion: process.version,
              platform: process.platform,
              architecture: process.arch,
              sharpVersion: sharp.versions.sharp!,
              libvipsVersion: sharp.versions.vips!,
            },
            tesseract: {
              version: 'tesseract 5.5.2',
              binarySha256: sha256(binarySource),
              availableLanguages: ['eng', 'rus'],
              traineddataSha256: {
                rus: sha256(rusTraineddata),
                eng: sha256(engTraineddata),
              },
            },
          }),
        ),
      );

      const provenance = await resolveCommercialOcrEvalRunProvenance({
        manifestPath,
        nativeBuildManifestPath,
        repositoryRoot: REPOSITORY_ROOT,
        immutableImageSha256: 'AB'.repeat(32),
        sourceSha: 'CD'.repeat(20),
        execution: {
          tesseractBinary: binaryPath,
          tessdataPrefix: tessdataPath,
          timeoutMs: 10_000,
          maxSourceImageBytes: 16 * 1024 * 1024,
          maxImageBytes: 16 * 1024 * 1024,
          maxOutputBytes: 4 * 1024 * 1024,
          maxInputPixels: 40_000_000,
          maxOutputPixels: 3_000_000,
          maxSide: 2_000,
          ompThreadLimit: 1,
          nativeConcurrency: 1,
          nativeMaxQueue: 4,
          nativeRecycleAfterJobs: 250,
          sharpConcurrency: 1,
          sharpProcessingTimeoutSeconds: 5,
          evalConcurrency: 1,
        },
      });

      expect(COMMERCIAL_RUN_PROVENANCE_PROBE_TIMEOUT_MS).toBe(5_000);
      expect(provenance.artifact).toEqual({
        manifestSha256: sha256(manifest),
        immutableImageSha256: 'ab'.repeat(32),
        sourceSha: 'cd'.repeat(20),
      });
      expect(provenance.runtime).toMatchObject({
        nodeVersion: process.version,
        sharpVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        libvipsVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        tesseractVersion: 'tesseract 5.5.2',
      });
      expect(provenance.tesseract).toMatchObject({
        availableLanguages: ['eng', 'rus'],
        binarySha256: sha256(binarySource),
        traineddataSha256: {
          rus: sha256(rusTraineddata),
          eng: sha256(engTraineddata),
        },
      });
      expect(provenance.behaviorIdentity).toMatchObject({
        fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        nativeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        nativeVerification: { verified: true, status: 'verified', mismatches: [] },
      });
      expect(provenance.sourceImages.allowedFormats).toEqual([
        'jpeg',
        'png',
        'webp',
        'gif',
        'avif',
        'heif',
        'tiff',
      ]);
      expect(provenance.tesseract.resourceLimits.maxSourceImageBytes).toBe(16 * 1024 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
