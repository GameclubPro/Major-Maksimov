import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrderedAnchorInventory } from './webhook-ordered-anchor-inventory-cli.mjs';
import { canonicalLegacyColdDigest as canonical } from './legacy-cold-store-adapter.mjs';
import {
  sourceAbandonmentSessionDigest as digest,
  SOURCE_ABANDONMENT_SESSION_LIMITS,
} from './source-abandonment-session-journal.mjs';
import { LEGACY_COLD_API_SERVICES } from './multibot-legacy-cold-recovery.mjs';
import { sourceAbandonmentSessionRuntimeBindings } from './source-abandonment-session-protocol.mjs';
import { readSourceAbandonmentSessionQueueRegistry } from './source-abandonment-session-host.mjs';
import {
  readSourceAbandonmentSessionEnumeration,
  planSourceAbandonmentSessionChildren,
  createSourceAbandonmentSessionFrozenInventory,
} from './source-abandonment-session-inventory.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const proofDigest = (proof) => sha256(`${JSON.stringify(proof)}\n`);
const clone = structuredClone;
const hash = 'c'.repeat(64);
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const request = {
  version: 2,
  inventoryId: uuid(1),
  sourceSha: 'a'.repeat(40),
  imageId: `sha256:${'b'.repeat(64)}`,
  cutoff: '2026-10-09T16:10:00.000Z',
};
const runtime = {
  id: 'd'.repeat(64),
  imageId: request.imageId,
  running: true,
  startedAt: '2026-10-08T16:10:00.000Z',
  restarts: 0,
  sourceSha: request.sourceSha,
};
const queueNames = readSourceAbandonmentSessionQueueRegistry(request.sourceSha, () =>
  readFileSync(
    new URL('../../apps/api/src/scripts/legacy-recovery-live-registry.ts', import.meta.url),
    'utf8',
  ).trim(),
).queueNames;
const timestamp = (n) => `2026-10-09T15:00:00.${String(n).padStart(6, '0')}Z`;

function row(n = 1, overrides = {}) {
  return {
    orderChatId: '-private_actual_chat',
    id: `private_receipt_${String(n).padStart(6, '0')}`,
    createdAt: timestamp(n),
    status: 'FAILED',
    normalizedBounded: true,
    ordered: true,
    chatId: '-private_actual_chat',
    messageId: `private_message_${n}`,
    semanticKey: `private_semantic_${n}`,
    botId: 'major',
    legacyReleased: false,
    sourceReleased: false,
    retry: 'due',
    quarantine: 'expired',
    errorFamily: 'legacy_unverified',
    claim: {
      semanticFound: true,
      directCount: 1,
      conflict: false,
      id: `private_claim_${n}`,
      ownerId: `private_owner_${n}`,
      status: 'READY',
      enforced: true,
      prepared: true,
      started: true,
      completed: false,
      lease: 'expired',
      checkpoint: 'waiting_marker',
    },
    ...overrides,
  };
}
function unresolvedRow(n) {
  const value = row(n);
  value.claim.started = false;
  return value;
}
function page(parameters, rows, hasMore = false, overrides = {}) {
  const last = rows.at(-1);
  return {
    version: 2,
    kind: 'ordered_anchor_inventory_page',
    readOnly: true,
    observedAt: '2026-10-09T16:20:00.000000Z',
    ...parameters,
    rawCount: rows.length + (hasMore ? 1 : 0),
    hasMore,
    nextCursor: last ? { chatId: last.orderChatId, createdAt: last.createdAt, id: last.id } : null,
    rows,
    coverage: 'ONLINE_PREVIEW',
    mutationAuthorized: false,
    ...overrides,
  };
}
function writeWalk(t, rows, { pageLimit = 50, observedAt } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-session-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = runOrderedAnchorInventory({
    directory,
    request,
    pageLimit,
    attest: () => runtime,
    readPage(parameters) {
      const start = parameters.after
        ? rows.findIndex((value) => value.id === parameters.after.id) + 1
        : 0;
      const nextRows = rows.slice(start, start + 200);
      return {
        page: page(
          parameters,
          nextRows,
          start + 200 < rows.length,
          observedAt ? { observedAt } : {},
        ),
        plan: { bounded: true },
      };
    },
  });
  const options = {
    directory,
    expectedCheckpointSha256: result.checkpointSha256,
    expectedRequest: request,
  };
  return {
    directory,
    result,
    options,
    read: () => readSourceAbandonmentSessionEnumeration(options),
  };
}

function admission(selection, enumeration) {
  const catalog = {
    version: 2,
    complete: true,
    namespaceKeyCounts: { 'moderation-actions': 1 },
    cost: {
      pages: 1,
      scanCountHints: 4096,
      matchedKeys: 1,
      keyBytes: 64,
      bytes: 100,
      measurementBytes: 100,
      databaseKeysMax: 10,
      serverDurationUs: 100,
      maxCallDurationUs: 100,
      durationMs: 1,
    },
    issue: null,
  };
  return {
    version: 1,
    operation: 'admission_preview',
    applied: false,
    activationAuthorized: false,
    stoppingAuthorized: false,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    decision: 'READY_FOR_COLD_REVIEW',
    sourceCoverageComplete: true,
    issues: [],
    selectionSha256: canonical(selection),
    registrySha256: hash,
    publisherCatalogSha256: canonical({ publisherBotId: 'publisher' }),
    selectedOwners: selection.ownerWebhookEventIds.map((ownerId) => {
      const value = enumeration.authorities.find((entry) => entry.ownerId === ownerId);
      return {
        ownerWebhookEventId: value.ownerId,
        claimId: value.claimId,
        semanticKey: value.semanticKey,
        chatId: value.chatId,
        messageId: value.messageId,
        userId: 'private_user',
        sourceAt: '2026-10-09T15:00:00.000Z',
        rawPayloadSha256: hash,
        normalizedPayloadSha256: hash,
        ownerSnapshotSha256: hash,
        claimSnapshotSha256: hash,
      };
    }),
    cost: { pages: 2, rows: selection.ownerWebhookEventIds.length, probes: 2, bytes: 200 },
    redisCatalogs: [clone(catalog), clone(catalog)],
  };
}
function planner(enumeration, transform = (value) => value) {
  const calls = [],
    proofs = [];
  let certificate = 10,
    active = 0,
    peak = 0;
  return {
    calls,
    proofs,
    peak: () => peak,
    options: {
      enumeration,
      majorBotIds: ['major'],
      queueNames,
      publisherBotId: 'publisher',
      now: () => 1000,
      deadlineAtMs: 60000,
      certificateId: () => uuid(certificate++),
      async collectAdmission(input) {
        calls.push(clone(input));
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return transform(admission(input.selection, enumeration), input);
      },
      recordProof(value) {
        proofs.push(clone(value));
        return proofDigest(value);
      },
    },
  };
}

test('enumeration reconstructs full immutable v2 chain and deduplicates actual claim owners', (t) => {
  const original = row(1),
    mirror = row(2, {
      claim: clone(original.claim),
      messageId: original.messageId,
      semanticKey: original.semanticKey,
    });
  const walk = writeWalk(t, [original, mirror]);
  const result = walk.read();
  assert.equal(result.version, 1);
  assert.equal(result.kind, 'source_abandonment_session_enumeration');
  assert.deepEqual(result.request, request);
  assert.deepEqual(result.runtime, runtime);
  assert.equal(result.checkpointSha256, walk.result.checkpointSha256);
  assert.equal(result.report.complete, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.authorities, [
    {
      ownerId: original.claim.ownerId,
      claimId: original.claim.id,
      semanticKey: original.semanticKey,
      chatId: original.chatId,
      messageId: original.messageId,
    },
  ]);
  assert.equal(result.unresolvedCount, 0);
  assert.match(result.enumerationDigest, /^[a-f0-9]{64}$/u);
});

test('enumeration refuses incomplete traversal even when it retained 200 valid observations', (t) => {
  const walk = writeWalk(
    t,
    Array.from({ length: 201 }, (_, i) => row(i + 1)),
    { pageLimit: 1 },
  );
  assert.equal(walk.result.report.complete, false);
  assert.throws(walk.read);
});

test('enumeration refuses stale checkpoint, changed request and altered page before returning authority', (t) => {
  const walk = writeWalk(t, [row(1)]);
  assert.throws(() =>
    readSourceAbandonmentSessionEnumeration({
      ...walk.options,
      expectedCheckpointSha256: 'e'.repeat(64),
    }),
  );
  assert.throws(() =>
    readSourceAbandonmentSessionEnumeration({
      ...walk.options,
      expectedRequest: { ...request, cutoff: '2026-10-09T16:11:00.000Z' },
    }),
  );
  const filename = readdirSync(walk.directory).find((name) => name.startsWith('page-'));
  const path = join(walk.directory, filename);
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')]));
  assert.throws(walk.read);
});

