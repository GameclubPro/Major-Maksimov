import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const protectedSources = [
  ['apps/api/src/moderation/voice-webhook-source.ts', "input.kind === 'invalidate'"],
  ['apps/api/src/moderation/voice-webhook-source.ts', 'VOICE_SOURCE_LIFETIME_MS = 5 * 60_000'],
  ['apps/api/src/moderation/message-limits-delete-guard.service.ts', 'source.invalidatedAt'],
  ['apps/api/src/moderation/message-limits-delete-guard.service.ts', 'voiceSourcePolicySha256'],
  [
    'apps/api/src/webhook/webhook.service.ts',
    'await persistVoiceSource(tx, voiceSourceInput, webhookEventId)',
  ],
  ['apps/api/src/max/max-action-ledger.service.ts', 'pg_advisory_xact_lock'],
  [
    'apps/api/src/max/max-action-ledger.service.ts',
    `AND "action_type" IN ('BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER')`,
  ],
  ['apps/api/src/max/max-action-ledger.service.ts', "${job.actionType !== 'TRY_UNBAN_MEMBER'}"],
  [
    'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    'mayHaveStarted && AMBIGUOUS_CAPABLE_ACTION_TYPES.has(row.actionType)',
  ],
  ['apps/api/src/admin/manual-member-unban-attempt.ts', 'await beforeFinalAuthority?.()'],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    'closedChatDeleteGuard!.authorize',
  ],
  [
    'apps/api/src/moderation/moderation.service.legacy.ts',
    'moderationRuleSanctionGuard!.assertAllowed',
  ],
  ['apps/api/src/moderation/moderation-execution-guard-callbacks.ts', 'botId: readSelectedBotId()'],
  [
    'apps/api/src/moderation/moderation-rule-sanction-authority.ts',
    'metadata.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/moderation/moderation-rule-sanction-authority.ts',
    'await dependencies.assertFinalOwnership?.()',
  ],
  [
    'apps/api/src/max/max-moderation-rule-notice.guard.ts',
    'assertModerationRuleSanctionAuthority(this.prisma, proof',
  ],
  ['apps/api/src/max/max-client.service.ts', 'this.moderationRuleNoticeGuard.assertAllowed('],
  ['apps/api/src/max/max.module.ts', '  MaxModerationRuleNoticeGuardService,'],
  [
    'apps/api/src/max/max-required-subscription-notice.guard.ts',
    'assertRequiredSubscriptionNoticeAuthority(this.prisma, proof',
  ],
  [
    'apps/api/src/moderation/required-subscription-notice-authority.ts',
    'binding.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/moderation/required-subscription-notice-plan.ts',
    'executionProof: params.executionProof',
  ],
  [
    'apps/api/src/moderation/moderation-state-delete-guard.service.ts',
    'intentId_reasonKey: { intentId: intent.id, reasonKey }',
  ],
  ['apps/api/src/max/max-duplicate-notice.guard.ts', 'notice: proof,'],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-notice-proof.ts',
    'deadlineAtMs <= binding.authorization.deadlineAtMs',
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
    'receiptMetadata?.moderationDeleteVerified !== true',
  ],
  [
    'apps/api/src/max/max-moderation-notice-envelope.ts',
    'moderation_notice_legacy_envelope_unverified',
  ],
  [
    'apps/api/src/admin/publication-execution-safety.ts',
    'reviseUnstartedPublicationExecutionBroadcasts',
  ],
  ['apps/api/src/admin/admin-managed-broadcast-ledger-recovery.ts', 'delivery.contentRevisionId'],
  [
    'apps/api/src/publisher/publisher-video-upload.processor.ts',
    'assertPublisherIdentityOrDelay(this.identity, job, token)',
  ],
  ['apps/api/src/admin/vk-sync-lease.ts', 'FOR UPDATE OF source'],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'completeSent(delivery, dispatchStartedAt, sent.messageId)',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'assertFinalAutoReplyEpochAndBinding',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'publisher_auto_reply_send_fence_lock',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'publisher_auto_reply_send_fence_cas',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'publisher_auto_reply_send_fence_cooldown',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'admitted."dispatchStartedAt" +',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'OR EXISTS (SELECT 1 FROM cooldown)',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    '"publisher_auto_reply_cooldowns"."next_allowed_at" <= (clock_timestamp() AT TIME ZONE',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'binding."bot_access_state"::text = ${binding.botAccessState}',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'binding."bot_access_checked_at" <= clock."now"',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'rule."version" = delivery."matched_rule_version"',
  ],
  [
    'apps/api/src/publisher/publisher-auto-reply-delivery.service.ts',
    'settings."auto_reply_config_revision" = delivery."auto_reply_config_revision"',
  ],
  ['apps/api/src/admin/admin-chat-settings.ts', "'nightModeStartTimeMinutes',"],
  [
    'apps/api/src/moderation/moderation-rule-followup-persistence.ts',
    'intent."delete_dispatch_started_at" IS NULL',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup.service.ts',
    'moderationViolationMessageClaim.create',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup-sanction.ts',
    'dependencies.recoverBanReceipt(actionKey)',
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup-execution.ts',
    'host.applyRuleFollowupSanction',
  ],
  ['apps/api/src/moderation/moderation.module.ts', 'useExisting: ModerationService'],
  [
    'apps/api/src/moderation/commercial/commercial-delete-guard.service.ts',
    'this.issuedPermits.get(permit)',
  ],
  [
    'apps/api/src/moderation/moderation-sanction-notice-delivery.ts',
    '...input.noticeDispatchOptions',
  ],
  ['apps/api/src/common/group-command-notice-delivery.ts', 'await revalidateRoute?.()'],
  [
    'apps/api/src/admin/admin-manual-command.queue.ts',
    "export const ADMIN_MANUAL_COMMAND_QUEUE = 'admin-manual-commands';",
  ],
  [
    'apps/api/src/admin/admin-manual-command.processor.ts',
    'await this.manualModerationService.processManualModerationFanoutJob(job.data);',
  ],
  ['apps/api/src/admin/admin-manual-fanout.queue.ts', '| AdminManualGroupModerationCommandJob;'],
  [
    'apps/api/src/admin/admin-manual-fanout.processor.ts',
    'await this.manualModerationService.processManualModerationFanoutJob(job.data);',
  ],
  [
    'apps/api/src/admin/admin.module.ts',
    '...(roleRunsAction(getAppRole()) ? [AdminManualCommandProcessor] : [])',
  ],
  [
    'apps/api/src/admin/admin-manual-moderation-runtime.ts',
    'this.context.assertManualGroupCommandSuccessNoticeAuthority(',
  ],
  [
    'apps/api/src/admin/admin-manual-group-command-notice-authority.ts',
    'notice.lockToken !== input.lockToken',
  ],
  [
    'apps/api/src/moderation/night-mode-transition-delivery.service.ts',
    'await revalidateRoute?.()',
  ],
  ['apps/api/src/scripts/legacy-recovery-live-registry.ts', "'admin-manual-commands',"],
  [
    'infra/scripts/source-abandonment-session-queues.cjs',
    'function isSupportedSourceAbandonmentQueueInventory(queueNames)',
  ],
  [
    'infra/scripts/source-abandonment-session-host.mjs',
    'isSupportedSourceAbandonmentQueueInventory(queueNames),',
  ],
  [
    'infra/scripts/source-abandonment-session-inventory.mjs',
    'isSupportedSourceAbandonmentQueueInventory(queueNames),',
  ],
  [
    'infra/scripts/source-abandonment-session-protocol.mjs',
    'value.queueCount === value.queues.length',
  ],
  [
    'infra/scripts/source-abandonment-session-journal.mjs',
    'baseline.queueCount === baseline.queues.length',
  ],
];

