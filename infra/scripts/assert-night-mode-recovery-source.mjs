import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const executable = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--|#).*$/gmu, '')
    .replace(/\s+/gu, '');

// FLAG: Independent event and cleanup obligations outlive workers and Redis jobs.
// A rollback must retain their SQL readers and final opening-cleanup policy guards even
// when night-mode notices or automatic opening-message deletion are disabled.
export const NIGHT_MODE_RECOVERY_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/moderation/night-mode-transition.queue.ts',
    [
      'NIGHT_MODE_INDEPENDENT_RECOVERY_READER_VERSION = 2',
      "'open_notice_event'",
      "'close_notice_cleanup'",
      'parseNightModeTransitionRecoveryObligation',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-recovery-time-compat.util.ts',
    ['matchesNightModeRecoveryBoundaryTime', 'resolveNightModeLegacyRecoveryTime'],
  ],
  [
    'apps/api/src/moderation/night-mode-calendar.util.ts',
    ['resolveNightModeCalendar', 'NIGHT_MODE_CALENDAR_CACHE_LIMIT'],
  ],
  ['apps/api/prisma/schema.prisma', ['recoveryPayload', '@map("recovery_payload")']],
  [
    'apps/api/src/moderation/night-mode-transition-scheduler.service.ts',
    [
      'recovery_payload',
      'async scheduleRecoveryObligation(',
      'async restoreRecoveryObligations(',
      'parseNightModeTransitionRecoveryObligation',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-transition-runtime.service.ts',
    [
      'NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY',
      'NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY',
      'processCloseCleanupRecoveryOnly(',
      'hooks.recoverOpenedNoticeEvent(',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-transition-delivery.service.ts',
    ['inspectCompletedNightModeOpenNoticeDispatch', 'ensureTransitionEvent('],
  ],
  [
    'apps/api/src/max/max-action-ledger.service.ts',
    [
      'async inspectCompletedNightModeOpenNoticeDispatch(',
      "this.inspectCompletedNightModeNoticeDispatch('open', params)",
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-open-notice-cleanup-binding.ts',
    [
      "NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE = 'NIGHT_MODE_OPEN_NOTICE_CLEANUP'",
      'parseNightModeOpenNoticeCleanupBinding(',
      '!settings.nightModeOpenMessageDeleteOnFirstMessageEnabled',
      'resolveManualChatClosure(settings, now).active',
      'triggerAt <= completedAt',
    ],
  ],
  [
    'apps/api/src/moderation/night-mode-open-notice-cleanup-guard.service.ts',
    [
      'class NightModeOpenNoticeCleanupGuardService',
      'async assertAllowed(',
      "intent.routingPolicy !== 'origin_only'",
      'intent.originBotId !== binding.botId',
      'resolveNightModeOpenNoticeCleanupSession(settings, now) !== binding.sessionKey',
      'proof.completedAt.toISOString() !== binding.sendCompletedAt',
      "ruleCode: 'NIGHT_MODE_OPEN_NOTICE'",
      'if (!event) throw new NightModeOpenNoticeCleanupRejectedError()',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    [
      'await this.assertNightModeOpenNoticeCleanupStillAuthorized(intent);',
      'private async assertNightModeOpenNoticeCleanupStillAuthorized(',
      'new NightModeOpenNoticeCleanupGuardService(this.prisma).assertAllowed(',
      'AS "nightModeOpenNoticeCleanupReason"',
      'AS "nightModeOpenNoticeCleanupOnly"',
      'AS "nightModeOpenNoticeCleanupBinding"',
    ],
  ],
  [
    'infra/scripts/lib/deploy-topology.sh',
    [
      'maxim_topology_require_night_open_notice_cleanup_reader() {',
      'maxim_topology_require_night_mode_recovery_reader "$commit_sha"',
    ],
  ],
  [
    'infra/scripts/vps-runtime-rollback.sh',
    ['maxim_topology_require_night_open_notice_cleanup_reader "$TARGET_FULL_SHA"'],
  ],
  [
    'infra/scripts/vps-release-rollback.sh',
    ['maxim_topology_require_night_open_notice_cleanup_reader "$API_SOURCE_SHA"'],
  ],
  [
    'infra/scripts/vps-connect.sh',
    [
      'if [[ "$capability_marker" == maxim_topology_require_local_chat_ban_reader ]]; then',
      'capability_marker=maxim_topology_require_night_open_notice_cleanup_reader',
    ],
  ],
]);

export function assertNightModeRecoverySource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: MAX_SOURCE_BYTES,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  const sources = new Map();
  for (const [path, markers] of NIGHT_MODE_RECOVERY_SOURCE_CHECKS) {
    let source;
    try {
      source = readSource(path);
    } catch {
      throw new Error(`Rollback target lacks independent night-mode recovery readers: ${path}`);
    }
    if (
      typeof source !== 'string' ||
      Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES ||
      markers.some((marker) => !executable(source).includes(executable(marker)))
    ) {
      throw new Error(`Rollback target lacks independent night-mode recovery readers: ${path}`);
    }
    sources.set(path, source);
  }
  const deleteSource = sources.get('apps/api/src/moderation/moderation-delete-intent.service.ts');
  const dispatchStart = deleteSource.indexOf('private async runDeletePreDispatchGuards(');
  const dispatchEnd = deleteSource.indexOf(
    'private async assertVerifiedReasonDeadlineFence(',
    dispatchStart,
  );
  const dispatch = executable(deleteSource.slice(dispatchStart, dispatchEnd));
  if (
    dispatchStart < 0 ||
    dispatchEnd <= dispatchStart ||
    dispatch.split('awaitthis.assertNightModeOpenNoticeCleanupStillAuthorized(intent);').length -
      1 <
      2
  )
    throw new Error(
      'Rollback target lacks independent night-mode recovery readers: final cleanup checkpoints',
    );

  const connector = sources.get('infra/scripts/vps-connect.sh');
  const start = connector.indexOf('build_guarded_rollback_command() {');
  const end = connector.indexOf('\n}\n', start);
  const builder = executable(connector.slice(start, end));
  const promotion = builder.indexOf(
    'if[["$capability_marker"==maxim_topology_require_local_chat_ban_reader]];then',
  );
  const assembly = builder.indexOf('printf-vcommand_ref');
  if (
    start < 0 ||
    end < start ||
    promotion < 0 ||
    assembly < promotion ||
    !builder
      .slice(assembly)
      .includes(
        executable(String.raw`"$entrypoint" \ "$capability_marker" \ "$(shell_quote_args "$@")"`),
      )
  )
    throw new Error(
      'Rollback target lacks independent night-mode recovery readers: API bootstrap promotion',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNightModeRecoverySource(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