test('enumeration refuses public evidence files and ignores orphan pages', (t) => {
  const walk = writeWalk(t, [row(1)]);
  writeFileSync(join(walk.directory, 'page-999999-orphan.json'), '{}\n', { mode: 0o600 });
  assert.equal(walk.read().rows.length, 1);
  chmodSync(join(walk.directory, 'checkpoint.json'), 0o644);
  assert.throws(walk.read);
});

test('enumeration digest ignores observation clock but changes with the complete source universe', (t) => {
  const first = writeWalk(t, [row(1)]).read();
  const later = writeWalk(t, [row(1)], { observedAt: '2026-10-09T16:30:00.000000Z' }).read();
  const larger = writeWalk(t, [row(1), unresolvedRow(2)]).read();
  assert.equal(first.enumerationDigest, later.enumerationDigest);
  assert.notEqual(first.enumerationDigest, larger.enumerationDigest);
  assert.equal(larger.unresolvedCount, 1);
});

test('one canonical owner with conflicting authority identities cannot be silently deduplicated', (t) => {
  const second = row(2);
  second.claim.ownerId = row(1).claim.ownerId;
  assert.throws(writeWalk(t, [row(1), second]).read);
});

test('planner creates exact finite children in sequential stock admission calls', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 9 }, (_, i) => row(i + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.children.length, 2);
  assert.equal(result.admissionCalls, 2);
  assert.equal(h.peak(), 1);
  assert.deepEqual(
    result.children.map((child) => child.authorities.length),
    [7, 2],
  );
  assert.deepEqual(
    result.children
      .flatMap((child) => child.authorities)
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    [...enumeration.authorities].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
  );
  for (const child of result.children) {
    assert.equal(child.selection.protocol, 'source-abandonment-v1');
    assert.equal(child.selection.abandonBefore, request.cutoff);
    assert.deepEqual(child.selection.majorBotIds, ['major']);
    assert.equal(child.selectionDigest, digest(child.selection));
    assert.ok(h.proofs.some((proof) => proofDigest(proof) === child.admissionDigest));
  }
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  assert.equal(result.registryDigest, hash);
  assert.equal(result.botCatalogDigest, canonical({ publisherBotId: 'publisher' }));
  assert.equal(result.enumerationDigest, enumeration.enumerationDigest);
  assert.ok(result.admissionDurationMs >= 0);
});

test('planner accepts current and retained source inventories without changing their names', async (t) => {
  const enumeration = writeWalk(t, [row(1)]).read();
  for (const names of [queueNames, queueNames.filter((name) => name !== 'admin-manual-commands')]) {
    const h = planner(enumeration);
    h.options.queueNames = Object.freeze([...names]);
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, true);
    assert.equal(result.children.length, 1);
    assert.deepEqual(h.options.queueNames, names);
  }
});
test('unsupported queue inventory refuses before any admission call or proof', async (t) => {
  const enumeration = writeWalk(t, [row(1)]).read();
  for (const names of [
    queueNames.slice(0, 52),
    [...queueNames, 'unreviewed-extra'],
    queueNames.map((name) => (name === 'admin-manual-commands' ? 'unreviewed-replacement' : name)),
    queueNames.filter((name) => name !== 'message-retention'),
    queueNames.map((name, index) => (index === 0 ? queueNames[1] : name)),
  ]) {
    const h = planner(enumeration);
    h.options.queueNames = names;
    await assert.rejects(planSourceAbandonmentSessionChildren(h.options), /context_refused/u);
    assert.equal(h.calls.length, 0);
    assert.equal(h.proofs.length, 0);
  }
});
test('planner retains exact online admission proofs when active namespace counts move', async (t) => {
  const enumeration = writeWalk(t, [row(1)]).read();
  const h = planner(enumeration, (value) => {
    value.redisCatalogs[1].namespaceKeyCounts['moderation-actions'] = 2;
    value.redisCatalogs[1].cost.matchedKeys = 2;
    return value;
  });
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, true);
  assert.equal(result.children.length, 1);
  assert.deepEqual(result.admissionProofs, [proofDigest(h.proofs[0])]);
  assert.equal(result.children[0].admissionDigest, proofDigest(h.proofs[0]));
  assert.notDeepEqual(
    h.proofs[0].redisCatalogs[0].namespaceKeyCounts,
    h.proofs[0].redisCatalogs[1].namespaceKeyCounts,
  );
});

test('DENY group splits to individuals without losing the supported subset', async (t) => {
  const enumeration = writeWalk(t, [row(1), row(2), row(3), unresolvedRow(4)]).read();
  const rejectedOwner = row(2).claim.ownerId;
  const h = planner(enumeration, (value, input) =>
    input.selection.ownerWebhookEventIds.includes(rejectedOwner)
      ? {
          ...value,
          decision: 'DENY',
          sourceCoverageComplete: false,
          issues: [
            { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
            { code: 'source_candidate_unproved', descriptor: 'sql:webhook_events' },
            { code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' },
          ],
        }
      : value,
  );
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.deepEqual(
    result.children.flatMap((child) => child.authorities.map((entry) => entry.ownerId)).sort(),
    [row(1).claim.ownerId, row(3).claim.ownerId].sort(),
  );
  assert.deepEqual(result.excludedCounts, { rejected: 1, unresolved: 1 });
  assert.ok(
    h.calls.some(
      (input) =>
        input.selection.ownerWebhookEventIds.length === 1 &&
        input.selection.ownerWebhookEventIds[0] === rejectedOwner,
    ),
  );
  assert.equal(h.peak(), 1);
});

const fixedLinkedShapeDenialCodes = [
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
];
function linkedShapeDenial(value, code) {
  return {
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [
      { code, descriptor: 'sql:selected-source' },
      { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
      { code: 'source_candidate_unproved', descriptor: 'sql:webhook_events' },
      {
        code: 'selected_owner_proof_incomplete',
        descriptor: 'sql:selected-source',
      },
    ],
  };
}

for (const code of fixedLinkedShapeDenialCodes)
  test(`${code} splits diagnostic accounting without admitting the refused owner`, async (t) => {
    const rows = [row(1), row(2), row(3)];
    const rejectedOwner = rows[1].claim.ownerId;
    const h = planner(writeWalk(t, [...rows, unresolvedRow(4)]).read(), (value, input) =>
      input.selection.ownerWebhookEventIds.includes(rejectedOwner)
        ? linkedShapeDenial(value, code)
        : value,
    );
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, true);
    assert.equal(result.reason, null);
    assert.equal(result.nominatedOwners, 3);
    assert.deepEqual(result.excludedCounts, { rejected: 1, unresolved: 1 });
    assert.deepEqual(
      result.children.flatMap((child) => child.authorities.map((entry) => entry.ownerId)).sort(),
      [rows[0].claim.ownerId, rows[2].claim.ownerId].sort(),
    );
    assert.ok(
      h.proofs.some(
        (proof, index) =>
          h.calls[index].selection.ownerWebhookEventIds.length === 1 &&
          h.calls[index].selection.ownerWebhookEventIds[0] === rejectedOwner &&
          proof.decision === 'DENY' &&
          proof.sourceCoverageComplete === false &&
          proof.issues[0].code === code,
      ),
    );
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    for (const child of result.children) {
      const proof = h.proofs.find((value) => proofDigest(value) === child.admissionDigest);
      assert.equal(proof.decision, 'READY_FOR_COLD_REVIEW');
      assert.equal(proof.sourceCoverageComplete, true);
    }
    for (const key of ['pages', 'rows', 'probes', 'bytes'])
      assert.equal(
        result.admissionCost[key],
        h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
      );
    assert.equal(h.peak(), 1);
  });

test('mixed fixed forward and reply refusals account for all 97 synthetic owners without expanding eligibility', async (t) => {
  const rows = Array.from({ length: 97 }, (_, index) => row(index + 1));
  const refusals = new Map([
    [rows[2].claim.ownerId, 'source_forward_shape'],
    [rows[10].claim.ownerId, 'source_forward_sender_null'],
    [rows[27].claim.ownerId, 'source_forward_chat_absent'],
    [rows[44].claim.ownerId, 'source_forward_linked_text_null'],
    [rows[61].claim.ownerId, 'source_forward_linked_media'],
    [rows[78].claim.ownerId, 'source_reply_shape'],
    [rows[95].claim.ownerId, 'source_forward_link_keys'],
  ]);
  const h = planner(writeWalk(t, [...rows, unresolvedRow(98)]).read(), (value, input) => {
    const rejected = input.selection.ownerWebhookEventIds.find((id) => refusals.has(id));
    return rejected ? linkedShapeDenial(value, refusals.get(rejected)) : value;
  });
  const result = await planSourceAbandonmentSessionChildren(h.options);
  const supported = result.children.flatMap((child) =>
    child.authorities.map((entry) => entry.ownerId),
  );
  assert.equal(result.feasible, true);
  assert.equal(result.nominatedOwners, 97);
  assert.deepEqual(result.excludedCounts, { rejected: 7, unresolved: 1 });
  assert.deepEqual(
    supported.sort(),
    rows
      .map((entry) => entry.claim.ownerId)
      .filter((id) => !refusals.has(id))
      .sort(),
  );
  assert.equal(new Set(supported).size + result.excludedCounts.rejected, 97);
  for (const [ownerId, code] of refusals)
    assert.ok(
      h.proofs.some(
        (proof, index) =>
          h.calls[index].selection.ownerWebhookEventIds.length === 1 &&
          h.calls[index].selection.ownerWebhookEventIds[0] === ownerId &&
          proof.decision === 'DENY' &&
          proof.issues[0].code === code,
      ),
    );
  for (const child of result.children)
    assert.equal(
      h.proofs.find((proof) => proofDigest(proof) === child.admissionDigest).decision,
      'READY_FOR_COLD_REVIEW',
    );
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  for (const key of ['pages', 'rows', 'probes', 'bytes'])
    assert.equal(
      result.admissionCost[key],
      h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
    );
  assert.ok(result.admissionCalls <= SOURCE_ABANDONMENT_SESSION_LIMITS.admissionCalls);
  assert.equal(h.peak(), 1);
});

for (const code of fixedLinkedShapeDenialCodes)
  test(`${code} from another producer remains a global denial`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      const denied = linkedShapeDenial(value, code);
      denied.issues[0].descriptor = 'sql:source-family';
      return denied;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(result.admissionCalls, 1);
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  });

for (const code of [
  'source_forward_shape',
  'source_forward_sender_null',
  'source_reply_shape',
  'source_forward_linked_media_audio_strict',
])
  for (const [name, change] of [
    [
      'global SQL budget',
      (value) =>
        value.issues.push({
          code: 'sql_budget_exceeded',
          descriptor: 'sql:inventory',
        }),
    ],
    [
      'Redis refusal',
      (value) =>
        value.issues.push({
          code: 'REDIS_STORE_OR_SOURCE_REFUSED',
          descriptor: 'redis:max-actions-background',
        }),
    ],
    [
      'unknown issue',
      (value) =>
        value.issues.push({
          code: 'source_forward_unreviewed',
          descriptor: 'sql:selected-source',
        }),
    ],
    [
      'unknown candidate descriptor',
      (value) => {
        value.issues[2].descriptor = 'sql:unknown';
      },
    ],
    [
      'extra issue property',
      (value) => {
        value.issues[0].privateValue = 'private';
      },
    ],
    [
      'missing content summary',
      (value) => {
        value.issues.splice(1, 1);
      },
    ],
    [
      'null issue',
      (value) => {
        value.issues[0] = null;
      },
    ],
  ])
    test(`${code} mixed with ${name} never splits or drops owners`, async (t) => {
      const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
        const denied = linkedShapeDenial(value, code);
        change(denied);
        return denied;
      });
      const result = await planSourceAbandonmentSessionChildren(h.options);
      assert.equal(result.reason, 'global_admission_refused');
      assert.equal(result.admissionCalls, 1);
      assert.deepEqual(result.children, []);
      assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
      assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    });

