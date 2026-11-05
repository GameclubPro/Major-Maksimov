#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { assertHttpInputBoundaries } from '../check-api-http-inputs.mjs';
import { findContractsArchitectureViolations } from '../check-contract-exports.mjs';
import { assertRefactorFileSizeGuards } from '../check-refactor-guards.mjs';
import { assertCommercialOcrDetectorSourceIdentityCurrent } from '../generate-commercial-ocr-detector-source.mjs';
import { renderDeployImpactBash } from './generate-deploy-impact-bash.mjs';

export function runPreflight(root, log = console.log) {
  const checks = [
    ['refactor file size ceilings', () => assertRefactorFileSizeGuards(root)],
    [
      'contracts source/export mappings',
      () => {
        const violations = findContractsArchitectureViolations(root);
        if (violations.length) throw new Error(violations.map((item) => item.message).join('\n'));
      },
    ],
    ['OCR generated source identity', () => assertCommercialOcrDetectorSourceIdentityCurrent(root)],
    [
      'deploy impact generator',
      () => {
        const expected = renderDeployImpactBash(
          readFileSync(resolve(root, 'config/change-impact.json'), 'utf8'),
        );
        if (
          readFileSync(
            resolve(root, 'infra/scripts/lib/change-impact-components.generated.sh'),
            'utf8',
          ) !== expected
        ) {
          throw new Error(
            'Deploy impact mapping is stale. Run: node scripts/agent/generate-deploy-impact-bash.mjs',
          );
        }
      },
    ],
    ['HTTP input boundaries', () => assertHttpInputBoundaries(root)],
  ];
  for (const [label, check] of checks) {
    const start = performance.now();
    check();
    log(`[preflight] ${label}: passed (${Math.round(performance.now() - start)} ms)`);
  }
  log(
    '[preflight] Early checks only; full impact verification and exact-SHA CI are still required.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runPreflight(resolve(import.meta.dirname, '../..'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
