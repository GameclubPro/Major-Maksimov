import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_SOURCE_BYTES = 1024 * 1024;
const compact = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--|#).*$/gmu, '')
    .replace(/\s+/gu, '');

// FLAG: A LOCAL_REJOIN ban survives cache eviction and rollback. Both source-bound
// enforcement and local-only release must remain wired; a version marker is insufficient.
export const LOCAL_CHAT_BAN_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/moderation/local-chat-ban.ts',
    [
      'LOCAL_CHAT_BAN_READER_VERSION = 1',
      "LOCAL_CHAT_BAN_MODE = 'LOCAL_REJOIN'",
      'export async function readActiveLocalChatBan(',
      'export async function enforceLocalChatBan(',
      'metadata.mode !== LOCAL_CHAT_BAN_MODE',
      'context.sanctionLock.runExclusive(',
      'beforeImmediateMemberMutation:',
      'withMaxFinalAuthorityCheckpoint(',
    ],
  ],
  [
    'apps/api/src/admin/former-participant-moderation.ts',
    [
      'export async function applyFormerParticipantModeration(',
      'export async function readLocalChatBanForRelease(',
      'LOCAL_CHAT_BAN_MODE',
      'await transition.record(action,',
      'if (active?.id !== latest.id) throw new ModerationSanctionStateChangedError()',
    ],
  ],
  [
    'apps/api/src/admin/admin.service.legacy.ts',
    [
      'applyFormerParticipantModeration(',
      "return applyLocalBan('UNBAN')",
      'await readLocalChatBanForRelease(',
      'options.expectedSanctionEventId ?? localUnban.id',
      'await attemptManualMemberUnban(',
    ],
  ],
  [
    'apps/api/src/moderation/moderation.service.legacy.ts',
    ['private enforceLocalChatBanForUpdate(', 'return enforceLocalChatBan('],
  ],
  [
    'apps/api/src/moderation/sanction-history-retention.ts',
    [
      "event.action IN ('MUTE', 'BAN')",
      "later.action IN ('MUTE', 'BAN')",
      '(later.created_at, later.id) > (candidate.created_at, candidate.id)',
    ],
  ],
  [
    'infra/scripts/lib/deploy-topology.sh',
    [
      'maxim_topology_require_local_chat_ban_reader() {',
      '/../assert-local-chat-ban-source.mjs" "$commit_sha"',
    ],
  ],
  [
    'infra/scripts/vps-runtime-rollback.sh',
    [
      'maxim_topology_require_local_chat_ban_reader "$TARGET_FULL_SHA"',
      'maxim_topology_require_statistics_and_night_mode_recovery "$TARGET_FULL_SHA"',
    ],
  ],
  [
    'infra/scripts/vps-release-rollback.sh',
    [
      'maxim_topology_require_local_chat_ban_reader "$API_SOURCE_SHA"',
      'maxim_topology_require_statistics_and_night_mode_recovery "$API_SOURCE_SHA"',
    ],
  ],
  [
    'infra/scripts/vps-connect.sh',
    [
      './infra/scripts/vps-runtime-rollback.sh \\ maxim_topology_require_local_chat_ban_reader',
      'capability_marker=maxim_topology_require_local_chat_ban_reader',
    ],
  ],
]);

export function assertLocalChatBanSource(
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
  for (const [path, fragments] of LOCAL_CHAT_BAN_SOURCE_CHECKS) {
    let source;
    try {
      source = readSource(path);
    } catch {
      throw new Error(`Rollback target lacks local chat ban readers: ${path}`);
    }
    if (
      typeof source !== 'string' ||
      Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES ||
      fragments.some((fragment) => !compact(source).includes(compact(fragment)))
    ) {
      throw new Error(`Rollback target lacks local chat ban readers: ${path}`);
    }
    sources.set(path, compact(source));
  }
  const admin = sources.get('apps/api/src/admin/admin.service.legacy.ts');
  const start = admin.indexOf('privateasyncapplyManualModerationActionLocked(');
  const localRelease = admin.indexOf("returnapplyLocalBan('UNBAN')", start);
  const nativeRelease = admin.indexOf('awaitattemptManualMemberUnban(', start);
  if (start < 0 || localRelease < start || nativeRelease < localRelease) {
    throw new Error('Rollback target lacks local chat ban readers: local release order');
  }
  const moderation = sources.get('apps/api/src/moderation/moderation.service.legacy.ts');
  if (moderation.split('this.enforceLocalChatBanForUpdate(').length - 1 < 2) {
    throw new Error('Rollback target lacks local chat ban readers: join/message enforcement');
  }
  for (const [path, transition] of [
    ['infra/scripts/vps-runtime-rollback.sh', 'begin_runtime_rollback_transition'],
    ['infra/scripts/vps-release-rollback.sh', 'begin_release_runtime_transition'],
  ]) {
    const source = sources.get(path);
    const gate = source.indexOf('maxim_topology_require_local_chat_ban_reader');
    const begin = source.lastIndexOf(`${transition}ROLLBACK_RUNTIME_STARTED=1`);
    if (gate < 0 || begin < gate) {
      throw new Error(`Rollback target lacks local chat ban readers: pre-transition gate ${path}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertLocalChatBanSource(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
