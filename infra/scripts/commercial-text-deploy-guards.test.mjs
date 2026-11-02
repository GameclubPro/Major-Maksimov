import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const paths = {
  executor: 'apps/api/src/moderation/moderation-delete-intent.service.ts',
  commercial: 'apps/api/src/moderation/commercial/commercial-delete-guard.service.ts',
  binding: 'apps/api/src/moderation/commercial/commercial-delete-binding.ts',
  protocol: 'apps/api/src/moderation/commercial/commercial-llm-enforcement.protocol.ts',
  ai: 'apps/api/src/moderation/commercial/commercial-llm-delete-guard.service.ts',
  origin: 'apps/api/src/moderation/commercial/commercial-llm-effect-origin.ts',
};

function replaceChecked(source, before, after) {
  if (typeof before === 'string') assert.ok(source.includes(before), `Missing anchor: ${before}`);
  else assert.match(source, before);
  const changed = source.replace(before, after);
  assert.notEqual(changed, source, `Unchanged mutation: ${before}`);
  return changed;
}

function changeReasons(change) {
  const source = readFileSync(resolve(root, paths.executor), 'utf8');
  const marker = 'private async authorizeGuardedUserDeleteReasons(';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n  private ', start + 1);
  assert.ok(start >= 0 && end > start);
  assert.equal(source.indexOf(marker, start + marker.length), -1);
  const body = source.slice(start, end);
  const changed = change(body);
  assert.notEqual(changed, body);
  return source.slice(0, start) + changed + source.slice(end);
}

