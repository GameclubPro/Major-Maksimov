#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACTIVE_RELEASE_COMPONENTS = Object.freeze([
  'api-shared',
  'miniapp-major-static',
  'admin-static',
]);
export const OPTIONAL_RELEASE_COMPONENTS = Object.freeze(['eraser']);
const activeComponentSet = new Set([...ACTIVE_RELEASE_COMPONENTS, ...OPTIONAL_RELEASE_COMPONENTS]);
const releaseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const fullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|unknown)$/u;
const recoveryBaseNamePattern =
  /^current\.invalid-(?:deploy|release-rollback(?:-(?:api|static))?|runtime-rollback)-\d{8}T\d{6}Z-\d+\.json$/u;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readCurrentManifest(stateDir) {
  const path = resolve(stateDir, 'current.json');
  return existsSync(path) ? readJson(path) : null;
}

export function readReleaseManifest(stateDir, releaseId) {
  assertReleaseId(releaseId);
  const path = resolve(stateDir, 'releases', `${releaseId}.json`);
  if (!existsSync(path)) {
    throw new Error(`Release manifest not found: ${releaseId}`);
  }
  return readJson(path);
}

export function readManifestFile(path) {
  const manifest = readJson(resolve(path));
  validateManifest(manifest);
  return manifest;
}

export function readTransitionBaseManifest(path) {
  const manifest = readManifestFile(path);
  validateCompleteReleaseManifest(manifest, { allowUnknown: true });
  return manifest;
}

export function readRecoveryBaseManifest(path) {
  const manifest = readManifestFile(path);
  validateCompleteReleaseManifest(manifest);
  return manifest;
}

export function validateCompleteReleaseManifest(manifest, { allowUnknown = false } = {}) {
  validateManifest(manifest);
  const knownFullShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (!allowUnknown && !knownFullShaPattern.test(manifest.targetSha)) {
    throw new Error('Complete release targetSha must be known.');
  }
  for (const id of [
    ...ACTIVE_RELEASE_COMPONENTS,
    ...OPTIONAL_RELEASE_COMPONENTS.filter((id) => manifest.components?.[id]),
  ]) {
    const component = manifest.components?.[id];
    if (!component) {
      throw new Error(`Release manifest is missing active component: ${id}`);
    }
    if (!allowUnknown && !knownFullShaPattern.test(component.sourceSha)) {
      throw new Error(`Complete release ${id} sourceSha must be known.`);
    }
    if (!allowUnknown && !/^sha256:[0-9a-f]{64}$/u.test(component.imageId)) {
      throw new Error(`Complete release ${id} imageId must be known.`);
    }
  }
  return manifest;
}

export function beginReleaseTransition({ stateDir, kind, now = new Date(), pid = process.pid }) {
  if (
    ![
      'deploy',
      'release-rollback',
      'release-rollback-api',
      'release-rollback-static',
      'runtime-rollback',
    ].includes(kind)
  ) {
    throw new Error(`Unknown release transition kind: ${kind}`);
  }
  const currentPath = resolve(stateDir, 'current.json');
  if (!existsSync(currentPath)) {
    throw new Error('Current release manifest is missing before runtime mutation.');
  }
  readTransitionBaseManifest(currentPath);
  const unresolvedRecoveryBases = listRecoveryBaseManifestPaths(stateDir);
  if (unresolvedRecoveryBases.length > 0) {
    throw new Error(
      `Current release coexists with ${unresolvedRecoveryBases.length} unresolved transition journal(s).`,
    );
  }
  const timestamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const normalizedPid = Number.isSafeInteger(Number(pid)) && Number(pid) >= 0 ? Number(pid) : 0;
  const recoveryPath = resolve(
    stateDir,
    `current.invalid-${kind}-${timestamp}-${normalizedPid}.json`,
  );
  if (existsSync(recoveryPath)) {
    throw new Error(`Release transition journal already exists: ${basename(recoveryPath)}`);
  }
  syncPath(currentPath);
  renameSync(currentPath, recoveryPath);
  syncDirectory(stateDir);
  return recoveryPath;
}

