import { createHash, randomUUID } from 'node:crypto';
import sessionQueues from './source-abandonment-session-queues.cjs';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import { legacyColdDigest as digest } from './legacy-cold-journal.mjs';
import { assertLegacyColdStopped } from './legacy-cold-protocol.mjs';
import { classifyInventoryRow } from './webhook-order-blocker-inventory.mjs';
import {
  ORDERED_ANCHOR_LIMITS,
  createOrderedAnchorAccumulator,
  parseOrderedAnchorRequest,
  validateOrderedAnchorPage,
} from './webhook-ordered-anchor-inventory.mjs';
import {
  validateSourceAbandonmentSessionManifest,
  SOURCE_ABANDONMENT_SESSION_LIMITS as sessionLimits,
} from './source-abandonment-session-journal.mjs';
import { sourceAbandonmentSessionRuntimeBindings } from './source-abandonment-session-protocol.mjs';
import { validateSourceAbandonmentSessionAdmission } from './source-abandonment-session-host.mjs';
import {
  FROZEN_ORDERED_ANCHOR_INITIAL_PAGE_SIZE,
  createFrozenOrderedAnchorAccumulator,
  validateFrozenOrderedAnchorPage,
} from './webhook-frozen-ordered-anchor-inventory.mjs';

const hash = /^[a-f0-9]{64}$/u;
const { isSupportedSourceAbandonmentQueueInventory } = sessionQueues;
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const bytesDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fact = (value, code = 'session_inventory_refused') => {
  if (!value) throw new Error(code);
};
const integer = (value, max, min = 0) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
export const SOURCE_ABANDONMENT_FROZEN_INVENTORY_LIMITS = Object.freeze({
  inventoryPages: ORDERED_ANCHOR_LIMITS.maxPages,
  inventoryRows: ORDERED_ANCHOR_LIMITS.maxRowObservations,
  inventoryProbes: 10000000,
  inventoryBytes: ORDERED_ANCHOR_LIMITS.maxMetadataBytes,
});
const exact = (value, keys) =>
  fact(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  );