function probe(t, mode, ai = false, pool = false, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-commercial-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const changes = {
    unwired: ['executor', 'commercialDeleteGuard', 'removedGuard'],
    'old-authority': ['commercial', 'assertAuthority', 'removedAuthority'],
    'old-binding': ['binding', 'BINDING_VERSION = 2', 'BINDING_VERSION = 1'],
    'ai-unwired': ['executor', 'commercialLlmGuard', 'removedGuard'],
    'ai-no-proof': ['ai', 'hasProof', 'removedProof'],
    'pool-no-v2': ['protocol', 'commercial-pool-v2', 'removed-pool-reader'],
    'pool-no-v1': ['protocol', 'legacyCommercialLlmSourceSchema', 'removedLegacyReader'],
  };
  if (mode in changes) {
    const [key, before, after] = changes[mode];
    const source = readFileSync(resolve(root, paths[key]), 'utf8');
    assert.ok(source.includes(before), `Missing anchor: ${before}`);
    overrides = { ...overrides, [key]: source.replaceAll(before, after) };
    assert.notEqual(overrides[key], source);
  }
  for (const [key, path] of Object.entries(paths)) {
    if (
      mode === 'missing' ||
      (mode === 'ai-no-origin' && key === 'origin') ||
      overrides[key] === null
    )
      continue;
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, overrides[key] ?? readFileSync(resolve(root, path), 'utf8'));
  }
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$1" != show || "$2" != target:* ]]; then return 1; fi
      cat "$MAXIM_TEST_SOURCE_ROOT/\${2#*:}"
    }
    ${pool ? 'maxim_topology_require_commercial_ai_pool_delete_reader' : ai ? 'maxim_topology_require_commercial_ai_delete_guard' : 'maxim_topology_require_commercial_text_delete_guard'} target
  `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MAXIM_TEST_ROOT: root,
        MAXIM_TEST_SOURCE_ROOT: directory,
        COMMERCIAL_LLM_POOL_ENABLED: 'false',
      },
      encoding: 'utf8',
    },
  );
}
test('both API rollback paths require commercial binding and final dispatch guard', (t) => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_text_delete_guard/u,
    );
  const current = probe(t, 'current');
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['missing', 'unwired', 'old-authority', 'old-binding'])
    assert.equal(probe(t, mode).status, 1);
});

test('AI rollback floor retains fresh proof, original source and final dispatch wiring', (t) => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_ai_delete_guard/u,
    );
  const current = probe(t, 'current', true);
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['missing', 'ai-unwired', 'ai-no-proof', 'ai-no-origin'])
    assert.equal(probe(t, mode, true).status, 1);
});

test('both rollback paths and tooling bootstrap retain v1/v2 pool readers with routing disabled', (t) => {
  for (const file of ['vps-release-rollback.sh', 'vps-runtime-rollback.sh'])
    assert.match(
      readFileSync(resolve(root, 'infra/scripts', file), 'utf8'),
      /maxim_topology_require_commercial_ai_pool_delete_reader/u,
    );
  assert.match(
    readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8'),
    /maxim_topology_require_local_chat_ban_reader/u,
  );
  const current = probe(t, 'current', true, true);
  assert.equal(current.status, 0, current.stderr);
  for (const mode of ['pool-no-v2', 'pool-no-v1', 'ai-no-proof', 'ai-unwired'])
    assert.equal(probe(t, mode, true, true).status, 1);
});

for (const [name, before, after] of [
  [
    'independent accumulator initialization',
    'let independentDeadline = 0;',
    'let independentDeadline = Infinity;',
  ],
  [
    'independent deadline aggregation',
    'independentDeadline = Math.max(independentDeadline, deadline)',
    'independentDeadline = deadline',
  ],
  [
    'returned independent deadline',
    'independentAuthorityDeadlineAtMs: unboundedIndependent ? null : independentDeadline || null,',
    'independentAuthorityDeadlineAtMs: null,',
  ],
  [
    'original key restriction',
    'preparedKeys.filter((key) => candidate.authoritySnapshot!.keys.includes(key))',
    'preparedKeys',
  ],
  [
    'original receipt deadlines',
    'for (const permit of candidate.authoritySnapshot?.deadlines ?? [])',
    'for (const permit of [])',
  ],
  [
    'original deadline ceiling',
    'deadline = Math.min(deadline ?? Infinity, candidate.authoritySnapshot.deadlineAtMs)',
    'deadline = Math.max(deadline ?? Infinity, candidate.authoritySnapshot.deadlineAtMs)',
  ],
  [
    'current-only fallback deadline',
    'deadline = Math.min(deadline ?? Infinity, candidate.authoritySnapshot.deadlineAtMs)',
    'deadline = deadline',
  ],
  [
    'receipt intersection ceiling',
    'Math.min(boundedDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs)',
    'Math.max(boundedDeadlines.get(permit.reasonKey) ?? 0, permit.deadlineAtMs)',
  ],
  [
    'per-reason deadline aggregation',
    'Math.min(\n                verifiedReasonDeadlines.get(permit.reasonKey) ?? Infinity,\n                permit.deadlineAtMs,\n              )',
    'permit.deadlineAtMs',
  ],
  [
    'returned reason deadlines',
    'verifiedReasonDeadlines: [...verifiedReasonDeadlines].map(([reasonKey, deadlineAtMs]) => ({',
    'discardedReasonDeadlines: [...verifiedReasonDeadlines].map(([reasonKey, deadlineAtMs]) => ({',
  ],
  [
    'original capsule recheck',
    'preparation: prepareDeleteAuthorityRecheck(candidate.preparation)',
    'preparation: candidate.preparation',
  ],
  [
    'fallback snapshot',
    'authoritySnapshot: { keys, deadlineAtMs: deadline, deadlines: permits }',
    'authoritySnapshot: { keys, deadlineAtMs: null, deadlines: [] }',
  ],
  ['AI authorize wiring', 'this.commercialLlmGuard!.authorize(', 'this.unrelatedGuard!.authorize('],
]) {
  for (const pool of [false, true]) {
    test(`${pool ? 'pool' : 'AI'} floor rejects prepared ${name} with routing disabled`, (t) => {
      const executor = changeReasons((body) => replaceChecked(body, before, after));
      const result = probe(t, 'current', true, pool, { executor });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /commercial AI source\/proof\/deadline guard/u);
    });
  }
}

test('rejects a missing independent deadline return hidden by an out-of-scope marker', (t) => {
  const executor =
    changeReasons((body) =>
      replaceChecked(
        body,
        'independentAuthorityDeadlineAtMs: unboundedIndependent ? null : independentDeadline || null,',
        'independentAuthorityDeadlineAtMs: null,',
      ),
    ) +
    '\n// independentAuthorityDeadlineAtMs: unboundedIndependent ? null : independentDeadline || null,\n';
  assert.equal(probe(t, 'current', true, false, { executor }).status, 1);
});

// A bounded legacy deadline-flow specimen retains the direct authorization and
// original per-reason permits without relying on Git history in shallow CI clones.
const legacyAiReasons = `private async authorizeGuardedUserDeleteReasons(intent, botId) {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: intent.id },
    });
    if (!reasons.length) throw new ModerationDeleteReasonMissingError();
    const params = { intentId: intent.id, chatId: intent.chatId,
      messageId: intent.messageId, subjectUserId: intent.subjectUserId, botId,
      ownedReasonsOnly: true, sourceMessageAt: intent.sourceMessageAt };
    let independentBoundedDeadlineAtMs = 0;
    let unboundedAuthority = false;
    const verifiedReasonKeys = [];
    const verifiedReasonDeadlines = new Map();
    const check = async (run, keys = []) => {
      const result = await run();
      if (result === 'absent') throw new ModerationDeleteGuardedMessageAbsentError();
      if (result !== 'allowed' && (typeof result !== 'object' || result === null))
        throw new Error('Required moderation reason guard did not supply authority');
      if (result === 'allowed') unboundedAuthority = true;
      const resultKeys = typeof result === 'object' ? result.reasonKeys ?? keys : keys;
      verifiedReasonKeys.push(...resultKeys);
      const deadlines = typeof result === 'object' ? result.reasonDeadlines ??
        resultKeys.map((reasonKey) => ({ reasonKey, deadlineAtMs: Number(result.deadlineAtMs) })) : [];
      for (const permit of deadlines) {
        if (!resultKeys.includes(permit.reasonKey) || !Number.isSafeInteger(permit.deadlineAtMs) || permit.deadlineAtMs <= 0)
          throw new Error('Verified moderation reason lost its exact deadline permit');
        verifiedReasonDeadlines.set(permit.reasonKey,
          Math.min(verifiedReasonDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs));
      }
      return result;
    };
    if (reasons.some((reason) => reason.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE)) {
      if (!this.commercialLlmGuard) throw new Error('Commercial AI guard unavailable');
      const permit = await check(() => this.commercialLlmGuard!.authorize({ ...params, reasons }));
      if (typeof permit === 'object' && permit !== null && 'deadlineAtMs' in permit)
        independentBoundedDeadlineAtMs = Math.max(independentBoundedDeadlineAtMs, Number(permit.deadlineAtMs));
    }
    const independentWithoutShortDeadline = unboundedAuthority;
    return { verifiedReasonKeys,
      independentAuthorityDeadlineAtMs: independentWithoutShortDeadline ? null : independentBoundedDeadlineAtMs || null,
      verifiedReasonDeadlines: [...verifiedReasonDeadlines].map(([reasonKey, deadlineAtMs]) => ({ reasonKey, deadlineAtMs })),
    };
  }