export function archiveReleaseTransition({
  stateDir,
  recoveryPath,
  disposition = 'recovered',
  now = new Date(),
  pid = process.pid,
}) {
  const resolvedStateDir = resolve(stateDir);
  const resolvedRecoveryPath = resolve(recoveryPath);
  if (
    dirname(resolvedRecoveryPath) !== resolvedStateDir ||
    !recoveryBaseNamePattern.test(basename(resolvedRecoveryPath))
  ) {
    throw new Error(
      'Release transition archive requires a typed journal in the release state dir.',
    );
  }
  if (!['recovered', 'superseded'].includes(disposition)) {
    throw new Error(`Unknown release transition archive disposition: ${disposition}`);
  }

  const recoveryManifest = readTransitionBaseManifest(resolvedRecoveryPath);
  const currentManifest = readCurrentManifest(resolvedStateDir);
  if (!currentManifest) {
    throw new Error(
      'A completed current release is required before archiving a transition journal.',
    );
  }
  validateCompleteReleaseManifest(currentManifest);
  const currentCreatedAtMs = Date.parse(currentManifest.createdAt);
  const recoveryCreatedAtMs = Date.parse(recoveryManifest.createdAt);
  if (
    !Number.isFinite(currentCreatedAtMs) ||
    !Number.isFinite(recoveryCreatedAtMs) ||
    currentManifest.releaseId === recoveryManifest.releaseId ||
    currentCreatedAtMs < recoveryCreatedAtMs
  ) {
    throw new Error('Current release does not supersede the transition journal.');
  }

  const timestamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const normalizedPid = Number.isSafeInteger(Number(pid)) && Number(pid) >= 0 ? Number(pid) : 0;
  const archivedPath = `${resolvedRecoveryPath}.${disposition}-${timestamp}-${normalizedPid}`;
  if (existsSync(archivedPath)) {
    throw new Error(`Release transition archive already exists: ${basename(archivedPath)}`);
  }

  syncPath(resolvedRecoveryPath);
  renameSync(resolvedRecoveryPath, archivedPath);
  syncDirectory(resolvedStateDir);
  return archivedPath;
}

export function listRecoveryBaseManifestPaths(stateDir) {
  if (!existsSync(stateDir)) {
    return [];
  }
  return readdirSync(stateDir)
    .filter((name) => recoveryBaseNamePattern.test(name))
    .map((name) => resolve(stateDir, name));
}

export function isArchivedReleaseTransitionName(name) {
  if (typeof name !== 'string' || /[\r\n]/u.test(name)) return false;
  const suffix = /\.(?:recovered|superseded)-\d{8}T\d{6}Z-\d+$/u.exec(name);
  return suffix !== null && recoveryBaseNamePattern.test(name.slice(0, suffix.index));
}