const mutateNamedActionSet = (source, name, mutateMembers) => {
  const declaration = new RegExp(
    `(const\\s+${name}\\b[^=;]*=\\s*new Set\\(\\s*\\[)([^\\]]*)(\\]\\s*\\))`,
    'u',
  );
  assert.match(source, declaration, `Fixture action set missing: ${name}`);
  return source.replace(
    declaration,
    (_, prefix, members, suffix) => `${prefix}${mutateMembers(members)}${suffix}`,
  );
};

const unbanAttemptMutations = [
  ...[
    ['apps/api/src/max/max-action-ledger.service.ts', 'IRREVERSIBLE_ACTION_TYPES'],
    ['apps/api/src/max/max-action-ledger.service.ts', 'CRASH_FENCED_MEMBER_ACTION_TYPES'],
    ['apps/api/src/system/max-action-ledger-watchdog.service.ts', 'AMBIGUOUS_CAPABLE_ACTION_TYPES'],
  ].map(([path, name]) => ({
    path,
    name: `unban attempt removed only from ${name}`,
    mutate: (source) => {
      const changed = mutateNamedActionSet(source, name, (members) =>
        members.replace("'TRY_UNBAN_MEMBER',", ''),
      );
      // Keep an unrelated marker so a whole-file presence check cannot certify this set.
      return `${changed}\nconst unrelatedUnbanAttempt = 'TRY_UNBAN_MEMBER';\n`;
    },
  })),
  {
    path: 'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    name: 'unban attempt admitted to background recovery without a live guard',
    mutate: (source) =>
      mutateNamedActionSet(
        source,
        'RECOVERABLE_MEMBER_ACTION_TYPES',
        (members) => `'TRY_UNBAN_MEMBER', ${members}`,
      ),
  },
  {
    path: 'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    name: 'recoverable member classifier missing',
    mutate: (source) =>
      source.replaceAll(
        'RECOVERABLE_MEMBER_ACTION_TYPES',
        'LEGACY_RECOVERABLE_MEMBER_ACTION_TYPES',
      ),
  },
  {
    path: 'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    name: 'double-quoted unban attempt admitted to background recovery',
    mutate: (source) =>
      mutateNamedActionSet(
        source,
        'RECOVERABLE_MEMBER_ACTION_TYPES',
        (members) => `"TRY_UNBAN_MEMBER", ${members}`,
      ),
  },
  {
    path: 'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    name: 'unknown member outcome loses ambiguity while other branches retain it',
    mutate: (source) =>
      source.replace(
        /(if \(mayHaveStarted && AMBIGUOUS_CAPABLE_ACTION_TYPES\.has\(row\.actionType\)\) \{\s*await this\.applyOutcome\(row, MaxActionLedgerStatus\.AMBIGUOUS, summary, \{\s*)ambiguous: true,/u,
        '$1ambiguous: false,',
      ),
  },
  {
    path: 'apps/api/src/system/max-action-ledger-watchdog.service.ts',
    name: 'unknown member branch falls through while later send branch still quarantines',
    mutate: (source) =>
      source.replace(
        /(if \(mayHaveStarted && AMBIGUOUS_CAPABLE_ACTION_TYPES\.has\(row\.actionType\)\) \{[\s\S]*?\}\);)\s*return;/u,
        '$1',
      ),
  },
  {
    path: 'apps/api/src/admin/manual-member-unban-attempt.ts',
    name: 'transport checkpoint runs before the final target lookup',
    mutate: (source) =>
      source
        .replace('      await beforeFinalAuthority?.();', '')
        .replace(
          '      if (await readTargetAccess())',
          '      await beforeFinalAuthority?.();\n      if (await readTargetAccess())',
        ),
  },
  {
    path: 'apps/api/src/admin/manual-member-unban-attempt.ts',
    name: 'target lookup can outlive the transport checkpoint',
    mutate: (source) =>
      source.replace(
        '      await beforeFinalAuthority?.();',
        '      await beforeFinalAuthority?.();\n      await readTargetAccess();',
      ),
  },
  {
    path: 'apps/api/src/admin/manual-member-unban-attempt.ts',
    name: 'sanction state is checked before the transport wait',
    mutate: (source) =>
      source.replace(
        /( {6}await beforeFinalAuthority\?\.\(\);\n)( {6}await assertSanctionState\(\{[\s\S]*?\n {6}\}\);\n)/u,
        '$2$1',
      ),
  },
  {
    path: 'apps/api/src/admin/manual-member-unban-attempt.ts',
    name: 'final lease is checked before the transport wait',
    mutate: (source) =>
      source.replace(
        /( {6}await beforeFinalAuthority\?\.\(\);\n)( {6}await assertSanctionState\(\{[\s\S]*?\n {6}\}\);\n)( {6}await leaseGuard\.assertOwned\(\);\n)/u,
        '$3$1$2',
      ),
  },
  {
    path: 'apps/api/src/admin/manual-member-unban-attempt.ts',
    name: 'remote read follows the final sanction and lease permit',
    mutate: (source) =>
      source.replace(
        '      await leaseGuard.assertOwned();\n    }),',
        '      await leaseGuard.assertOwned();\n      await readTargetAccess();\n    }),',
      ),
  },
];

const manualReaderMutations = [
  {
    path: 'apps/api/src/admin/admin-manual-fanout.processor.ts',
    name: 'legacy processor queue import points at the dedicated namespace module',
    mutate: (source) =>
      source.replace("from './admin-manual-fanout.queue'", "from './admin-manual-command.queue'"),
  },
  {
    path: 'apps/api/src/admin/admin-manual-moderation-runtime.ts',
    name: 'legacy reader loses the command executor branch but retains its payload and notice markers',
    mutate: (source) =>
      source.replace(
        /if \(job\.kind === 'manual_group_moderation_command'\) \{\s*await this\.processManualGroupModerationCommandJob\(job\);\s*return;\s*\}/u,
        '',
      ),
  },
  {
    path: 'apps/api/src/admin/admin-manual-command.processor.ts',
    name: 'new command processor listens to the legacy namespace',
    mutate: (source) =>
      source.replace(
        '@Processor(ADMIN_MANUAL_COMMAND_QUEUE,',
        '@Processor(ADMIN_MANUAL_FANOUT_QUEUE,',
      ),
  },
  ...['command', 'fanout'].map((kind) => ({
    path: `apps/api/src/admin/admin-manual-${kind}.processor.ts`,
    name: `${kind} processor exceeds the shared manual concurrency cap`,
    mutate: (source) => source.replace('concurrency: 1,', 'concurrency: 2,'),
  })),
  {
    path: 'apps/api/src/admin/admin-manual-command.processor.ts',
    name: 'command handler call survives only in a comment',
    mutate: (source) =>
      source.replace(
        'await this.manualModerationService.processManualModerationFanoutJob(job.data);',
        'return; // await this.manualModerationService.processManualModerationFanoutJob(job.data);',
      ),
  },
  {
    path: 'apps/api/src/admin/admin-manual-command.processor.ts',
    name: 'command processor rejects the persisted command kind',
    mutate: (source) =>
      source.replace(
        "job.data.kind !== 'manual_group_moderation_command'",
        "job.data.kind !== 'manual_ban_fanout'",
      ),
  },
  {
    path: 'apps/api/src/admin/admin-manual-fanout.processor.ts',
    name: 'legacy reader silently drops retained group commands',
    mutate: (source) =>
      source.replace(
        'await this.manualModerationService.processManualModerationFanoutJob(job.data);',
        "if (job.data.kind === 'manual_group_moderation_command') return;\n    await this.manualModerationService.processManualModerationFanoutJob(job.data);",
      ),
  },
  ...['COMMAND', 'FANOUT'].map((kind) => ({
    path: 'apps/api/src/admin/admin.module.ts',
    name: `${kind} queue registration is missing despite retained imports`,
    mutate: (source) => source.replace(`...registerRuntimeQueues(ADMIN_MANUAL_${kind}_QUEUE),`, ''),
  })),
  {
    path: 'apps/api/src/admin/admin.module.ts',
    name: 'legacy processor is imported but not registered in action',
    mutate: (source) =>
      source.replace('...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),', ''),
  },
];

test('both API rollback paths retain shared member and immutable Publisher effect protections', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'maxim-bot-publisher-rollback-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'protected executor fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const check = (sha) =>
    spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; maxim_topology_require_bot_publisher_reliability "$2"',
        'reliability-test',
        resolve(root, 'infra/scripts/lib/deploy-topology.sh'),
        sha,
      ],
      { cwd: fixture, encoding: 'utf8' },
    );
  try {
    git('init', '-q');
    for (const [path] of protectedSources) {
      mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
      writeFileSync(resolve(fixture, path), readFileSync(resolve(root, path)));
    }
    const positive = check(commit());
    assert.equal(positive.status, 0, positive.stderr);
    const unbanPath = 'apps/api/src/admin/manual-member-unban-attempt.ts';
    const unban = readFileSync(resolve(root, unbanPath), 'utf8');
    const markedUnban =
      /beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint\(async \(beforeFinalAuthority\) => \{[\s\S]*?\n {4}\}\),/u;
    assert.match(unban, markedUnban);
    const legacyUnban = unban.replace(
      markedUnban,
      `beforeImmediateMemberMutation: async (revalidateRoute) => {
      await leaseGuard.assertOwned();
      await assertSanctionState({
        chatId,
        targetUserId,
        releaseAction: 'UNBAN',
        expectedSanctionEventId,
      });
      if (await readTargetAccess()) throw new ModerationSanctionStateChangedError();
      await leaseGuard.assertOwned();
      await revalidateRoute?.();
    },`,
    );
    writeFileSync(resolve(fixture, unbanPath), legacyUnban);
    const legacy = check(commit());
    assert.equal(legacy.status, 0, legacy.stderr);
    writeFileSync(
      resolve(fixture, unbanPath),
      legacyUnban.replace(
        '      await revalidateRoute?.();',
        '      await revalidateRoute?.();\n      await readTargetAccess();',
      ),
    );
    assert.equal(check(commit()).status, 1, 'Legacy routing must remain the last awaited proof');
    writeFileSync(resolve(fixture, unbanPath), unban);
    for (const [path, guard] of protectedSources) {
      const source = readFileSync(resolve(root, path), 'utf8');
      assert.ok(source.includes(guard), `Fixture guard missing: ${guard}`);
      writeFileSync(resolve(fixture, path), source.replaceAll(guard, 'unsafe_legacy_executor'));
      assert.equal(check(commit()).status, 1, `Rollback erased ${guard}`);
      writeFileSync(resolve(fixture, path), source);
    }
    for (const { path, name, mutate } of [...unbanAttemptMutations, ...manualReaderMutations]) {
      const source = readFileSync(resolve(root, path), 'utf8');
      const changed = mutate(source);
      assert.notEqual(changed, source, `Fixture mutation had no effect: ${name}`);
      writeFileSync(resolve(fixture, path), changed);
      assert.equal(check(commit()).status, 1, `Rollback accepted ${name}`);
      writeFileSync(resolve(fixture, path), source);
    }
    for (const path of [
      'infra/scripts/vps-runtime-rollback.sh',
      'infra/scripts/vps-release-rollback.sh',
    ])
      assert.match(
        readFileSync(resolve(root, path), 'utf8'),
        /maxim_topology_require_bot_publisher_reliability/u,
      );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