`;

test('retains the legacy direct AI deadline accumulator with routing disabled', (t) => {
  const executor = changeReasons(() => legacyAiReasons);
  for (const pool of [false, true]) {
    const result = probe(t, 'current', true, pool, { executor });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('follows renamed legacy and prepared deadline accumulators through their returned permit', (t) => {
  const current = changeReasons((body) => {
    assert.ok(body.includes('independentDeadline'));
    return body.replaceAll('independentDeadline', 'preparedDeadlineLimit');
  });
  const legacy = changeReasons(() =>
    replaceChecked(legacyAiReasons, /independentBoundedDeadlineAtMs/gu, 'legacyDeadlineLimit'),
  );
  for (const executor of [current, legacy]) {
    const result = probe(t, 'current', true, false, { executor });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('rejects a legacy deadline name without its returned authorization flow', (t) => {
  const executor = changeReasons(() =>
    replaceChecked(
      legacyAiReasons,
      'independentAuthorityDeadlineAtMs: independentWithoutShortDeadline ? null : independentBoundedDeadlineAtMs || null,',
      'independentAuthorityDeadlineAtMs: null,',
    ),
  );
  assert.equal(probe(t, 'current', true, false, { executor }).status, 1);
});

test('rejects a legacy AI accumulator disconnected from its authorized permit deadline', (t) => {
  const executor = changeReasons(() =>
    replaceChecked(
      legacyAiReasons,
      'independentBoundedDeadlineAtMs = Math.max(independentBoundedDeadlineAtMs, Number(permit.deadlineAtMs));',
      'independentBoundedDeadlineAtMs = Math.max(0, 0);',
    ),
  );
  for (const pool of [false, true]) {
    const result = probe(t, 'current', true, pool, { executor });
    assert.equal(result.status, 1, result.stderr);
  }
});