function chatTypeDenial(value) {
  return {
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [
      { code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' },
      { code: 'source_chat_type', descriptor: 'sql:selected-source' },
      { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
      { code: 'source_candidate_unproved', descriptor: 'sql:webhook_events' },
    ],
  };
}

for (const ownerCount of [1, 3, 87])
  test(`unsupported chat type stays excluded while all ${ownerCount} owners are accounted for`, async (t) => {
    const rows = Array.from({ length: ownerCount }, (_, index) => row(index + 1));
    const rejectedOwner = rows[Math.floor(ownerCount / 2)].claim.ownerId;
    const h = planner(
      writeWalk(t, [...rows, unresolvedRow(ownerCount + 1)]).read(),
      (value, input) =>
        input.selection.ownerWebhookEventIds.includes(rejectedOwner)
          ? chatTypeDenial(value)
          : value,
    );
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, ownerCount > 1);
    assert.equal(result.reason, ownerCount > 1 ? null : 'no_supported_children');
    assert.equal(result.nominatedOwners, ownerCount);
    assert.deepEqual(result.excludedCounts, { rejected: 1, unresolved: 1 });
    assert.deepEqual(
      result.children.flatMap((child) => child.authorities.map((entry) => entry.ownerId)).sort(),
      rows
        .map((entry) => entry.claim.ownerId)
        .filter((id) => id !== rejectedOwner)
        .sort(),
    );
    assert.ok(
      h.calls.some(
        (input) =>
          input.selection.ownerWebhookEventIds.length === 1 &&
          input.selection.ownerWebhookEventIds[0] === rejectedOwner,
      ),
    );
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    for (const child of result.children) {
      const proof = h.proofs.find((value) => proofDigest(value) === child.admissionDigest);
      assert.equal(proof.decision, 'READY_FOR_COLD_REVIEW');
      assert.equal(proof.sourceCoverageComplete, true);
      assert.equal(proof.selectionSha256, canonical(child.selection));
    }
    for (const key of ['pages', 'rows', 'probes', 'bytes'])
      assert.equal(
        result.admissionCost[key],
        h.proofs.reduce((sum, value) => sum + value.cost[key], 0),
      );
    assert.equal(h.peak(), 1);
  });

for (const [name, change] of [
  [
    'global SQL error',
    (value) => value.issues.push({ code: 'sql_budget_exceeded', descriptor: 'sql:inventory' }),
  ],
  [
    'Redis error',
    (value) =>
      value.issues.push({
        code: 'REDIS_STORE_OR_SOURCE_REFUSED',
        descriptor: 'redis:max-actions-background',
      }),
  ],
  [
    'unknown source code',
    (value) => {
      value.issues[1].code = 'source_unknown';
    },
  ],
  [
    'source-family descriptor',
    (value) => {
      value.issues[1].descriptor = 'sql:source-family';
    },
  ],
  [
    'global descriptor',
    (value) => {
      value.issues[2].descriptor = 'sql:inventory';
    },
  ],
  [
    'unknown candidate descriptor',
    (value) => {
      value.issues[3].descriptor = 'sql:unknown_table';
    },
  ],
  [
    'extra issue property',
    (value) => {
      value.issues[1].extra = true;
    },
  ],
  [
    'null issue',
    (value) => {
      value.issues[1] = null;
    },
  ],
  [
    'missing content summary',
    (value) => {
      value.issues.splice(2, 1);
    },
  ],
])
  test(`chat-type split refuses ${name} without dropping owners`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      const denied = chatTypeDenial(value);
      change(denied);
      return denied;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(result.admissionCalls, 1);
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  });

test('chat-type bisection keeps the original admission budget and cannot return a partial plan', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2), row(3)]).read(), chatTypeDenial);
  h.options.maximumAdmissionCalls = 1;
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.reason, 'admission_budget');
  assert.equal(result.admissionCalls, 1);
  assert.deepEqual(result.children, []);
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
});

function sqlPageDenial(value, descriptor = 'sql:channel_auto_post_attach_markers') {
  return {
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'sql_budget_exceeded', descriptor }],
    cost: { pages: 511, rows: 313, probes: 5916, bytes: 348961 },
  };
}

function mixedSqlPageDenial(value, descriptor = 'redis:max-actions-interactive') {
  const denied = sqlPageDenial(value);
  denied.issues.unshift({ code: 'REDIS_STORE_OR_SOURCE_REFUSED', descriptor });
  return denied;
}

function actionPageDenial(value, descriptor = 'redis:max-actions-background') {
  return {
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'ACTION_PAGE_UNPROVED', descriptor }],
  };
}