function privateRead(directory, filename, maximum = 2 * 1024 * 1024) {
  const parent = lstatSync(directory);
  fact(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === process.getuid() &&
      (parent.mode & 0o777) === 0o700,
    'session_inventory_directory_refused',
  );
  fact(
    typeof filename === 'string' && /^[a-zA-Z0-9.-]+$/u.test(filename),
    'session_inventory_path_refused',
  );
  const fd = openSync(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    fact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= maximum,
      'session_inventory_file_refused',
    );
    const bytes = readFileSync(fd);
    fact(bytes.length === stat.size, 'session_inventory_file_changed');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const authority = (row) => ({
  ownerId: row.claim.ownerId,
  claimId: row.claim.id,
  semanticKey: row.semanticKey,
  chatId: row.chatId,
  messageId: row.messageId,
});
function classification(item) {
  const row = { ...item };
  delete row.orderChatId;
  return classifyInventoryRow(row).category;
}
const enumerateDigest = (request, rows) =>
  canonical({
    version: 2,
    scope: 'ordered_nonnull_chat',
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    cutoff: request.cutoff,
    rows,
  });
function nominations(rows) {
  const owners = new Map(),
    otherAuthorities = new Map();
  let unresolvedCount = 0;
  for (const row of rows) {
    if (classification(row) !== 'claim_started_unfinished') {
      unresolvedCount++;
      continue;
    }
    fact(row.orderChatId === row.chatId, 'session_inventory_chat_authority_changed');
    const value = authority(row),
      previous = owners.get(value.ownerId);
    fact(
      previous === undefined || canonical(previous) === canonical(value),
      'session_inventory_authority_conflict',
    );
    for (const key of [
      `claim:${value.claimId}`,
      `semantic:${value.semanticKey}`,
      `message:${JSON.stringify([value.chatId, value.messageId])}`,
    ]) {
      fact(
        !otherAuthorities.has(key) || otherAuthorities.get(key) === value.ownerId,
        'session_inventory_authority_conflict',
      );
      otherAuthorities.set(key, value.ownerId);
    }
    owners.set(value.ownerId, value);
  }
  return {
    authorities: [...owners.values()].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    unresolvedCount,
  };
}
function validateEnumeration(value) {
  fact(
    value?.version === 1 &&
      value.kind === 'source_abandonment_session_enumeration' &&
      value.report?.complete === true &&
      value.report.scope === 'ordered_nonnull_chat' &&
      Array.isArray(value.rows) &&
      value.rows.length <= 2_000_000,
    'session_inventory_complete_required',
  );
  const request = parseOrderedAnchorRequest(value.request);
  fact(
    value.enumerationDigest === enumerateDigest(request, value.rows),
    'session_inventory_enumeration_changed',
  );
  const actual = nominations(value.rows);
  fact(
    canonical(actual.authorities) === canonical(value.authorities) &&
      actual.unresolvedCount === value.unresolvedCount,
    'session_inventory_nominations_changed',
  );
  return value;
}

// FLAG: Online metadata nominates candidates only. Every selected owner still
// needs the immutable image's full stock admission and a later frozen review.
export function readSourceAbandonmentSessionEnumeration({
  directory,
  expectedCheckpointSha256,
  expectedRequest,
}) {
  const request = parseOrderedAnchorRequest(expectedRequest),
    requestBytes = privateRead(directory, 'request.json', 4096);
  fact(requestBytes.equals(encode(request)), 'session_inventory_request_changed');
  const checkpointBytes = privateRead(directory, 'checkpoint.json');
  fact(
    hash.test(expectedCheckpointSha256 ?? '') &&
      bytesDigest(checkpointBytes) === expectedCheckpointSha256,
    'session_inventory_checkpoint_changed',
  );
  const state = JSON.parse(checkpointBytes);
  exact(state, ['version', 'requestHash', 'runtime', 'pages', 'after', 'complete', 'journalBytes']);
  fact(
    state.version === 2 &&
      state.requestHash === bytesDigest(requestBytes) &&
      state.complete === true &&
      Array.isArray(state.pages) &&
      state.pages.length > 0 &&
      state.pages.length <= 10000,
    'session_inventory_complete_required',
  );
  const runtime = state.runtime;
  fact(
    runtime?.sourceSha === request.sourceSha &&
      runtime.imageId === request.imageId &&
      runtime.running === true &&
      hash.test(runtime.id ?? '') &&
      Number.isFinite(Date.parse(runtime.startedAt)) &&
      integer(runtime.restarts, Number.MAX_SAFE_INTEGER),
    'session_inventory_runtime_unproved',
  );
  const accumulator = createOrderedAnchorAccumulator(request),
    rows = [];
  let totalBytes = 0,
    last = null;
  for (const [index, entry] of state.pages.entries()) {
    exact(entry, ['index', 'file', 'digest']);
    fact(
      entry.index === index &&
        hash.test(entry.digest ?? '') &&
        entry.file === `page-${String(index).padStart(6, '0')}-${entry.digest}.json`,
      'session_inventory_page_reference_changed',
    );
    const bytes = privateRead(directory, entry.file);
    fact(bytesDigest(bytes) === entry.digest, 'session_inventory_page_changed');
    const saved = JSON.parse(bytes);
    exact(saved, ['version', 'requestHash', 'page', 'plan']);
    fact(
      saved.version === 2 &&
        saved.requestHash === state.requestHash &&
        saved.plan !== null &&
        typeof saved.plan === 'object',
      'session_inventory_page_binding_changed',
    );
    const page = validateOrderedAnchorPage(saved.page, request);
    accumulator.addPage(page);
    rows.push(...page.rows);
    totalBytes += bytes.length;
    last = page.nextCursor;
    fact(totalBytes <= 512 * 1024 * 1024, 'session_inventory_storage_budget');
  }
  const report = accumulator.report();
  fact(
    report.complete === true &&
      accumulator.nextRequest() === null &&
      state.journalBytes === totalBytes &&
      canonical(state.after) === canonical(last),
    'session_inventory_incomplete_chain',
  );
  return {
    version: 1,
    kind: 'source_abandonment_session_enumeration',
    request,
    runtime,
    checkpointSha256: expectedCheckpointSha256,
    journalBytes: totalBytes,
    report,
    rows,
    ...nominations(rows),
    enumerationDigest: enumerateDigest(request, rows),
  };
}
function saveProof(recordProof, value) {
  const result = recordProof(value);
  fact(result === bytesDigest(encode(value)), 'session_inventory_proof_write_unproved');
  return result;
}
// FLAG: Only selected-source semantic refusals may split an online selection.
// A chat-type mismatch remains unsupported; it never gains recovery authority.
// Bind each code to its actual producer scope, retaining global/mixed refusals.
const denialDescriptors = new Map([
  ['source_content_unproved', ['sql:selected-source']],
  ['source_configured_command', ['sql:selected-source']],
  ['source_chat_type', ['sql:selected-source']],
  // FLAG: Fixed linked-content refusals only split selected-source diagnostics.
  // Every owner still needs a fresh stock admission; no content or effect is admitted here.
  ...[
    'source_forward_shape',
    'source_reply_shape',
    'source_forward_direct_object',
    'source_forward_direct_keys',
    'source_forward_direct_mid',
    'source_forward_direct_seq',
    'source_forward_direct_text_absent',
    'source_forward_direct_text_null',
    'source_forward_direct_text_invalid',
    'source_forward_direct_markup',
    'source_forward_direct_media',
    'source_forward_linked_object',
    'source_forward_linked_keys',
    'source_forward_linked_mid',
    'source_forward_linked_seq',
    'source_forward_linked_text_absent',
    'source_forward_linked_text_null',
    'source_forward_linked_text_invalid',
    'source_forward_linked_markup',
    'source_forward_linked_media',
    'source_forward_linked_media_array',
    'source_forward_linked_media_count',
    'source_forward_linked_media_item',
    'source_forward_linked_media_mixed',
    'source_forward_linked_media_other',
    'source_forward_linked_media_image_strict',
    'source_forward_linked_media_image_unproved',
    'source_forward_linked_media_photo_strict',
    'source_forward_linked_media_photo_unproved',
    'source_forward_linked_media_video_strict',
    'source_forward_linked_media_video_unproved',
    'source_forward_linked_media_audio_strict',
    'source_forward_linked_media_audio_unproved',
    'source_forward_linked_media_share_strict',
    'source_forward_linked_media_share_unproved',
    'source_forward_linked_media_sticker_strict',
    'source_forward_linked_media_sticker_unproved',
    'source_forward_objects',
    'source_forward_link_object',
    'source_forward_sender_null',
    'source_forward_sender_shape',
    'source_forward_message_keys',
    'source_forward_link_keys',
    'source_forward_link_type',
    'source_forward_chat_absent',
    'source_forward_chat_null',
    'source_forward_chat_identity',
    'source_forward_sender_identity',
    'source_forward_sender_keys',
    'source_forward_sender_bot',
    'source_forward_sender_metadata',
    'source_forward_sender_activity',
    'source_forward_normalized_text',
    'source_forward_bot_type',
  ].map((code) => [code, ['sql:selected-source']]),
  ['source_candidate_unproved', ['sql:webhook_events', 'sql:chat_settings']],
  ['selected_owner_proof_incomplete', ['sql:selected-source']],
]);
function splittable(value) {
  return (
    Array.isArray(value.issues) &&
    value.issues.length > 0 &&
    value.issues.every(
      (issue) =>
        issue &&
        typeof issue === 'object' &&
        !Array.isArray(issue) &&
        Object.keys(issue).sort().join(',') === 'code,descriptor' &&
        denialDescriptors.get(issue.code)?.includes(issue.descriptor),
    ) &&
    value.issues.some((issue) =>
      ['source_content_unproved', 'source_configured_command'].includes(issue.code),
    )
  );
}
const selectedSqlDescriptors = new Set([
  'sql:webhook_events',
  'sql:webhook_execution_claims',
  'sql:chat_settings',
  'sql:moderation_delete_intents',
  'sql:moderation_delete_intent_reasons',
  'sql:moderation_rule_followups',
  'sql:moderation_events',
  'sql:moderation_violation_message_claims',
  'sql:spammer_observations',
  'sql:max_action_ledger',
  'sql:channel_auto_post_attach_markers',
  'sql:source-size',
  'sql:exact-source-family',
]);
function selectedSqlPageBudget(value) {
  const issues = value.issues;
  return (
    Array.isArray(issues) &&
    [1, 2].includes(issues.length) &&
    issues.every(
      (issue) =>
        issue !== null &&
        typeof issue === 'object' &&
        !Array.isArray(issue) &&
        Object.keys(issue).sort().join(',') === 'code,descriptor',
    ) &&
    issues.filter(
      (issue) =>
        issue.code === 'sql_budget_exceeded' && selectedSqlDescriptors.has(issue.descriptor),
    ).length === 1 &&
    issues.filter(
      (issue) =>
        issue.code === 'REDIS_STORE_OR_SOURCE_REFUSED' &&
        freshActionPageDescriptors.has(issue.descriptor),
    ).length ===
      issues.length - 1 &&
    [511, 512].includes(value.cost.pages)
  );
}
const freshActionPageDescriptors = new Set([
  'redis:moderation-actions',
  'redis:max-actions-critical',
  'redis:max-actions-interactive',
  'redis:max-actions-background',
]);
const freshActionObservationCodes = new Set(['ACTION_PAGE_UNPROVED', 'ACTION_MULTIPLE_STATES']);
function freshActionPageRefusal(value) {
  if (!Array.isArray(value.issues) || value.issues.length === 0) return false;
  const semanticIssues = [],
    seen = new Set();
  let dynamicIssues = 0;
  for (const issue of value.issues) {
    if (
      issue === null ||
      typeof issue !== 'object' ||
      Array.isArray(issue) ||
      Object.keys(issue).sort().join(',') !== 'code,descriptor' ||
      typeof issue.code !== 'string' ||
      typeof issue.descriptor !== 'string'
    )
      return false;
    const identity = JSON.stringify([issue.code, issue.descriptor]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (
      freshActionObservationCodes.has(issue.code) &&
      freshActionPageDescriptors.has(issue.descriptor)
    )
      dynamicIssues++;
    else semanticIssues.push(issue);
  }
  // FLAG: A mixed DENY may only trigger a fresh full read of the identical selection.
  // Never split, exclude or admit from it; unknown/global/budget mixtures stay refused.
  return (
    dynamicIssues === 1 &&
    (semanticIssues.length === 0 || splittable({ ...value, issues: semanticIssues }))
  );
}

export async function planSourceAbandonmentSessionChildren({
  enumeration: input,
  majorBotIds,
  queueNames,
  publisherBotId,
  collectAdmission,
  recordProof,
  certificateId = randomUUID,
  maximumChildren = sessionLimits.children,
  maximumAdmissionCalls = sessionLimits.admissionCalls,
  maximumOwnersPerAdmission = 7,
  deadlineAtMs,
  now = Date.now,
}) {
  const enumeration = validateEnumeration(input),
    started = now();
  fact(
    typeof collectAdmission === 'function' &&
      typeof recordProof === 'function' &&
      typeof certificateId === 'function' &&
      integer(maximumChildren, sessionLimits.children, 1) &&
      integer(maximumAdmissionCalls, sessionLimits.admissionCalls, 1) &&
      integer(maximumOwnersPerAdmission, 7, 1) &&
      Number.isSafeInteger(deadlineAtMs) &&
      deadlineAtMs > started &&
      Array.isArray(majorBotIds) &&
      majorBotIds.length > 0 &&
      majorBotIds.length <= 100 &&
      majorBotIds.every((id) => /^[a-zA-Z0-9_-]{1,128}$/u.test(id)) &&
      new Set(majorBotIds).size === majorBotIds.length &&
      /^[a-zA-Z0-9_-]{1,128}$/u.test(publisherBotId ?? '') &&
      !majorBotIds.includes(publisherBotId) &&
      isSupportedSourceAbandonmentQueueInventory(queueNames),
    'session_inventory_plan_context_refused',
  );
  const children = [],
    admissionProofs = [],
    admissionCost = { pages: 0, rows: 0, probes: 0, bytes: 0 },
    selectionAttempts = new Map();
  let calls = 0,
    rejected = 0,
    // FLAG: Leave initial SQL headroom; a failed proof never grants authority.
    // The persisted per-child authority ceiling remains eight owners.
    ownersPerChild = maximumOwnersPerAdmission,
    registryDigest = null,
    reason = null;
  const result = () => ({
    version: 1,
    feasible: reason === null,
    reason,
    children: reason === null ? children : [],
    excludedCounts: { rejected, unresolved: enumeration.unresolvedCount },
    registryDigest,
    botCatalogDigest: canonical({ publisherBotId }),
    enumerationDigest: enumeration.enumerationDigest,
    nominatedOwners: enumeration.authorities.length,
    admissionCalls: calls,
    admissionDurationMs: now() - started,
    admissionCost,
    admissionProofs,
  });
  if (enumeration.authorities.length > sessionLimits.children * sessionLimits.ownersPerChild) {
    reason = 'too_many_candidates';
    return result();
  }
  const admit = async (authorities) => {
    if (reason !== null) return 0;
    if (authorities.length > ownersPerChild) return admit(authorities.slice(0, ownersPerChild));
    if (calls >= maximumAdmissionCalls || now() >= deadlineAtMs) {
      reason = 'admission_budget';
      return 0;
    }
    const selection = {
      ownerWebhookEventIds: authorities.map((row) => row.ownerId).sort(),
      majorBotIds: [...majorBotIds].sort(),
      protocol: 'source-abandonment-v1',
      abandonBefore: enumeration.request.cutoff,
    };
    const selectionKey = canonical(selection),
      previousAttempts = selectionAttempts.get(selectionKey) ?? 0;
    if (previousAttempts >= 3) {
      reason = 'global_admission_refused';
      return 0;
    }
    const request = {
      version: 1,
      operation: 'admission_preview',
      sourceSha: enumeration.request.sourceSha,
      imageId: enumeration.request.imageId,
      selection,
      publisherBotId,
    };
    selectionAttempts.set(selectionKey, previousAttempts + 1);
    calls++;
    const admission = await collectAdmission(request, { deadlineAtMs });
    fact(
      Buffer.byteLength(JSON.stringify(admission)) <= 8 * 1024 * 1024 &&
        admission?.version === 1 &&
        admission.operation === 'admission_preview' &&
        admission.sourceSha === request.sourceSha &&
        admission.imageId === request.imageId &&
        admission.selectionSha256 === selectionKey &&
        admission.applied === false &&
        admission.activationAuthorized === false &&
        admission.stoppingAuthorized === false &&
        hash.test(admission.registrySha256 ?? '') &&
        admission.publisherCatalogSha256 === canonical({ publisherBotId }) &&
        ['READY_FOR_COLD_REVIEW', 'DENY'].includes(admission.decision),
      'session_inventory_admission_unproved',
    );
    exact(admission.cost, ['pages', 'rows', 'probes', 'bytes']);
    for (const [key, max] of Object.entries({
      pages: 512,
      rows: 10000,
      probes: 50000,
      bytes: 8 * 1024 * 1024,
    })) {
      fact(integer(admission.cost[key], max), 'session_inventory_admission_cost_unproved');
      admissionCost[key] += admission.cost[key];
    }
    fact(
      registryDigest === null || registryDigest === admission.registrySha256,
      'session_inventory_registry_changed',
    );
    registryDigest = admission.registrySha256;
    const admissionDigest = saveProof(recordProof, admission);
    admissionProofs.push(admissionDigest);
    if (now() >= deadlineAtMs) {
      reason = 'admission_budget';
      return 0;
    }
    if (admission.decision === 'DENY') {
      fact(admission.sourceCoverageComplete === false, 'session_inventory_admission_unproved');
      // FLAG: A failed live action observation grants no authority. Retain and charge
      // it before a fresh full admission of the same selection, including a recognized
      // semantic mixture. The shared three-attempt ceiling never turns DENY into exclusion.
      if (freshActionPageRefusal(admission)) {
        if (selectionAttempts.get(selectionKey) >= 3) {
          reason = 'global_admission_refused';
          return 0;
        }
        return admit(authorities);
      }
      // FLAG: A known SQL page ceiling permits only a smaller fresh read. Keep
      // every unconsumed owner and charge failed proofs; it never excludes one.
      if (selectedSqlPageBudget(admission)) {
        if (authorities.length === 1) reason = 'global_admission_refused';
        else ownersPerChild = authorities.length - 1;
        return 0;
      }
      if (!splittable(admission)) {
        reason = 'global_admission_refused';
        return 0;
      }
      if (authorities.length === 1) {
        rejected++;
        return 1;
      }
      const midpoint = Math.ceil(authorities.length / 2);
      const consumed = await admit(authorities.slice(0, midpoint));
      if (consumed < midpoint || reason !== null) return consumed;
      return consumed + (await admit(authorities.slice(midpoint)));
    }
    validateSourceAbandonmentSessionAdmission({
      admission,
      selection,
      authorities,
      sourceSha: request.sourceSha,
      imageId: request.imageId,
      registryDigest,
      publisherCatalogDigest: canonical({ publisherBotId }),
      queueNames,
    });
    if (children.length >= maximumChildren) {
      reason = 'child_limit';
      return 0;
    }
    const certificate = certificateId();
    fact(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        certificate ?? '',
      ) && !children.some((child) => child.certificateId === certificate),
      'session_inventory_certificate_refused',
    );
    children.push({
      certificateId: certificate,
      selection,
      selectionDigest: digest(selection),
      admissionDigest,
      authorities: structuredClone(authorities),
    });
    return authorities.length;
  };
  for (let index = 0; index < enumeration.authorities.length && reason === null; )
    index += await admit(enumeration.authorities.slice(index, index + ownersPerChild));
  if (reason === null && children.length === 0) reason = 'no_supported_children';
  return result();
}

// FLAG: A stopped complete ordered-index walk proves only this ordering universe.
// Disappeared unselected rows no longer occupy that index; this does not claim an
// effect outcome or clear unsupported work. Selected authorities may never vanish.
export function createSourceAbandonmentSessionFrozenInventory({
  enumeration: input,
  baseline,
  readPage,
  attestStopped,
  recordProof,
  limits,
  now = Date.now,
}) {
  const enumeration = validateEnumeration(input),
    maximum = SOURCE_ABANDONMENT_FROZEN_INVENTORY_LIMITS;
  fact(
    typeof readPage === 'function' &&
      typeof attestStopped === 'function' &&
      typeof recordProof === 'function',
    'session_inventory_frozen_context_refused',
  );
  exact(limits, Object.keys(maximum));
  for (const [key, max] of Object.entries(maximum))
    fact(integer(limits[key], max, 1), 'session_inventory_frozen_budget_refused');
  return async (manifest, bindings, { deadlineAtMs } = {}) => {
    validateSourceAbandonmentSessionManifest(manifest);
    fact(
      canonical(bindings) === canonical(sourceAbandonmentSessionRuntimeBindings(manifest)) &&
        manifest.enumerationDigest === enumeration.enumerationDigest &&
        manifest.sourceSha === enumeration.request.sourceSha &&
        manifest.imageId === enumeration.request.imageId &&
        manifest.cutoff === enumeration.request.cutoff &&
        digest(baseline) === manifest.baselineDigest &&
        Number.isSafeInteger(deadlineAtMs) &&
        now() < deadlineAtMs,
      'session_inventory_frozen_binding_refused',
    );
    const expected = [...baseline.services, ...baseline.auxiliaries];
    const stopped = async () => {
      const value = assertLegacyColdStopped(await attestStopped(bindings), bindings),
        rows = [...value.services, ...value.auxiliaries];
      fact(
        rows.length === 16 &&
          new Set(rows.map((row) => row.containerId)).size === 16 &&
          rows.every((row) => {
            const prior = expected.find((old) => old.serviceName === row.serviceName);
            return (
              hash.test(row.containerId ?? '') &&
              prior?.containerId === row.containerId &&
              row.sourceSha === manifest.sourceSha &&
              row.imageId === manifest.imageId &&
              row.nativeBoundaryDigest === prior.nativeBoundaryDigest
            );
          }),
        'session_inventory_frozen_generation_changed',
      );
      return value;
    };
    const original = await stopped(),
      accumulator = createFrozenOrderedAnchorAccumulator(enumeration.request, {
        limits: {
          maxPages: limits.inventoryPages,
          maxRowObservations: limits.inventoryRows,
          maxMetadataBytes: limits.inventoryBytes,
        },
      }),
      rows = [],
      pageProofs = [],
      cost = { inventoryPages: 0, inventoryRows: 0, inventoryProbes: 0, inventoryBytes: 0 };
    while (accumulator.nextRequest() !== null) {
      fact(
        now() < deadlineAtMs && cost.inventoryPages < limits.inventoryPages,
        'session_inventory_frozen_deadline',
      );
      const parameters = accumulator.nextRequest(),
        result = await readPage(parameters, { deadlineAtMs });
      fact(
        now() < deadlineAtMs && result?.plan !== null && typeof result?.plan === 'object',
        'session_inventory_frozen_page_unproved',
      );
      const page = validateFrozenOrderedAnchorPage(result.page, enumeration.request);
      exact(result.cost, Object.keys(maximum));
      fact(
        Array.isArray(result.attempts) && result.attempts.length === 1,
        'session_inventory_frozen_attempts_unproved',
      );
      const observedCost = {
        inventoryPages: 0,
        inventoryRows: 0,
        inventoryProbes: 0,
        inventoryBytes: 0,
      };
      for (const attempt of result.attempts) {
        exact(attempt, ['pageSize', 'rawCount', 'returnedRows', 'refusal', 'outputBytes', 'plan']);
        fact(
          parameters.pageSize === FROZEN_ORDERED_ANCHOR_INITIAL_PAGE_SIZE &&
            attempt.pageSize === parameters.pageSize &&
            integer(attempt.rawCount, attempt.pageSize + 1) &&
            integer(attempt.returnedRows, attempt.pageSize) &&
            integer(attempt.outputBytes, maximum.inventoryBytes, 1) &&
            attempt.plan &&
            typeof attempt.plan === 'object' &&
            attempt.refusal === null &&
            attempt.pageSize === page.pageSize &&
            attempt.rawCount === page.rawCount &&
            attempt.returnedRows === page.rows.length &&
            canonical(attempt.plan) === canonical(result.plan),
          'session_inventory_frozen_attempts_unproved',
        );
        observedCost.inventoryPages++;
        observedCost.inventoryRows += Math.min(attempt.rawCount, attempt.pageSize);
        observedCost.inventoryProbes += 2 + 4 * attempt.rawCount;
        observedCost.inventoryBytes += attempt.outputBytes;
      }
      fact(
        canonical(observedCost) === canonical(result.cost),
        'session_inventory_frozen_cost_unproved',
      );
      // FLAG: The preselected 200-row page has exactly one accounted attempt.
      // No refused query permits fallback, discarded work or a cursor advance.
      for (const key of Object.keys(maximum)) cost[key] += result.cost[key];
      fact(
        Object.keys(maximum).every((key) => cost[key] <= limits[key]),
        'session_inventory_frozen_budget',
      );
      fact(
        canonical(await stopped()) === canonical(original),
        'session_inventory_frozen_generation_changed',
      );
      accumulator.addPage(page);
      rows.push(...page.rows);
      pageProofs.push(
        saveProof(recordProof, {
          version: 1,
          kind: 'source_abandonment_frozen_page',
          sessionId: manifest.sessionId,
          manifestDigest: digest(manifest),
          index: pageProofs.length,
          page,
          plan: result.plan,
          attempts: result.attempts,
          cost: result.cost,
        }),
      );
    }
    const planned = new Map(enumeration.rows.map((row) => [row.id, row])),
      frozen = new Map(rows.map((row) => [row.id, row]));
    let unknownAdditions = 0,
      changed = 0,
      resolvedUnselectedRows = 0,
      remainingUnselectedRows = 0;
    const selected = manifest.children.flatMap((child) => child.authorities),
      selectedOwners = new Set(selected.map((row) => row.ownerId));
    for (const row of rows) {
      const before = planned.get(row.id);
      if (!before) {
        unknownAdditions++;
        continue;
      }
      if (
        before.orderChatId !== row.orderChatId ||
        before.createdAt !== row.createdAt ||
        canonical(authority(before)) !== canonical(authority(row))
      )
        changed++;
      if (!selectedOwners.has(row.claim.ownerId)) remainingUnselectedRows++;
    }
    for (const row of enumeration.rows)
      if (!frozen.has(row.id) && !selectedOwners.has(row.claim.ownerId)) resolvedUnselectedRows++;
    const frozenNominations = nominations(rows);
    for (const required of selected)
      if (!frozenNominations.authorities.some((row) => canonical(row) === canonical(required)))
        changed++;
    fact(unknownAdditions === 0 && changed === 0, 'session_inventory_frozen_universe_changed');
    fact(
      now() < deadlineAtMs && canonical(await stopped()) === canonical(original),
      'session_inventory_frozen_deadline',
    );
    const frozenEnumerationDigest = enumerateDigest(enumeration.request, rows);
    const rawInventoryProof = saveProof(recordProof, {
      version: 1,
      kind: 'source_abandonment_frozen_enumeration',
      sessionId: manifest.sessionId,
      manifestDigest: digest(manifest),
      request: enumeration.request,
      pageProofs,
      cost,
      report: accumulator.report(),
      frozenEnumerationDigest,
      stoppedInventory: original,
    });
    return {
      version: 1,
      complete: true,
      sessionId: manifest.sessionId,
      manifestDigest: digest(manifest),
      coverage: 'FROZEN',
      cutoff: manifest.cutoff,
      sourceSha: manifest.sourceSha,
      imageId: manifest.imageId,
      enumerationComplete: true,
      plannedEnumerationDigest: manifest.enumerationDigest,
      frozenEnumerationDigest,
      manifestMatches: true,
      unknownAdditions: 0,
      missingOrChangedAuthorities: 0,
      orderedScope: 'ordered_nonnull_chat',
      remainingUnselectedRows,
      resolvedUnselectedRows,
      rawInventoryProof,
      cost,
      allBacklogCleared: false,
      fleetRecoveryProven: false,
    };
  };
}
