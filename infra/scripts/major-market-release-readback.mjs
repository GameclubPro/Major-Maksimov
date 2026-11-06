#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedFile, canonical, snapshot } from './major-market-release-state.mjs';

const ROOT = '/var/www/Chat_bot';
const MANIFEST = '/var/lib/maxim-deploy/current.json';
const API = [
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
const NATIVE = ['ocr-native-sandbox', 'photo-native-sandbox'];
function fail(message) {
  throw new Error(`Major owner readback: ${message}`);
}
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16777216,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
  } catch {
    fail(`bounded ${command} check failed`);
  }
}
function git(...args) {
  return run('git', ['-C', ROOT, ...args], { maxBuffer: 1048576 }).trim();
}
export function attestRuntime(components, containers, images) {
  if (
    !Array.isArray(containers) ||
    containers.length > 128 ||
    !Array.isArray(images) ||
    images.length > 8
  )
    fail('runtime inventory budget');
  const result = [];
  for (const component of components) {
    const image = images.find((item) => item.Id === component.imageId);
    if (
      !image ||
      image.Config?.Labels?.['org.opencontainers.image.revision'] !== component.sourceSha ||
      image.Config?.Labels?.['com.maxim.release-protected'] !== 'true'
    )
      fail('immutable image labels differ');
    const services = component.id === 'api-shared' ? [...API, ...NATIVE] : [component.id];
    const runtime = [];
    for (const service of services) {
      const matches = containers.filter(
        (item) =>
          item.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
          item.Config?.Labels?.['com.docker.compose.service'] === service,
      );
      if (matches.length !== 1) fail('missing or duplicate runtime service');
      const item = matches[0];
      if (
        !/^[a-f0-9]{64}$/u.test(item.Id ?? '') ||
        item.Image !== component.imageId ||
        item.Config?.Image !== component.imageRef ||
        item.State?.Running !== true ||
        item.State?.Status !== 'running' ||
        item.State?.Paused ||
        item.State?.Restarting ||
        item.State?.Dead ||
        (item.State?.Health && item.State.Health.Status !== 'healthy')
      )
        fail('running image/health differs');
      if (service.startsWith('api-')) {
        const values = (item.Config.Env ?? []).filter((value) =>
          value.startsWith('APP_SERVICE_NAME='),
        );
        if (values.length !== 1 || values[0] !== `APP_SERVICE_NAME=${service}`)
          fail('API runtime role differs');
      }
      runtime.push({
        service,
        id: item.Id,
        imageId: item.Image,
        startedAt: item.State.StartedAt,
        restartCount: item.RestartCount,
      });
    }
    result.push({ ...component, runtime });
  }
  const known = new Set([
    ...API,
    ...NATIVE,
    'miniapp-major-static',
    'admin-static',
    'eraser',
    'postgres',
    'redis',
  ]);
  if (
    containers.some(
      (item) =>
        item.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        /^api-/u.test(item.Config?.Labels?.['com.docker.compose.service'] ?? '') &&
        !known.has(item.Config.Labels['com.docker.compose.service']),
    )
  )
    fail('unexpected API role');
  return result;
}
function inspect(components) {
  const ids = run(
    'docker',
    ['ps', '-a', '--filter', 'label=com.docker.compose.project=infra', '--format', '{{.ID}}'],
    { maxBuffer: 16384 },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!ids.length || ids.length > 128 || ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
    fail('invalid runtime container census');
  const containers = JSON.parse(run('docker', ['inspect', ...ids]));
  const images = JSON.parse(
    run('docker', ['image', 'inspect', ...new Set(components.map((item) => item.imageId))]),
  );
  return attestRuntime(components, containers, images);
}
export function readback(expectedSha, selected) {
  if (
    !/^[a-f0-9]{40}$/u.test(expectedSha ?? '') ||
    !Array.isArray(selected) ||
    selected.join('|') !== [...new Set(selected)].sort().join('|') ||
    selected.some(
      (id) => !['admin-static', 'api-shared', 'eraser', 'miniapp-major-static'].includes(id),
    )
  )
    fail('invalid target/components');
  if (git('rev-parse', 'HEAD') !== expectedSha || git('status', '--porcelain'))
    fail('clean exact controller source required');
  const beforeBytes = boundedFile(MANIFEST);
  const manifest = JSON.parse(beforeBytes);
  const created = Date.parse(manifest.createdAt);
  if (
    !Number.isFinite(created) ||
    new Date(created).toISOString() !== manifest.createdAt ||
    created > Date.now() + 30000 ||
    !Array.isArray(manifest.smokes) ||
    manifest.smokes.some((value) => typeof value !== 'string')
  )
    fail('unsealed/invalid manifest metadata');
  const state = snapshot([]);
  for (const id of selected)
    if (state.state.major.components.find((item) => item.id === id)?.sourceSha !== expectedSha)
      fail('selected runtime source differs');
  if (selected.length && manifest.targetSha !== expectedSha)
    fail('selected manifest target differs');
  const components = inspect(state.state.major.components);
  if (selected.length)
    run(
      'bash',
      [
        resolve(ROOT, 'infra/scripts/major-market-release-readback.sh'),
        expectedSha,
        selected.join(','),
        state.state.major.components.find((item) => item.id === 'api-shared').imageId,
      ],
      { timeout: 300000, maxBuffer: 65536 },
    );
  const after = inspect(state.state.major.components);
  if (
    canonical(components) !== canonical(after) ||
    !beforeBytes.equals(boundedFile(MANIFEST)) ||
    snapshot([]).stateSha256 !== state.stateSha256 ||
    git('rev-parse', 'HEAD') !== expectedSha ||
    git('status', '--porcelain')
  )
    fail('runtime/source/state changed during readback');
  return {
    schemaVersion: 1,
    protocol: 'major-market-owner-readback-v1',
    product: 'major',
    status: 'passed',
    observedAt: new Date().toISOString(),
    controllerSha: expectedSha,
    manifest: {
      createdAt: manifest.createdAt,
      targetSha: manifest.targetSha,
      smokes: manifest.smokes,
    },
    components,
    checks: {
      strictSmokes: selected.length ? 'passed' : 'not-required',
      immutableImages: 'passed',
      stableGenerations: 'passed',
      unselectedComponents: 'passed',
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail('expected SHA and sorted component CSV required');
    process.stdout.write(
      `${JSON.stringify(readback(process.argv[2], process.argv[3] ? process.argv[3].split(',') : []))}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