for (const descriptor of [
  'redis:moderation-actions',
  'redis:max-actions-critical',
  'redis:max-actions-interactive',
  'redis:max-actions-background',
])
  test(`fresh action-page admission retries ${descriptor} without reusing failed authority`, async (t) => {
    let attempts = 0;
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      assert.equal(h.proofs.length, attempts, 'each earlier proof is durable before retry');
      attempts++;
      if (attempts === 3) return value;
      return {
        ...actionPageDenial(value, descriptor),
        cost: {
          pages: 10 + attempts,
          rows: 2 + attempts,
          probes: 20 + attempts,
          bytes: 300 + attempts,
        },
      };
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, true);
    assert.equal(result.admissionCalls, 3);
    assert.equal(h.peak(), 1);
    assert.deepEqual(
      h.calls.map((call) => JSON.stringify(call)),
      Array(3).fill(JSON.stringify(h.calls[0])),
    );
    assert.deepEqual(
      h.proofs.map((proof) => proof.decision),
      ['DENY', 'DENY', 'READY_FOR_COLD_REVIEW'],
    );
    assert.equal(new Set(h.proofs.map(proofDigest)).size, 3);
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    for (const key of ['pages', 'rows', 'probes', 'bytes'])
      assert.equal(
        result.admissionCost[key],
        h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
      );
    assert.deepEqual(
      result.children.flatMap((child) => child.authorities),
      h.options.enumeration.authorities,
    );
    assert.equal(result.children[0].admissionDigest, proofDigest(h.proofs[2]));
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  });

function dynamicActionDenial(
  value,
  {
    code = 'ACTION_MULTIPLE_STATES',
    descriptor = 'redis:max-actions-background',
    semantic = true,
    reversed = false,
  } = {},
) {
  const issues = [
    { code, descriptor },
    ...(semantic
      ? [
          { code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' },
          { code: 'source_chat_type', descriptor: 'sql:selected-source' },
          { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
          { code: 'source_candidate_unproved', descriptor: 'sql:webhook_events' },
        ]
      : []),
  ];
  return {
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: reversed ? issues.reverse() : issues,
  };
}

for (const code of ['ACTION_PAGE_UNPROVED', 'ACTION_MULTIPLE_STATES'])
  for (const descriptor of [
    'redis:moderation-actions',
    'redis:max-actions-critical',
    'redis:max-actions-interactive',
    'redis:max-actions-background',
  ])
    for (const reversed of [false, true])
      test(`known compound ${code} ${descriptor} reversed=${reversed} retries identical full admission`, async (t) => {
        let attempts = 0;
        const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
          assert.equal(
            h.proofs.length,
            attempts,
            'failed proof is retained before next collector call',
          );
          attempts++;
          if (attempts === 3) return value;
          return {
            ...dynamicActionDenial(value, { code, descriptor, reversed }),
            cost: {
              pages: 10 + attempts,
              rows: 2 + attempts,
              probes: 20 + attempts,
              bytes: 300 + attempts,
            },
          };
        });
        const result = await planSourceAbandonmentSessionChildren(h.options);
        assert.equal(result.feasible, true);
        assert.equal(result.admissionCalls, 3);
        assert.equal(h.peak(), 1);
        assert.deepEqual(h.calls, Array(3).fill(h.calls[0]));
        assert.deepEqual(
          h.proofs.map((p) => p.decision),
          ['DENY', 'DENY', 'READY_FOR_COLD_REVIEW'],
        );
        assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
        for (const key of ['pages', 'rows', 'probes', 'bytes'])
          assert.equal(
            result.admissionCost[key],
            h.proofs.reduce((sum, p) => sum + p.cost[key], 0),
          );
        assert.deepEqual(
          result.children.flatMap((p) => p.authorities),
          h.options.enumeration.authorities,
        );
        assert.equal(result.children[0].admissionDigest, proofDigest(h.proofs[2]));
        assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
      });

for (const semantic of [false, true])
  test(`third repeated state observation semantic=${semantic} stops without a fourth call or exclusion`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) =>
      dynamicActionDenial(value, { semantic }),
    );
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, false);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls, Array(3).fill(h.calls[0]));
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  });

test('compound denial cannot split or reject an owner until a fresh sole semantic denial', async (t) => {
  let attempts = 0;
  const enumeration = writeWalk(t, [row(1), row(2)]).read();
  const deniedOwner = enumeration.authorities[0].ownerId;
  const sole = (value) => ({
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
  });
  const h = planner(enumeration, (value, input) => {
    attempts++;
    if (attempts === 1) return dynamicActionDenial(value);
    if (
      input.selection.ownerWebhookEventIds.length === 2 ||
      input.selection.ownerWebhookEventIds[0] === deniedOwner
    )
      return sole(value);
    return value;
  });
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.deepEqual(
    h.calls.map((p) => p.selection.ownerWebhookEventIds.length),
    [2, 2, 1, 1],
  );
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.excludedCounts, { rejected: 1, unresolved: 0 });
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].admissionDigest, proofDigest(h.proofs[3]));
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
});

for (const [name, change] of [
  [
    'unknown infrastructure code',
    (v) => {
      v.issues[0].code = 'REDIS_STORE_OR_SOURCE_REFUSED';
    },
  ],
  [
    'unknown action descriptor',
    (v) => {
      v.issues[0].descriptor = 'redis:publisher-actions';
    },
  ],
  [
    'observation queue descriptor',
    (v) => {
      v.issues[0].descriptor = 'redis:global-spammer-denorm';
    },
  ],
  [
    'extra issue property',
    (v) => {
      v.issues[0].extra = true;
    },
  ],
  [
    'second dynamic issue',
    (v) => {
      v.issues.push({ code: 'ACTION_PAGE_UNPROVED', descriptor: 'redis:max-actions-critical' });
    },
  ],
  [
    'duplicate dynamic issue',
    (v) => {
      v.issues.push({ ...v.issues[0] });
    },
  ],
  [
    'duplicate semantic issue',
    (v) => {
      v.issues.push({ ...v.issues[1] });
    },
  ],
  [
    'unknown semantic code',
    (v) => {
      v.issues.push({ code: 'source_unknown', descriptor: 'sql:selected-source' });
    },
  ],
  [
    'wrong semantic descriptor',
    (v) => {
      v.issues[2].descriptor = 'sql:source-family';
    },
  ],
  [
    'SQL budget issue',
    (v) => {
      v.issues.push({ code: 'sql_budget_exceeded', descriptor: 'sql:max_action_ledger' });
    },
  ],
  [
    'global inventory issue',
    (v) => {
      v.issues.push({ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' });
    },
  ],
  [
    'no semantic primary',
    (v) => {
      v.issues = v.issues.filter((p) => p.code !== 'source_content_unproved');
    },
  ],
  [
    'null issue',
    (v) => {
      v.issues.push(null);
    },
  ],
])
  test(`compound retry refuses ${name} immediately without splitting`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      const denied = dynamicActionDenial(value);
      change(denied);
      return denied;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  });

for (const limit of ['calls', 'deadline'])
  test(`compound retry respects original ${limit} ceiling and retains charged DENY`, async (t) => {
    let time = 1000;
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      if (limit === 'deadline') time = 60000;
      return dynamicActionDenial(value);
    });
    const result = await planSourceAbandonmentSessionChildren({
      ...h.options,
      now: () => time,
      maximumAdmissionCalls: limit === 'calls' ? 1 : 480,
    });
    assert.equal(result.reason, 'admission_budget');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    assert.deepEqual(result.admissionCost, h.proofs[0].cost);
    assert.deepEqual(result.children, []);
  });

for (const field of ['selection', 'registry', 'source', 'publisher', 'READY authority'])
  test(`compound retry rejects changed ${field} before any child authority`, async (t) => {
    let attempts = 0;
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      attempts++;
      if (attempts === 1) return dynamicActionDenial(value);
      if (field === 'selection') value.selectionSha256 = 'e'.repeat(64);
      if (field === 'registry') value.registrySha256 = 'e'.repeat(64);
      if (field === 'source') value.sourceSha = 'e'.repeat(40);
      if (field === 'publisher') value.publisherCatalogSha256 = 'e'.repeat(64);
      if (field === 'READY authority') value.selectedOwners[0].claimId = 'changed';
      return value;
    });
    await assert.rejects(planSourceAbandonmentSessionChildren(h.options));
    assert.equal(h.calls.length, 2);
    assert.equal(h.proofs[0].decision, 'DENY');
  });

test('third action-page failure refuses the whole plan without a fourth call or exclusion', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => actionPageDenial(value));
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'global_admission_refused');
  assert.equal(result.admissionCalls, 3);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls, Array(3).fill(h.calls[0]));
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  assert.equal(h.proofs.length, 3);
  assert.equal(result.admissionCost.pages, 6);
  assert.deepEqual(result.children, []);
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
});