export function findRecoveryBaseManifest(stateDir, { allowUnknown = false } = {}) {
  const candidates = listRecoveryBaseManifestPaths(stateDir);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Explicit release recovery requires exactly one invalid current manifest; found ${candidates.length}.`,
    );
  }
  if (allowUnknown) {
    readTransitionBaseManifest(candidates[0]);
  } else {
    readRecoveryBaseManifest(candidates[0]);
  }
  return candidates[0];
}

export function buildReleaseManifest({
  releaseId,
  targetSha,
  current = null,
  components,
  migrations = null,
  smokes = [],
  emergencyReason = null,
  createdAt = new Date().toISOString(),
}) {
  assertReleaseId(releaseId);
  if (!fullShaPattern.test(targetSha)) {
    throw new Error('targetSha must be a full lowercase Git object id or unknown.');
  }
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('At least one release component is required.');
  }

  const mergedComponents = { ...(current?.components ?? {}) };
  for (const component of components) {
    validateComponent(component);
    mergedComponents[component.id] = Object.freeze({
      sourceSha: component.sourceSha,
      imageRef: component.imageRef,
      imageId: component.imageId,
      recordedAt: createdAt,
      ...(component.registryProvenance
        ? { registryProvenance: structuredClone(component.registryProvenance) }
        : {}),
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    releaseId,
    createdAt,
    targetSha,
    emergencyReason: emergencyReason?.trim() || null,
    components: Object.freeze(mergedComponents),
    migrations: Object.freeze(
      [...new Set((migrations ?? current?.migrations ?? []).filter(Boolean))].sort(),
    ),
    smokes: Object.freeze([...new Set(smokes.filter(Boolean))].sort()),
  });
}

export function commitReleaseManifest({ stateDir, manifest, retain = 5 }) {
  validateManifest(manifest);
  mkdirSync(resolve(stateDir, 'releases'), { recursive: true, mode: 0o750 });
  const releasePath = resolve(stateDir, 'releases', `${manifest.releaseId}.json`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  if (existsSync(releasePath)) {
    if (readFileSync(releasePath, 'utf8') !== serialized) {
      throw new Error(`Release id already exists with different content: ${manifest.releaseId}`);
    }
  } else {
    writeAtomic(releasePath, serialized);
  }

  writeAtomic(resolve(stateDir, 'current.json'), serialized);
  pruneOldManifests(stateDir, retain, manifest.releaseId);
  return releasePath;
}

export function listRetentionProtectionManifestPaths(stateDir) {
  if (!existsSync(stateDir)) return [];
  const currentPath = resolve(stateDir, 'current.json');
  return [
    ...(existsSync(currentPath) ? [currentPath] : []),
    ...readdirSync(stateDir)
      .filter((name) => name.startsWith('current.invalid-') && name.endsWith('.json'))
      .sort()
      .map((name) => resolve(stateDir, name)),
  ];
}

export function getReleaseComponentHistory(manifests) {
  return Object.freeze(
    [
      ...ACTIVE_RELEASE_COMPONENTS,
      ...OPTIONAL_RELEASE_COMPONENTS.filter((id) =>
        manifests.some((manifest) => manifest.components?.[id]),
      ),
    ].map((component) => {
      const imageIds = new Set(
        manifests
          .map((manifest) => manifest.components?.[component]?.imageId)
          .filter((id) => typeof id === 'string' && /^sha256:[0-9a-f]{64}$/u.test(id)),
      );
      return Object.freeze({
        component,
        distinctKnownImages: imageIds.size,
        state: imageIds.size >= 2 ? 'present' : 'missing',
      });
    }),
  );
}

export function getRetentionJournalState(manifestPaths, manifests) {
  let found = false;
  for (const [index, path] of manifestPaths.entries()) {
    if (!basename(path).startsWith('current.invalid-')) continue;
    found = true;
    if (!recoveryBaseNamePattern.test(basename(path))) return 'unverified';
    try {
      validateCompleteReleaseManifest(manifests[index]);
    } catch {
      return 'unverified';
    }
  }
  return found ? 'verified' : 'none';
}

export function pruneOldManifests(stateDir, retain = 5, currentReleaseId = null) {
  if (!Number.isSafeInteger(retain) || retain < 5) {
    throw new Error('Release manifest retention must be at least 5.');
  }
  const releasesDir = resolve(stateDir, 'releases');
  if (!existsSync(releasesDir)) {
    return [];
  }
  const entries = readdirSync(releasesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const manifest = readManifestFile(resolve(releasesDir, name));
      if (!Number.isFinite(Date.parse(manifest.createdAt)))
        throw new Error('Retained release manifest has an invalid createdAt.');
      return { name, manifest };
    })
    .sort((left, right) => {
      const timeOrder = String(right.manifest.createdAt).localeCompare(
        String(left.manifest.createdAt),
      );
      return timeOrder || right.name.localeCompare(left.name);
    });
  const protectedPaths = listRetentionProtectionManifestPaths(stateDir);
  const protectedManifests = protectedPaths.map(readManifestFile);
  const journalState = getRetentionJournalState(protectedPaths, protectedManifests);
  const history = getReleaseComponentHistory([
    ...entries.map(({ manifest }) => manifest),
    ...protectedManifests.filter(
      (manifest, index) =>
        getRetentionJournalState([protectedPaths[index]], [manifest]) !== 'unverified',
    ),
  ]);
  // FLAG: Known image history preserves availability only. API schema/source-floor
  // compatibility remains the responsibility of the existing rollback preflights.
  if (journalState === 'unverified' || history.some(({ state }) => state === 'missing')) {
    for (const item of history) {
      process.stderr.write(
        `Release component history ${item.component}: distinct_known_images=${item.distinctKnownImages} state=${item.state}\n`,
      );
    }
    process.stderr.write(`Release journal history: state=${journalState}\n`);
    process.stderr.write(`Release history missing; preserved ${entries.length} manifests.\n`);
    return [];
  }
  const keep = new Set(entries.slice(0, retain).map(({ name }) => name));
  if (currentReleaseId) {
    keep.add(`${currentReleaseId}.json`);
  }
  for (const manifest of protectedManifests) keep.add(`${manifest.releaseId}.json`);
  for (const component of ACTIVE_RELEASE_COMPONENTS) {
    const seenImageIds = new Set();
    for (const { name, manifest } of entries) {
      const imageId = manifest.components?.[component]?.imageId;
      if (!/^sha256:[0-9a-f]{64}$/u.test(imageId ?? '') || seenImageIds.has(imageId)) continue;
      seenImageIds.add(imageId);
      keep.add(name);
      if (seenImageIds.size >= 2) break;
    }
  }
  const removed = [];
  for (const { name } of entries) {
    if (keep.has(name)) {
      continue;
    }
    rmSync(resolve(releasesDir, name));
    removed.push(name);
  }
  return removed;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error('Release manifest schemaVersion must be 1.');
  }
  assertReleaseId(manifest.releaseId);
  if (!fullShaPattern.test(manifest.targetSha)) {
    throw new Error('Release manifest has an invalid targetSha.');
  }
  for (const [id, component] of Object.entries(manifest.components ?? {})) {
    validateComponent({ id, ...component });
  }
}

function validateComponent(component) {
  if (!activeComponentSet.has(component.id)) {
    throw new Error(`Unknown release component: ${component.id}`);
  }
  if (!fullShaPattern.test(component.sourceSha)) {
    throw new Error(`${component.id} sourceSha must be a full Git object id or unknown.`);
  }
  if (typeof component.imageRef !== 'string' || !component.imageRef.trim()) {
    throw new Error(`${component.id} imageRef must be non-empty.`);
  }
  if (
    typeof component.imageId !== 'string' ||
    (!/^sha256:[0-9a-f]{64}$/u.test(component.imageId) && component.imageId !== 'unknown')
  ) {
    throw new Error(`${component.id} imageId must be a Docker sha256 id or unknown.`);
  }
  if (component.registryProvenance !== undefined) validateRegistryProvenance(component);
}

function validateRegistryProvenance(component) {
  const proof = component.registryProvenance;
  const names = {
    'api-shared': ['api', 'maxim-api'],
    'miniapp-major-static': ['miniapp', 'maxim-miniapp-major'],
    'admin-static': ['admin', 'maxim-admin'],
    eraser: ['eraser', 'maxim-eraser'],
  };
  const [imageComponent, alias] = names[component.id];
  const source = proof?.record?.source;
  const image = proof?.record?.image;
  const registry = proof?.record?.registry;
  const positiveId = /^[1-9][0-9]*$/u;
  // FLAG: This is persisted identity metadata, not a replacement for the pre-deploy
  // OIDC/SBOM checks. Rollback readers accept both exact namespaces; new release admission
  // separately requires the current private namespace, and manifests without this field remain readable.
  if (
    JSON.stringify(proof).length > 8192 ||
    proof?.schemaVersion !== 1 ||
    proof.record?.schemaVersion !== 1 ||
    proof.record.component !== imageComponent ||
    source?.sha !== component.sourceSha ||
    source.repository !== 'GameclubPro/Major-Maksimov' ||
    source.repositoryId !== '1168895008' ||
    source.workflow !== '.github/workflows/ci.yml' ||
    source.workflowRef !== 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main' ||
    source.runnerEnvironment !== 'github-hosted' ||
    !['push', 'workflow_dispatch'].includes(source.event) ||
    !positiveId.test(source.runId ?? '') ||
    !positiveId.test(source.runAttempt ?? '') ||
    image?.alias !== `${alias}:${component.sourceSha}` ||
    image.alias !== component.imageRef ||
    image.imageId !== component.imageId ||
    image.platform !== 'linux/amd64' ||
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 1 ||
    image.sizeBytes > 64 * 1024 ** 3 ||
    ![
      `ghcr.io/gameclubpro/major-maksimov-${imageComponent}`,
      `ghcr.io/gameclubpro/major-maksimov-release-${imageComponent}`,
      `ghcr.io/gameclubpro/major-maksimov-private-v1-${imageComponent}`,
    ].includes(registry?.repository) ||
    !/^sha256:[0-9a-f]{64}$/u.test(registry.digest ?? '') ||
    !Number.isSafeInteger(proof.artifact?.id) ||
    proof.artifact.id < 1 ||
    proof.artifact.name !==
      `maxim-registry-${imageComponent}-${component.sourceSha}-${source.runId}-${source.runAttempt}` ||
    !/^sha256:[0-9a-f]{64}$/u.test(proof.artifact.digest ?? '') ||
    !Number.isFinite(Date.parse(proof.verifiedAt))
  ) {
    throw new Error(
      `${component.id} registry provenance does not match the immutable component identity.`,
    );
  }
}

function assertReleaseId(releaseId) {
  if (!releaseIdPattern.test(releaseId)) {
    throw new Error(`Invalid release id: ${releaseId}`);
  }
}

function writeAtomic(path, contents) {
  const parentDir = dirname(resolve(path));
  const tempPath = resolve(parentDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, contents, { mode: 0o640 });
    chmodSync(tempPath, 0o640);
    syncPath(tempPath);
    renameSync(tempPath, path);
    syncDirectory(parentDir);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function syncPath(path) {
  const file = openSync(path, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function syncDirectory(path) {
  const directory = openSync(resolve(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function parseCli(argv) {
  const command = argv[0];
  const options = { components: [], smokes: [], componentRegistryFiles: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--component') {
      options.components.push(parseComponent(argv[++index]));
    } else if (argument === '--component-registry-file') {
      options.componentRegistryFiles.push(requireValue(argv, ++index, argument));
    } else if (argument === '--smoke') {
      options.smokes.push(requireValue(argv, ++index, argument));
    } else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = requireValue(argv, ++index, argument);
    } else {
      options.arguments ??= [];
      options.arguments.push(argument);
    }
  }
  return { command, options };
}

function parseComponent(value) {
  const parts = String(value ?? '').split('|');
  if (parts.length !== 4) {
    throw new Error('--component must be id|sourceSha|imageRef|imageId.');
  }
  return { id: parts[0], sourceSha: parts[1], imageRef: parts[2], imageId: parts[3] };
}

function requireValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

function readLines(path) {
  if (!path) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runCli(argv) {
  const { command, options } = parseCli(argv);
  const stateDir = resolve(
    options.stateDir || process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy',
  );

  if (command === 'commit' || command === 'inventory') {
    const seenProvenance = new Set();
    for (const value of options.componentRegistryFiles) {
      const separator = value.indexOf('|');
      const componentId = value.slice(0, separator);
      const component = options.components.find(({ id }) => id === componentId);
      if (separator <= 0 || !component || seenProvenance.has(componentId)) {
        throw new Error('--component-registry-file requires one selected component id|path.');
      }
      seenProvenance.add(componentId);
      component.registryProvenance = readJson(value.slice(separator + 1));
    }
    const current = options.currentManifestFile
      ? readTransitionBaseManifest(options.currentManifestFile)
      : readCurrentManifest(stateDir);
    const manifest = buildReleaseManifest({
      releaseId: options.releaseId,
      targetSha: options.targetSha || (command === 'inventory' ? 'unknown' : null),
      current,
      components: options.components,
      migrations: options.migrationsFile ? readLines(options.migrationsFile) : null,
      smokes: options.smokes,
      emergencyReason: options.emergencyReason,
      createdAt: options.createdAt,
    });
    if (command === 'commit') {
      validateCompleteReleaseManifest(manifest);
    }
    commitReleaseManifest({
      stateDir,
      manifest,
      retain: Number(options.retain || process.env.MAXIM_RELEASE_RETAIN || 5),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'show') {
    const releaseId = options.arguments?.[0] || 'current';
    const manifest =
      releaseId === 'current'
        ? options.currentManifestFile
          ? readTransitionBaseManifest(options.currentManifestFile)
          : readCurrentManifest(stateDir)
        : readReleaseManifest(stateDir, releaseId);
    if (!manifest) {
      process.exitCode = 3;
      return;
    }
    validateManifest(manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'field') {
    const [releaseId = 'current', componentId, field] = options.arguments ?? [];
    const manifest =
      releaseId === 'current'
        ? options.currentManifestFile
          ? readTransitionBaseManifest(options.currentManifestFile)
          : readCurrentManifest(stateDir)
        : readReleaseManifest(stateDir, releaseId);
    const value = manifest?.components?.[componentId]?.[field];
    if (typeof value !== 'string') {
      process.exitCode = 3;
      return;
    }
    process.stdout.write(`${value}\n`);
    return;
  }

  if (command === 'recovery-base') {
    const recoveryBase = findRecoveryBaseManifest(stateDir, {
      allowUnknown: options.allowUnknown === '1',
    });
    if (!recoveryBase) {
      process.exitCode = 3;
      return;
    }
    process.stdout.write(`${recoveryBase}\n`);
    return;
  }

  if (command === 'validate-current') {
    const current = readCurrentManifest(stateDir);
    if (!current) {
      process.exitCode = 3;
      return;
    }
    validateCompleteReleaseManifest(current, { allowUnknown: options.allowUnknown === '1' });
    const unresolvedRecoveryBases = listRecoveryBaseManifestPaths(stateDir);
    if (unresolvedRecoveryBases.length > 0) {
      throw new Error(
        `Current release coexists with ${unresolvedRecoveryBases.length} unresolved transition journal(s).`,
      );
    }
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  if (command === 'begin-transition') {
    const recoveryPath = beginReleaseTransition({
      stateDir,
      kind: options.kind,
    });
    process.stdout.write(`${recoveryPath}\n`);
    return;
  }

  if (command === 'archive-transition') {
    const archivedPath = archiveReleaseTransition({
      stateDir,
      recoveryPath: options.currentManifestFile,
      disposition: options.disposition,
    });
    process.stdout.write(`${archivedPath}\n`);
    return;
  }

  throw new Error(
    'Usage: release-manifest.mjs commit|inventory|show|field|recovery-base|validate-current|begin-transition|archive-transition [options]',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