for (const [name, change] of [
  [
    'extra property',
    (value) => {
      value.issues[0].extra = true;
    },
  ],
  [
    'semantic issue without a selected-source primary',
    (value) => {
      value.issues.push({ code: 'source_candidate_unproved', descriptor: 'sql:webhook_events' });
    },
  ],
  [
    'mixed SQL budget',
    (value) => {
      value.issues.push({ code: 'sql_budget_exceeded', descriptor: 'sql:max_action_ledger' });
    },
  ],
  [
    'unknown descriptor',
    (value) => {
      value.issues[0].descriptor = 'redis:publisher-actions';
    },
  ],
  [
    'unknown code',
    (value) => {
      value.issues[0].code = 'REDIS_STORE_OR_SOURCE_REFUSED';
    },
  ],
  [
    'null issue',
    (value) => {
      value.issues = [null];
    },
  ],
  [
    'non-array issues',
    (value) => {
      value.issues = { code: 'ACTION_PAGE_UNPROVED', descriptor: 'redis:moderation-actions' };
    },
  ],
])
  test(`action-page retry refuses ${name} immediately and retains its denial`, async (t) => {
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      const denied = actionPageDenial(value);
      change(denied);
      return denied;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(result.admissionCalls, 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    assert.equal(result.admissionCost.pages, h.proofs[0].cost.pages);
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  });

for (const [name, change] of [
  [
    'runtime identity',
    (value) => {
      value.sourceSha = 'e'.repeat(40);
    },
  ],
  [
    'selection identity',
    (value) => {
      value.selectionSha256 = 'e'.repeat(64);
    },
  ],
  [
    'publisher identity',
    (value) => {
      value.publisherCatalogSha256 = 'e'.repeat(64);
    },
  ],
  [
    'invalid cost',
    (value) => {
      value.cost.pages = 513;
    },
  ],
  [
    'malformed registry',
    (value) => {
      value.registrySha256 = 'invalid';
    },
  ],
  [
    'false DENY coverage',
    (value) => {
      value.sourceCoverageComplete = true;
    },
  ],
])
  test(`action-page ${name} fails validation before another collector call`, async (t) => {
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      const denied = actionPageDenial(value);
      change(denied);
      return denied;
    });
    await assert.rejects(planSourceAbandonmentSessionChildren(h.options));
    assert.equal(h.calls.length, 1);
  });

test('action-page retry cannot accept a changed registry or an invalid eventual READY', async (t) => {
  for (const failure of ['registry', 'READY authority']) {
    let attempts = 0;
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      attempts++;
      if (attempts === 1) return actionPageDenial(value);
      if (failure === 'registry')
        return { ...actionPageDenial(value), registrySha256: 'e'.repeat(64) };
      value.selectedOwners[0].claimId = 'changed';
      return value;
    });
    await assert.rejects(
      planSourceAbandonmentSessionChildren(h.options),
      /registry_changed|unproved/,
    );
    assert.equal(h.calls.length, 2);
    assert.equal(h.proofs[0].decision, 'DENY');
  }
});

for (const limit of ['calls', 'deadline'])
  test(`action-page retry preserves failed proof and cost at the global ${limit} limit`, async (t) => {
    let time = 1000;
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      if (limit === 'deadline') time = 60000;
      return actionPageDenial(value);
    });
    const result = await planSourceAbandonmentSessionChildren({
      ...h.options,
      now: () => time,
      maximumAdmissionCalls: limit === 'calls' ? 1 : 480,
    });
    assert.equal(result.reason, 'admission_budget');
    assert.equal(result.admissionCalls, 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    assert.deepEqual(result.admissionCost, h.proofs[0].cost);
    assert.deepEqual(result.children, []);
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  });

test('action-page attempts are scoped independently across semantic recursion', async (t) => {
  const attempts = new Map();
  const enumeration = writeWalk(
    t,
    Array.from({ length: 7 }, (_, index) => row(index + 1)),
  ).read();
  const h = planner(enumeration, (value, input) => {
    const key = canonical(input.selection);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (input.selection.ownerWebhookEventIds.length === 7 && attempt === 2)
      return {
        ...value,
        decision: 'DENY',
        sourceCoverageComplete: false,
        issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
      };
    return attempt < 3 ? actionPageDenial(value) : value;
  });
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, true);
  assert.equal(result.admissionCalls, 8);
  assert.deepEqual([...attempts.values()], [2, 3, 3]);
  assert.deepEqual(
    h.calls.map((input) => input.selection.ownerWebhookEventIds.length),
    [7, 7, 4, 4, 4, 3, 3, 3],
  );
  assert.deepEqual(
    result.children.flatMap((child) => child.authorities),
    enumeration.authorities,
  );
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
});

test('fresh retries and semantic splitting share the unchanged 480-call ceiling', async (t) => {
  const attempts = new Map();
  const enumeration = writeWalk(
    t,
    Array.from({ length: 256 }, (_, index) => row(index + 1)),
  ).read();
  const h = planner(enumeration, (value, input) => {
    const key = canonical(input.selection);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return attempt === 1
      ? actionPageDenial(value)
      : {
          ...value,
          decision: 'DENY',
          sourceCoverageComplete: false,
          issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
        };
  });
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(SOURCE_ABANDONMENT_SESSION_LIMITS.admissionCalls, 480);
  assert.equal(result.reason, 'admission_budget');
  assert.equal(result.admissionCalls, 480);
  assert.equal(h.calls.length, 480);
  assert.equal(h.proofs.length, 480);
  assert.ok([...attempts.values()].every((count) => count <= 2));
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  for (const key of ['pages', 'rows', 'probes', 'bytes'])
    assert.equal(
      result.admissionCost[key],
      h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
    );
  assert.deepEqual(result.children, []);
});

test('a smaller admission pack proves all owners without changing certificate or work ceilings', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 7 }, (_, i) => row(i + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren({
    ...h.options,
    maximumOwnersPerAdmission: 3,
  });
  assert.equal(result.feasible, true);
  assert.deepEqual(
    h.calls.map((call) => call.selection.ownerWebhookEventIds.length),
    [3, 3, 1],
  );
  assert.deepEqual(
    result.children.flatMap((child) => child.authorities),
    enumeration.authorities,
  );
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  assert.equal(result.admissionCalls, 3);
  for (const child of result.children) {
    const proof = h.proofs.find((value) => proofDigest(value) === child.admissionDigest);
    assert.equal(proof.decision, 'READY_FOR_COLD_REVIEW');
    assert.equal(proof.selectionSha256, canonical(child.selection));
  }
  const bounded = planner(enumeration);
  const refused = await planSourceAbandonmentSessionChildren({
    ...bounded.options,
    maximumOwnersPerAdmission: 3,
    maximumChildren: 2,
  });
  assert.equal(refused.feasible, false);
  assert.equal(refused.reason, 'child_limit');
  assert.deepEqual(refused.children, []);
  assert.equal(refused.admissionCalls, 3);
  assert.deepEqual(refused.excludedCounts, { rejected: 0, unresolved: 0 });
});

for (const maximumOwnersPerAdmission of [0, 8, 1.5, null])
  test(`invalid admission pack ${maximumOwnersPerAdmission} fails before collection`, async (t) => {
    const h = planner(writeWalk(t, [row(1)]).read());
    await assert.rejects(
      planSourceAbandonmentSessionChildren({ ...h.options, maximumOwnersPerAdmission }),
    );
    assert.equal(h.calls.length, 0);
  });

test('initial seven-owner packing admits all 165 owners in 24 complete fresh calls', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 165 }, (_, i) => row(i + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(SOURCE_ABANDONMENT_SESSION_LIMITS.ownersPerChild, 8);
  assert.equal(result.feasible, true);
  assert.equal(result.children.length, 24);
  assert.equal(result.admissionCalls, 24);
  assert.deepEqual(
    h.calls.map((call) => call.selection.ownerWebhookEventIds.length),
    [...Array(23).fill(7), 4],
  );
  assert.deepEqual(
    result.children.flatMap((child) => child.authorities),
    enumeration.authorities,
  );
  assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
  assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
  for (const child of result.children) {
    const proof = h.proofs.find((value) => proofDigest(value) === child.admissionDigest);
    assert.equal(proof.decision, 'READY_FOR_COLD_REVIEW');
    assert.equal(proof.selectionSha256, canonical(child.selection));
  }
  assert.equal(h.peak(), 1);
});

for (const [name, denial] of [
  ['sole SQL', sqlPageDenial],
  ['known mixed SQL/Redis', mixedSqlPageDenial],
])
  test(`${name} page exhaustion repacks all 165 owners into 28 fresh children and charges every proof`, async (t) => {
    const enumeration = writeWalk(
      t,
      Array.from({ length: 165 }, (_, i) => row(i + 1)),
    ).read();
    const h = planner(enumeration, (value, input) =>
      input.selection.ownerWebhookEventIds.length > 6 ? denial(value) : value,
    );
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, true);
    assert.equal(result.children.length, 28);
    assert.equal(result.admissionCalls, 29);
    assert.deepEqual(
      result.children.flatMap((child) => child.authorities),
      enumeration.authorities,
    );
    assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
    assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
    for (const key of ['pages', 'rows', 'probes', 'bytes'])
      assert.equal(
        result.admissionCost[key],
        h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
      );
    assert.equal(result.admissionCost.pages, 567);
    assert.deepEqual(
      h.calls.map((call) => call.selection.ownerWebhookEventIds.length),
      [7, ...Array(27).fill(6), 3],
    );
    for (const child of result.children) {
      const proof = h.proofs.find((value) => proofDigest(value) === child.admissionDigest);
      assert.equal(proof.decision, 'READY_FOR_COLD_REVIEW');
      assert.equal(proof.selectionSha256, canonical(child.selection));
    }
    assert.equal(h.peak(), 1);
  });

for (const descriptor of [
  'redis:moderation-actions',
  'redis:max-actions-critical',
  'redis:max-actions-interactive',
  'redis:max-actions-background',
])
  for (const pages of [511, 512])
    for (const reversed of [false, true])
      test(`mixed page refusal repacks ${descriptor} at ${pages} pages, reversed=${reversed}`, async (t) => {
        const enumeration = writeWalk(t, [row(1), row(2)]).read();
        const h = planner(enumeration, (value, input) => {
          if (input.selection.ownerWebhookEventIds.length === 1) {
            assert.equal(h.proofs[0].decision, 'DENY');
            return value;
          }
          const denied = mixedSqlPageDenial(value, descriptor);
          denied.cost.pages = pages;
          if (reversed) denied.issues.reverse();
          return denied;
        });
        const result = await planSourceAbandonmentSessionChildren(h.options);
        assert.equal(result.feasible, true);
        assert.deepEqual(
          h.calls.map((call) => call.selection.ownerWebhookEventIds.length),
          [2, 1, 1],
        );
        assert.deepEqual(
          result.children.flatMap((child) => child.authorities),
          enumeration.authorities,
        );
        assert.deepEqual(result.excludedCounts, { rejected: 0, unresolved: 0 });
        assert.deepEqual(result.admissionProofs, h.proofs.map(proofDigest));
        for (const key of ['pages', 'rows', 'probes', 'bytes'])
          assert.equal(
            result.admissionCost[key],
            h.proofs.reduce((sum, proof) => sum + proof.cost[key], 0),
          );
      });

test('successively smaller SQL groups retain all owners and the hard child ceiling', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 193 }, (_, i) => row(i + 1)),
  ).read();
  const h = planner(enumeration, (value, input) =>
    input.selection.ownerWebhookEventIds.length > 6
      ? sqlPageDenial(value, 'sql:max_action_ledger')
      : value,
  );
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'child_limit');
  assert.equal(SOURCE_ABANDONMENT_SESSION_LIMITS.children, 32);
  assert.equal(result.admissionCalls, 34);
  assert.equal(result.nominatedOwners, 193);
  assert.deepEqual(result.children, []);
  assert.equal(result.excludedCounts.rejected, 0);
  assert.deepEqual(
    h.calls.slice(0, 2).map((call) => call.selection.ownerWebhookEventIds.length),
    [7, 6],
  );
});

for (const budgetBranch of ['left', 'right'])
  test(`SQL exhaustion inside the ${budgetBranch} semantic branch preserves the unconsumed suffix`, async (t) => {
    const enumeration = writeWalk(
      t,
      Array.from({ length: 11 }, (_, i) => row(i + 1)),
    ).read();
    const rejectedOwner = enumeration.authorities[6].ownerId;
    const budgetOwner = enumeration.authorities[budgetBranch === 'left' ? 0 : 4].ownerId;
    const budgetSize = budgetBranch === 'left' ? 4 : 3;
    const h = planner(enumeration, (value, input) => {
      const selected = input.selection.ownerWebhookEventIds;
      if (selected.length === budgetSize && selected.includes(budgetOwner))
        return sqlPageDenial(value);
      if (selected.length === 7 || selected.includes(rejectedOwner))
        return {
          ...value,
          decision: 'DENY',
          sourceCoverageComplete: false,
          issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
        };
      return value;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.feasible, true);
    assert.deepEqual(
      result.children.flatMap((child) => child.authorities),
      enumeration.authorities.filter((value) => value.ownerId !== rejectedOwner),
    );
    assert.equal(result.excludedCounts.rejected, 1);
    const accepted = h.proofs.filter((value) => value.decision === 'READY_FOR_COLD_REVIEW');
    assert.equal(
      new Set(
        accepted.flatMap((value) => value.selectedOwners.map((owner) => owner.ownerWebhookEventId)),
      ).size,
      10,
    );
    if (budgetBranch === 'right')
      assert.equal(
        h.calls.filter((call) =>
          call.selection.ownerWebhookEventIds.includes(enumeration.authorities[0].ownerId),
        ).length,
        2,
      );
  });

for (const [name, denial] of [
  ['SQL', sqlPageDenial],
  ['mixed SQL/Redis', mixedSqlPageDenial],
])
  test(`a singleton ${name} resource refusal cannot be excluded as unsupported content`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => denial(value));
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(result.admissionCalls, 2);
    assert.equal(result.excludedCounts.rejected, 0);
    assert.deepEqual(result.children, []);
  });

for (const [name, change] of [
  [
    'global kind census',
    (value) => {
      value.issues[0].descriptor = 'sql:claim-kind-prefix';
    },
  ],
  [
    'default SQL scope',
    (value) => {
      value.issues[0].descriptor = 'sql:inventory';
    },
  ],
  [
    'unknown table',
    (value) => {
      value.issues[0].descriptor = 'sql:unknown_table';
    },
  ],
  [
    'semantic callback',
    (value) => {
      value.issues[0].descriptor = 'sql:selected-source';
    },
  ],
  [
    'mixed content failure',
    (value) => {
      value.issues.push({ code: 'source_content_unproved', descriptor: 'sql:selected-source' });
    },
  ],
  [
    'unknown mixed Redis source failure',
    (value) => {
      value.issues.unshift({
        code: 'REDIS_STORE_OR_SOURCE_REFUSED',
        descriptor: 'redis:inventory',
      });
    },
  ],
  ...[
    [
      'extra mixed issue',
      (value) =>
        value.issues.push({ code: 'unknown', descriptor: 'redis:max-actions-interactive' }),
    ],
    [
      'malformed mixed Redis issue',
      (value) => {
        value.issues[0].extra = true;
      },
    ],
    [
      'unknown mixed SQL descriptor',
      (value) => {
        value.issues[1].descriptor = 'sql:inventory';
      },
    ],
    [
      'unknown mixed Redis code',
      (value) => {
        value.issues[0].code = 'ACTION_PAGE_UNPROVED';
      },
    ],
    [
      'duplicate mixed Redis issue',
      (value) => {
        value.issues[1] = clone(value.issues[0]);
      },
    ],
    [
      'missing mixed issue',
      (value) => {
        value.issues[0] = null;
      },
    ],
    [
      'mixed unproved page exhaustion',
      (value) => {
        value.cost.pages = 510;
      },
    ],
  ].map(([name, change]) => [
    name,
    (value) => {
      value.issues.unshift({
        code: 'REDIS_STORE_OR_SOURCE_REFUSED',
        descriptor: 'redis:max-actions-interactive',
      });
      change(value);
    },
  ]),
  [
    'multiple budget issues',
    (value) => {
      value.issues.push(clone(value.issues[0]));
    },
  ],
  [
    'extra issue metadata',
    (value) => {
      value.issues[0].extra = true;
    },
  ],
  [
    'unknown issue',
    (value) => {
      value.issues[0].code = 'sql_deadline_exceeded';
    },
  ],
  [
    'missing issue',
    (value) => {
      value.issues = [null];
    },
  ],
  [
    'non-array issues',
    (value) => {
      value.issues = {};
    },
  ],
  [
    'unproved page exhaustion',
    (value) => {
      value.cost.pages = 510;
    },
  ],
])
  test(`SQL packing refuses ${name} without another admission`, async (t) => {
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      const denied = sqlPageDenial(value);
      change(denied);
      return denied;
    });
    const result = await planSourceAbandonmentSessionChildren(h.options);
    assert.equal(result.reason, 'global_admission_refused');
    assert.equal(result.admissionCalls, 1);
    assert.equal(result.excludedCounts.rejected, 0);
    assert.deepEqual(result.children, []);
  });

for (const limit of ['calls', 'deadline'])
  test(`SQL repacking preserves the ${limit} budget and retained denial cost`, async (t) => {
    let clock = 1000;
    const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => {
      if (limit === 'deadline') clock = 60000;
      return sqlPageDenial(value);
    });
    const result = await planSourceAbandonmentSessionChildren({
      ...h.options,
      maximumAdmissionCalls: 1,
      now: () => clock,
    });
    assert.equal(result.reason, 'admission_budget');
    assert.equal(result.admissionCalls, 1);
    assert.equal(result.admissionCost.pages, 511);
    assert.deepEqual(result.children, []);
  });

test('SQL repacking validates the new complete admission before accepting a child', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value, input) => {
    if (input.selection.ownerWebhookEventIds.length === 2) return sqlPageDenial(value);
    value.selectedOwners[0].claimId = 'changed';
    return value;
  });
  await assert.rejects(planSourceAbandonmentSessionChildren(h.options), /unproved/);
});

for (const [name, change] of [
  [
    'source identity',
    (value) => {
      value.sourceSha = 'e'.repeat(40);
    },
  ],
  [
    'immutable image',
    (value) => {
      value.imageId = `sha256:${'e'.repeat(64)}`;
    },
  ],
  [
    'canonical selection',
    (value) => {
      value.selectionSha256 = 'e'.repeat(64);
    },
  ],
  [
    'publisher catalog',
    (value) => {
      value.publisherCatalogSha256 = 'e'.repeat(64);
    },
  ],
  [
    'authority',
    (value) => {
      value.selectedOwners[0].claimId = 'other';
    },
  ],
  [
    'source cutoff',
    (value) => {
      value.selectedOwners[0].sourceAt = request.cutoff;
    },
  ],
  [
    'incomplete catalog',
    (value) => {
      value.redisCatalogs[0].complete = false;
    },
  ],
  [
    'cost ceiling',
    (value) => {
      value.cost.rows = 10001;
    },
  ],
])
  test(`READY admission with changed ${name} never enters the manifest`, async (t) => {
    const h = planner(writeWalk(t, [row(1)]).read(), (value) => {
      change(value);
      return value;
    });
    await assert.rejects(planSourceAbandonmentSessionChildren(h.options));
  });

test('planner refuses more than the complete parent owner ceiling before admission or truncation', async (t) => {
  const nominated =
    SOURCE_ABANDONMENT_SESSION_LIMITS.children * SOURCE_ABANDONMENT_SESSION_LIMITS.ownersPerChild +
    1;
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: nominated }, (_, i) => row(i + 1)),
    ).read(),
  );
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'too_many_candidates');
  assert.equal(result.nominatedOwners, nominated);
  assert.equal(h.calls.length, 0);
});
test('complete 161-owner scope uses 23 unchanged finite certificates without truncation', async (t) => {
  const enumeration = writeWalk(
    t,
    Array.from({ length: 161 }, (_, index) => row(index + 1)),
  ).read();
  const h = planner(enumeration);
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, true);
  assert.equal(result.children.length, 23);
  assert.equal(result.admissionCalls, 23);
  assert.equal(result.children.flatMap((child) => child.authorities).length, 161);
  assert(result.children.every((child) => child.authorities.length <= 7));
  const denied = await planSourceAbandonmentSessionChildren({
    ...planner(enumeration).options,
    maximumChildren: 22,
  });
  assert.equal(denied.reason, 'child_limit');
  assert.deepEqual(denied.children, []);
});

test('planner refuses a child ceiling that cannot represent all supported owners', async (t) => {
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: 9 }, (_, i) => row(i + 1)),
    ).read(),
  );
  const result = await planSourceAbandonmentSessionChildren({ ...h.options, maximumChildren: 1 });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'child_limit');
  assert.deepEqual(result.children, []);
  assert.equal(result.nominatedOwners, 9);
});

test('global admission failure never triggers per-owner splitting and retains measured proof cost', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => ({
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' }],
  }));
  const result = await planSourceAbandonmentSessionChildren(h.options);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'global_admission_refused');
  assert.equal(result.admissionCalls, 1);
  assert.equal(result.admissionProofs.length, 1);
  assert.equal(result.admissionCost.rows, 2);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(result.children, []);
});
test('admission call budget refuses the complete plan without truncation', async (t) => {
  const h = planner(writeWalk(t, [row(1), row(2)]).read(), (value) => ({
    ...value,
    decision: 'DENY',
    sourceCoverageComplete: false,
    issues: [{ code: 'source_content_unproved', descriptor: 'sql:selected-source' }],
  }));
  const result = await planSourceAbandonmentSessionChildren({
    ...h.options,
    maximumAdmissionCalls: 1,
  });
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'admission_budget');
  assert.equal(result.admissionCalls, 1);
  assert.deepEqual(result.children, []);
});
test('forged admission persistence and changing registry never grant a child', async (t) => {
  const h = planner(
    writeWalk(
      t,
      Array.from({ length: 9 }, (_, i) => row(i + 1)),
    ).read(),
  );
  await assert.rejects(
    planSourceAbandonmentSessionChildren({ ...h.options, recordProof: () => hash }),
    /proof_write/,
  );
  let count = 0;
  const g = planner(h.options.enumeration, (value) => ({
    ...value,
    registrySha256: count++ === 0 ? hash : 'f'.repeat(64),
  }));
  await assert.rejects(planSourceAbandonmentSessionChildren(g.options), /registry_changed/);
});

async function frozenFixture(t, onlineRows = [row(1), unresolvedRow(2)]) {
  const enumeration = writeWalk(t, onlineRows).read(),
    p = planner(enumeration),
    plan = await planSourceAbandonmentSessionChildren(p.options);
  const manifest = {
    version: 1,
    kind: 'source_abandonment_session_manifest',
    sessionId: uuid(31),
    clusterIdentity: uuid(32),
    epoch: 1,
    controllerNonce: uuid(33),
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    cutoff: request.cutoff,
    baselineDigest: hash,
    topologyDigest: hash,
    registryDigest: plan.registryDigest,
    botCatalogDigest: plan.botCatalogDigest,
    enumerationDigest: enumeration.enumerationDigest,
    enumerationComplete: true,
    excludedCounts: plan.excludedCounts,
    budgets: Object.fromEntries(
      [
        'durationMs',
        'proofBytes',
        'inventoryPages',
        'inventoryRows',
        'inventoryProbes',
        'inventoryBytes',
        'materializationPages',
      ].map((key) => [key, SOURCE_ABANDONMENT_SESSION_LIMITS[key]]),
    ),
    children: plan.children,
  };
  const generation = (serviceName, index) => ({
    serviceName,
    containerId: String(index + 1).padStart(64, '0'),
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    stopped: false,
    exactGeneration: true,
    restartPolicy: 'unless-stopped',
    ...(serviceName.endsWith('sandbox') ? { nativeBoundaryDigest: hash } : {}),
  });
  const baseline = {
    version: 1,
    complete: true,
    sourceSha: request.sourceSha,
    imageId: request.imageId,
    selectionDigest: enumeration.enumerationDigest,
    controllerNonce: manifest.controllerNonce,
    singletonCount: 14,
    nativeCount: 2,
    compatible: true,
    unreviewedProducers: 0,
    services: LEGACY_COLD_API_SERVICES.map(generation),
    auxiliaries: ['ocr-native-sandbox', 'photo-native-sandbox'].map((name, index) =>
      generation(name, index + 14),
    ),
  };
  manifest.baselineDigest = digest(baseline);
  const bindings = sourceAbandonmentSessionRuntimeBindings(manifest);
  const stopped = {
    ...clone(baseline),
    services: baseline.services.map((value) => ({ ...value, stopped: true })),
    auxiliaries: baseline.auxiliaries.map((value) => ({ ...value, stopped: true })),
  };
  const state = {
    rows: clone(onlineRows),
    now: 1000,
    attestCount: 0,
    pageCount: 0,
    deadline: null,
    mutateAttestation: () => {},
  };
  const proofs = [];
  const options = {
    enumeration,
    baseline,
    limits: {
      inventoryPages: 512,
      inventoryRows: 10000,
      inventoryProbes: 50000,
      inventoryBytes: 8 * 1024 * 1024,
    },
    now: () => state.now,
    attestStopped: () => {
      state.attestCount++;
      state.mutateAttestation(stopped);
      return clone(stopped);
    },
    readPage: (parameters, { deadlineAtMs }) => {
      state.pageCount++;
      state.deadline = deadlineAtMs;
      const value = page(parameters, state.rows, false, {
        version: 3,
        kind: 'frozen_ordered_anchor_inventory_page',
        coverage: 'STOPPED_METADATA',
      });
      return frozenResult(value);
    },
    recordProof: (value) => {
      proofs.push(clone(value));
      return proofDigest(value);
    },
  };
  return {
    enumeration,
    plan,
    manifest,
    baseline,
    bindings,
    state,
    stopped,
    options,
    proofs,
    run: () =>
      createSourceAbandonmentSessionFrozenInventory(options)(manifest, bindings, {
        deadlineAtMs: 60000,
      }),
  };
}
function frozenResult(value, prefixAttempts = []) {
  const plan = { index: 'ordered' };
  const attempts = [
    ...prefixAttempts,
    {
      pageSize: value.pageSize,
      rawCount: value.rawCount,
      returnedRows: value.rows.length,
      refusal: null,
      outputBytes: Buffer.byteLength(JSON.stringify({ page: value, plan })),
      plan,
    },
  ];
  return {
    page: value,
    plan,
    attempts,
    cost: {
      inventoryPages: attempts.length,
      inventoryRows: attempts.reduce((sum, row) => sum + Math.min(row.rawCount, row.pageSize), 0),
      inventoryProbes: attempts.reduce((sum, row) => sum + 2 + 4 * row.rawCount, 0),
      inventoryBytes: attempts.reduce((sum, row) => sum + row.outputBytes, 0),
    },
  };
}
test('frozen complete index walk binds the same sixteen stopped generations and preserves unsupported scope', async (t) => {
  const h = await frozenFixture(t),
    result = await h.run();
  assert.equal(result.coverage, 'FROZEN');
  assert.equal(result.enumerationComplete, true);
  assert.equal(result.manifestMatches, true);
  assert.equal(result.plannedEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.frozenEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.remainingUnselectedRows, 1);
  assert.equal(result.resolvedUnselectedRows, 0);
  assert.equal(result.allBacklogCleared, false);
  assert.equal(result.fleetRecoveryProven, false);
  assert.equal(h.state.deadline, 60000);
  assert.ok(h.state.attestCount >= 3);
  assert.equal(h.proofs.length, 2);
  assert.equal(proofDigest(h.proofs.at(-1)), result.rawInventoryProof);
});
test('preselected200 covers the complete ordered universe with one charged attempt per page', async (t) => {
  const rows = [row(1), ...Array.from({ length: 1000 }, (_, index) => unresolvedRow(index + 2))];
  const h = await frozenFixture(t, rows);
  h.options.readPage = (parameters) => {
    const start = parameters.after
      ? rows.findIndex((row) => row.id === parameters.after.id) + 1
      : 0;
    assert.equal(parameters.pageSize, 200);
    const size = parameters.pageSize;
    const selected = rows.slice(start, start + size);
    const value = page({ ...parameters, pageSize: size }, selected, start + size < rows.length, {
      version: 3,
      kind: 'frozen_ordered_anchor_inventory_page',
      coverage: 'STOPPED_METADATA',
    });
    return frozenResult(value);
  };
  const result = await h.run();
  assert.equal(result.frozenEnumerationDigest, h.enumeration.enumerationDigest);
  assert.equal(result.cost.inventoryPages, 6);
  assert.equal(result.cost.inventoryRows, 1001);
  assert.equal(result.cost.inventoryProbes, 2 * 6 + 4 * (1001 + 5));
  const first = h.proofs.find((row) => row.kind === 'source_abandonment_frozen_page');
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].pageSize, 200);
  assert.equal(first.attempts[0].refusal, null);
});
test('frozen session rejects a legacy-sized or repeated attempt before saving a page', async (t) => {
  for (const mutate of [
    (value) => {
      value.attempts[0].pageSize = 1000;
    },
    (value) => {
      value.attempts.push(structuredClone(value.attempts[0]));
    },
    (value) => {
      value.attempts[0].refusal = 'output_budget';
    },
  ]) {
    const h = await frozenFixture(t);
    const read = h.options.readPage;
    h.options.readPage = (...args) => {
      const value = read(...args);
      mutate(value);
      return value;
    };
    await assert.rejects(h.run(), /attempts_unproved/);
    assert.equal(h.proofs.length, 0);
  }
});
test('frozen inventory rejects omitted or understated physical-attempt costs', async (t) => {
  for (const field of ['attempts', 'inventoryRows', 'inventoryProbes', 'inventoryBytes']) {
    const h = await frozenFixture(t);
    const original = h.options.readPage;
    h.options.readPage = (...args) => {
      const value = original(...args);
      if (field === 'attempts') delete value.attempts;
      else value.cost[field]--;
      return value;
    };
    await assert.rejects(h.run(), /attempts_unproved|cost_unproved/);
    assert.equal(h.proofs.length, 0);
  }
});
test('unselected rows may leave the complete ordered index without fabricating their effect outcome', async (t) => {
  const h = await frozenFixture(t);
  h.state.rows = [row(1)];
  const result = await h.run();
  assert.equal(result.resolvedUnselectedRows, 1);
  assert.equal(result.remainingUnselectedRows, 0);
  assert.equal(result.allBacklogCleared, false);
  assert.notEqual(result.frozenEnumerationDigest, result.plannedEnumerationDigest);
});
for (const [name, mutate] of [
  [
    'selected authority disappeared',
    (h) => {
      h.state.rows = [unresolvedRow(2)];
    },
  ],
  [
    'unknown old-cutoff addition',
    (h) => {
      h.state.rows.push(row(3));
    },
  ],
  [
    'claim changed',
    (h) => {
      h.state.rows[0].claim.id = 'other';
    },
  ],
  [
    'message changed',
    (h) => {
      h.state.rows[0].messageId = 'other';
    },
  ],
  [
    'order chat changed',
    (h) => {
      h.state.rows[0].orderChatId = 'other';
    },
  ],
  [
    'runtime generation changed',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.services[0].containerId = 'f'.repeat(64);
      };
    },
  ],
  [
    'native isolation changed',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.auxiliaries[0].nativeBoundaryDigest = 'f'.repeat(64);
      };
    },
  ],
  [
    'API still running',
    (h) => {
      h.state.mutateAttestation = (value) => {
        value.services[0].stopped = false;
      };
    },
  ],
  [
    'page budget exceeded',
    (h) => {
      h.options.limits.inventoryRows = 1;
    },
  ],
  [
    'deadline expired',
    (h) => {
      h.state.now = 60000;
    },
  ],
])
  test(`frozen review refuses ${name}`, async (t) => {
    const h = await frozenFixture(t);
    mutate(h);
    await assert.rejects(h.run());
  });
test('post-page deadline and generation changes cannot produce a frozen completeness proof', async (t) => {
  const h = await frozenFixture(t),
    read = h.options.readPage;
  h.options.readPage = (...args) => {
    const result = read(...args);
    h.state.now = 60000;
    return result;
  };
  await assert.rejects(h.run(), /page_unproved/);
  assert.equal(h.proofs.length, 0);
  const g = await frozenFixture(t);
  g.state.mutateAttestation = (value) => {
    if (g.state.attestCount === 2) value.services[1].containerId = 'f'.repeat(64);
  };
  await assert.rejects(g.run(), /generation_changed/);
  assert.equal(g.proofs.length, 0);
});
test('frozen proof may not use a different baseline or enumeration binding', async (t) => {
  const h = await frozenFixture(t);
  h.baseline.services[0].containerId = 'f'.repeat(64);
  await assert.rejects(h.run(), /binding_refused/);
  const g = await frozenFixture(t);
  g.manifest.enumerationDigest = 'f'.repeat(64);
  await assert.rejects(g.run());
});
test('frozen lower-only work limits cannot be widened by the caller', async (t) => {
  const h = await frozenFixture(t);
  h.options.limits.inventoryRows = 2000001;
  assert.throws(() => createSourceAbandonmentSessionFrozenInventory(h.options), /budget_refused/);
});
