import type { EnsureModerationDeleteIntentInput } from '../moderation/moderation-delete-intent.types';
import type { Prisma } from '../prisma/prisma-client';

export const REPAIR_DEFAULT_WINDOW_HOURS = 24;
export const REPAIR_MAX_WINDOW_HOURS = 7 * 24;
export const REPAIR_DEFAULT_GLOBAL_CAP = 500;
export const REPAIR_MAX_GLOBAL_CAP = 5_000;
export const REPAIR_DEFAULT_PER_CHAT_CAP = 25;
export const REPAIR_MAX_PER_CHAT_CAP = 250;
export const REPAIR_DEFAULT_BATCH_SIZE = 200;
export const REPAIR_MAX_BATCH_SIZE = 500;
export const REPAIR_MAX_SCAN_CAP = 50_000;
export const REPAIR_MISSED_DELETES_USAGE = [
  'Usage: npm run moderation:repair-missed-deletes -- [options]',
  '',
  'Options:',
  '  --chat-id <id[,id...]>  Limit both dry-run and execute to these chats; repeatable',
  '  --since <ISO-8601>       Start of the repair window',
  '  --until <ISO-8601>       End of the repair window (defaults to now)',
  '  --window-hours <hours>   Window ending at --until (defaults to 24, max 168)',
  '  --global-cap <count>     Maximum accepted messages (defaults to 500)',
  '  --per-chat-cap <count>   Maximum accepted messages per chat (defaults to 25)',
  '  --batch-size <count>     Read batch size (defaults to 200)',
  '  --scan-cap <count>       Maximum claim rows scanned (defaults to global cap x10)',
  '  --execute                Persist intents; requires APP_ROLE=admin and canary/on mode',
  '  --dry-run                Explicit read-only mode (also the default)',
  '  --help                   Show this usage',
].join('\n');
export const REPAIR_TERMINAL_INTENT_STATUSES = [
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
] as const;
export const SCHEDULED_BOT_DELETE_REASON = 'Bot-authored message scheduled for delayed auto-delete';

const COMMERCIAL_DELETE_ACTION_BANDS = new Set(['WARN', 'DELETE', 'DELETE_AND_ESCALATE']);

export const REPAIR_ORDINARY_DELETE_RULE_CODES = [
  'LINK_BLOCKED',
  'COMMERCIAL_AD',
  'PROFANITY',
  'MESSAGE_BLOCKED_WORD',
  'MESSAGE_BLOCKED_DOMAIN',
  'PHONE_NUMBER_BLOCKED',
  'MESSAGE_TOO_LONG',
  'MESSAGE_RATE_LIMIT',
  'MESSAGE_COUNT_LIMIT',
  'PHOTO_BLOCKED',
  'VIDEO_BLOCKED',
  'FILE_BLOCKED',
  'VOICE_BLOCKED',
  'FORWARDED_MESSAGE_BLOCKED',
  'PHOTO_RATE_LIMIT',
  'STICKER_RATE_LIMIT',
] as const;

export const REPAIR_MESSAGE_ACTION_DELETE_POLICIES = {
  DUPLICATE: { intentRuleCode: 'DUPLICATE_DELETE', family: 'duplicate' },
  DUPLICATE_HIT: { intentRuleCode: 'DUPLICATE_DELETE', family: 'duplicate_hit' },
  DUPLICATE_MESSAGE_ACTION: {
    intentRuleCode: 'DUPLICATE_DELETE',
    family: 'duplicate_message_action',
  },
  MUTE_ACTIVE_DELETE: { intentRuleCode: 'MUTE_ACTIVE_DELETE', family: 'active_mute' },
  BOT_ACCOUNT_KICK: {
    intentRuleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
    family: 'bot_account_message',
    evidence: 'bot_account_message',
    messageAuthorKind: 'bot',
  },
  BOT_MESSAGE_AUTO_DELETE: {
    intentRuleCode: 'BOT_MESSAGE_AUTO_DELETE',
    family: 'bot_message_auto_delete',
    evidence: 'bot_auto_delete',
    messageAuthorKind: 'bot',
  },
  NIGHT_MODE_DELETE: { intentRuleCode: 'NIGHT_MODE_DELETE', family: 'night_mode' },
  MANUAL_GROUP_CLOSE_DELETE: {
    intentRuleCode: 'MANUAL_GROUP_CLOSE_DELETE',
    family: 'manual_group_close',
  },
  REQUIRED_SUBSCRIPTION: {
    intentRuleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
    family: 'required_subscription',
  },
  INVITATION_ACCESS_REQUIRED: {
    intentRuleCode: 'INVITATION_ACCESS_REQUIRED_DELETE',
    family: 'invitation_access',
  },
  LOCAL_ADMIN_BLOCK: {
    intentRuleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
    family: 'local_admin_block_message',
    evidence: 'local_admin_block_message',
  },
  GLOBAL_SPAMMER_KICK: {
    intentRuleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
    family: 'global_spammer_message',
    evidence: 'global_spammer_message',
  },
} as const;

const ORDINARY_DELETE_RULE_CODE_SET = new Set<string>(REPAIR_ORDINARY_DELETE_RULE_CODES);
const BOT_ACCOUNT_MESSAGE_DELETE_REASON =
  'Bot account removed because bot accounts are disallowed by chat settings';
const LOCAL_ADMIN_BLOCK_MESSAGE_DELETE_REASON = 'Local admin block for this admin scope';
const GLOBAL_SPAMMER_MESSAGE_DELETE_REASONS = new Set([
  'Sender exists in global spammer registry',
  'Detected in 6 unique chats within 2 minutes',
]);

export type RepairCliOptions = {
  since: Date;
  until: Date;
  execute: boolean;
  help: boolean;
  chatIds: string[];
  globalCap: number;
  perChatCap: number;
  batchSize: number;
  scanCap: number;
};

export type RepairBootstrapMode = 'direct_prisma_read_only' | 'admin_app_context';

export function resolveRepairBootstrapMode(
  options: Pick<RepairCliOptions, 'execute'>,
  appRole: unknown,
): RepairBootstrapMode {
  if (!options.execute) {
    return 'direct_prisma_read_only';
  }
  const normalizedRole = typeof appRole === 'string' ? appRole.trim().toLowerCase() : '';
  if (normalizedRole !== 'admin') {
    throw new Error(
      `--execute must run with APP_ROLE=admin; received ${normalizedRole || 'unset'}`,
    );
  }
  return 'admin_app_context';
}

export type RepairCandidateRow = {
  claimId: string;
  claimCreatedAt: Date;
  chatId: string;
  userId: string;
  messageId: string;
  claimRuleCode: string;
  updateType: string;
  entityType: 'CHAT' | 'CHANNEL';
  chatBotId: string | null;
  chatPrimaryBotId: string | null;
  evidenceEventId: string | null;
  evidenceCreatedAt: Date | null;
  evidenceBotId: string | null;
  evidenceEventType: string | null;
  evidenceRuleCode: string | null;
  evidenceAction: string | null;
  evidenceMaskedExcerpt: string | null;
  evidenceScore: number | null;
  evidenceMetadata: Prisma.JsonValue | null;
  confirmedDeleteEventId: string | null;
  existingIntentId: string | null;
  existingIntentStatus: string | null;
  existingIntentExecuteAt: Date | null;
  existingIntentOriginBotId: string | null;
  existingIntentReasons: Prisma.JsonValue;
};

export type RepairCandidateDecision =
  | {
      eligible: true;
      executeAt: Date;
      family: string;
      intentRuleCode: string;
      messageAuthorKind: 'user' | 'bot';
      eventType: 'MESSAGE' | null;
    }
  | {
      eligible: false;
      reason:
        | 'commercial_review_only'
        | 'commercial_allow'
        | 'commercial_not_actionable'
        | 'commercial_unknown_action_band'
        | 'bot_auto_delete_missing_schedule_evidence'
        | 'confirmed_delete_event'
        | 'missing_origin_bot'
        | 'terminal_intent'
        | 'unsupported_rule_update_pair'
        | 'ambiguous_delete_evidence';
    };

export function readRepairCliOptions(
  argv: readonly string[],
  now: Date = new Date(),
): RepairCliOptions {
  validateKnownArguments(argv);
  const execute = argv.includes('--execute');
  if (execute && argv.includes('--dry-run')) {
    throw new Error('--execute and --dry-run cannot be used together');
  }

  const until = readDateOption(argv, '--until') ?? new Date(now);
  const explicitSince = readDateOption(argv, '--since');
  const windowHours = readBoundedPositiveNumberOption(
    argv,
    '--window-hours',
    REPAIR_MAX_WINDOW_HOURS,
  );
  if (explicitSince && windowHours !== undefined) {
    throw new Error('--since and --window-hours cannot be used together');
  }
  const since =
    explicitSince ??
    new Date(until.getTime() - (windowHours ?? REPAIR_DEFAULT_WINDOW_HOURS) * 60 * 60_000);
  const windowMs = until.getTime() - since.getTime();
  if (windowMs <= 0) {
    throw new Error('--since must be earlier than --until');
  }
  if (windowMs > REPAIR_MAX_WINDOW_HOURS * 60 * 60_000) {
    throw new Error(`repair window cannot exceed ${REPAIR_MAX_WINDOW_HOURS} hours`);
  }

  const globalCapOption = readBoundedPositiveIntOption(argv, '--global-cap', REPAIR_MAX_GLOBAL_CAP);
  const legacyLimitOption = readBoundedPositiveIntOption(argv, '--limit', REPAIR_MAX_GLOBAL_CAP);
  if (globalCapOption !== undefined && legacyLimitOption !== undefined) {
    throw new Error('--global-cap and --limit cannot be used together');
  }
  const globalCap = globalCapOption ?? legacyLimitOption ?? REPAIR_DEFAULT_GLOBAL_CAP;
  const perChatCap =
    readBoundedPositiveIntOption(argv, '--per-chat-cap', REPAIR_MAX_PER_CHAT_CAP) ??
    REPAIR_DEFAULT_PER_CHAT_CAP;
  const batchSize =
    readBoundedPositiveIntOption(argv, '--batch-size', REPAIR_MAX_BATCH_SIZE) ??
    REPAIR_DEFAULT_BATCH_SIZE;
  const defaultScanCap = Math.min(REPAIR_MAX_SCAN_CAP, Math.max(batchSize, globalCap * 10));
  const scanCap =
    readBoundedPositiveIntOption(argv, '--scan-cap', REPAIR_MAX_SCAN_CAP) ?? defaultScanCap;
  if (scanCap < globalCap) {
    throw new Error('--scan-cap must be greater than or equal to --global-cap/--limit');
  }

  return {
    since,
    until,
    execute,
    help: argv.includes('--help'),
    chatIds: readChatIdAllowlist(argv),
    globalCap,
    perChatCap,
    batchSize,
    scanCap,
  };
}

export function evaluateRepairCandidate(candidate: RepairCandidateRow): RepairCandidateDecision {
  if (candidate.confirmedDeleteEventId) {
    return { eligible: false, reason: 'confirmed_delete_event' };
  }
  if (
    candidate.existingIntentStatus &&
    REPAIR_TERMINAL_INTENT_STATUSES.includes(
      candidate.existingIntentStatus as (typeof REPAIR_TERMINAL_INTENT_STATUSES)[number],
    )
  ) {
    return { eligible: false, reason: 'terminal_intent' };
  }

  const policy = resolveDeleteCandidatePolicy(candidate);
  if (!policy) {
    return { eligible: false, reason: 'unsupported_rule_update_pair' };
  }
  if (!resolveRepairOriginBotId(candidate)) {
    return { eligible: false, reason: 'missing_origin_bot' };
  }
  const existingReason = findExistingIntentReason(candidate, policy.intentRuleCode);
  const evidenceMetadata = asRecord(candidate.evidenceMetadata);
  const metadata = evidenceMetadata ?? asRecord(existingReason?.metadata);
  if (candidate.claimRuleCode === 'COMMERCIAL_AD') {
    const actionBand = readString(metadata?.actionBand)?.toUpperCase() ?? null;
    if (actionBand === 'REVIEW_ONLY') {
      return { eligible: false, reason: 'commercial_review_only' };
    }
    if (actionBand === 'ALLOW') {
      return { eligible: false, reason: 'commercial_allow' };
    }
    if (metadata?.actionable === false) {
      return { eligible: false, reason: 'commercial_not_actionable' };
    }
    if (!actionBand || !COMMERCIAL_DELETE_ACTION_BANDS.has(actionBand)) {
      return { eligible: false, reason: 'commercial_unknown_action_band' };
    }
  }

  if (policy.evidence === 'bot_account_message' && !existingReason) {
    if (
      candidate.evidenceEventId === null ||
      candidate.evidenceEventType !== 'MEMBER_ACTION' ||
      candidate.evidenceAction !== 'KICK' ||
      readString(evidenceMetadata?.reason) !== BOT_ACCOUNT_MESSAGE_DELETE_REASON
    ) {
      return { eligible: false, reason: 'ambiguous_delete_evidence' };
    }
  }
  if (policy.evidence === 'local_admin_block_message' && !existingReason) {
    if (
      candidate.evidenceEventId === null ||
      candidate.evidenceEventType !== 'MEMBER_ACTION' ||
      candidate.evidenceAction !== 'KICK' ||
      readString(evidenceMetadata?.reason) !== LOCAL_ADMIN_BLOCK_MESSAGE_DELETE_REASON
    ) {
      return { eligible: false, reason: 'ambiguous_delete_evidence' };
    }
  }
  if (policy.evidence === 'global_spammer_message' && !existingReason) {
    const evidenceReason = readString(evidenceMetadata?.reason);
    if (
      candidate.evidenceEventId === null ||
      candidate.evidenceEventType !== 'MEMBER_ACTION' ||
      candidate.evidenceAction !== 'KICK' ||
      !evidenceReason ||
      !GLOBAL_SPAMMER_MESSAGE_DELETE_REASONS.has(evidenceReason)
    ) {
      return { eligible: false, reason: 'ambiguous_delete_evidence' };
    }
  }

  let executeAt = new Date();
  if (policy.evidence === 'bot_auto_delete') {
    const delayMinutes = readFiniteNumber(metadata?.delayMinutes);
    if (existingReason && candidate.existingIntentExecuteAt) {
      executeAt = candidate.existingIntentExecuteAt;
    } else if (
      candidate.evidenceEventId !== null &&
      candidate.evidenceCreatedAt !== null &&
      candidate.evidenceRuleCode === 'BOT_MESSAGE_AUTO_DELETE' &&
      candidate.evidenceAction === 'DELETE_MESSAGE' &&
      readString(evidenceMetadata?.reason) === SCHEDULED_BOT_DELETE_REASON &&
      delayMinutes !== null &&
      delayMinutes >= 0.5 &&
      delayMinutes <= 60
    ) {
      executeAt = new Date(candidate.evidenceCreatedAt.getTime() + delayMinutes * 60_000);
    } else {
      return { eligible: false, reason: 'bot_auto_delete_missing_schedule_evidence' };
    }
  }

  return {
    eligible: true,
    executeAt,
    family: policy.family,
    intentRuleCode: policy.intentRuleCode,
    messageAuthorKind: policy.messageAuthorKind,
    eventType: policy.eventType,
  };
}

export function buildRepairIntentInput(
  candidate: RepairCandidateRow,
  decision: Extract<RepairCandidateDecision, { eligible: true }>,
): EnsureModerationDeleteIntentInput {
  const originBotId = resolveRepairOriginBotId(candidate);
  return {
    chatId: candidate.chatId,
    messageId: candidate.messageId,
    reasonKey: `repair-missed-delete:${decision.family}:${candidate.claimId}`,
    ruleCode: decision.intentRuleCode,
    subjectUserId: candidate.userId,
    sourceMessageAt: candidate.claimCreatedAt,
    entityType: candidate.entityType,
    messageAuthorKind: decision.messageAuthorKind,
    originBotId,
    routingPolicy:
      candidate.entityType === 'CHAT' && decision.messageAuthorKind === 'user'
        ? 'delete_capable'
        : 'origin_only',
    executeAt: decision.executeAt,
    event: {
      userId: candidate.userId,
      eventType: decision.eventType,
      maskedExcerpt: candidate.evidenceMaskedExcerpt,
      score: candidate.evidenceScore ?? 1,
      metadata: {
        reason: 'Bounded repair intake for a moderation delete missed by the legacy path',
        repair: {
          claimId: candidate.claimId,
          claimCreatedAt: candidate.claimCreatedAt.toISOString(),
          claimRuleCode: candidate.claimRuleCode,
          policyFamily: decision.family,
          intentRuleCode: decision.intentRuleCode,
          updateType: candidate.updateType,
          originalEventId: candidate.evidenceEventId,
          originalEventCreatedAt: candidate.evidenceCreatedAt?.toISOString() ?? null,
          originalEventRuleCode: candidate.evidenceRuleCode,
          originalEventAction: candidate.evidenceAction,
          originalEventType: candidate.evidenceEventType,
          originalEventBotId: candidate.evidenceBotId,
          existingIntentId: candidate.existingIntentId,
          existingIntentStatus: candidate.existingIntentStatus,
        },
        originalEventMetadata: candidate.evidenceMetadata,
      },
    },
  };
}

function resolveRepairOriginBotId(candidate: RepairCandidateRow): string | null {
  return (
    candidate.existingIntentOriginBotId ??
    candidate.evidenceBotId ??
    candidate.chatPrimaryBotId ??
    candidate.chatBotId ??
    null
  );
}

export function toDeleteRuleCode(ruleCode: string): string {
  return ruleCode.endsWith('_DELETE') ? ruleCode : `${ruleCode}_DELETE`;
}

type ResolvedDeleteCandidatePolicy = {
  family: string;
  intentRuleCode: string;
  messageAuthorKind: 'user' | 'bot';
  eventType: 'MESSAGE' | null;
  evidence?:
    | 'bot_account_message'
    | 'bot_auto_delete'
    | 'local_admin_block_message'
    | 'global_spammer_message';
};

function resolveDeleteCandidatePolicy(
  candidate: RepairCandidateRow,
): ResolvedDeleteCandidatePolicy | null {
  if (candidate.entityType !== 'CHAT') {
    return null;
  }
  const updateType = candidate.updateType.trim().toLowerCase();
  if (
    ORDINARY_DELETE_RULE_CODE_SET.has(candidate.claimRuleCode) &&
    (updateType === 'message_created' || updateType === 'message_edited')
  ) {
    return {
      family: 'ordinary_violation',
      intentRuleCode: toDeleteRuleCode(candidate.claimRuleCode),
      messageAuthorKind: 'user',
      eventType: 'MESSAGE',
    };
  }
  if (updateType !== 'message_action') {
    return null;
  }

  const configured = REPAIR_MESSAGE_ACTION_DELETE_POLICIES[
    candidate.claimRuleCode as keyof typeof REPAIR_MESSAGE_ACTION_DELETE_POLICIES
  ] as
    | {
        family: string;
        intentRuleCode: string;
        evidence?: ResolvedDeleteCandidatePolicy['evidence'];
        messageAuthorKind?: 'bot';
      }
    | undefined;
  if (!configured) {
    return null;
  }
  const eventType =
    configured.evidence === 'bot_account_message' ||
    configured.evidence === 'local_admin_block_message' ||
    configured.evidence === 'global_spammer_message'
      ? null
      : 'MESSAGE';
  return {
    family: configured.family,
    intentRuleCode: configured.intentRuleCode,
    messageAuthorKind: configured.messageAuthorKind ?? 'user',
    eventType,
    ...(configured.evidence ? { evidence: configured.evidence } : {}),
  };
}

type ExistingIntentReasonEvidence = {
  reasonKey: string | null;
  ruleCode: string;
  metadata: unknown;
};

function findExistingIntentReason(
  candidate: RepairCandidateRow,
  expectedRuleCode: string,
): ExistingIntentReasonEvidence | null {
  if (!Array.isArray(candidate.existingIntentReasons)) {
    return null;
  }
  for (const item of candidate.existingIntentReasons) {
    const row = asRecord(item);
    if (readString(row?.ruleCode) !== expectedRuleCode) {
      continue;
    }
    return {
      reasonKey: readString(row?.reasonKey),
      ruleCode: expectedRuleCode,
      metadata: row?.metadata,
    };
  }
  return null;
}

function validateKnownArguments(argv: readonly string[]): void {
  const booleanOptions = new Set(['--execute', '--dry-run', '--help']);
  const valueOptions = new Set([
    '--chat-id',
    '--since',
    '--until',
    '--window-hours',
    '--global-cap',
    '--limit',
    '--per-chat-cap',
    '--batch-size',
    '--scan-cap',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanOptions.has(arg)) {
      continue;
    }
    if (!valueOptions.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
  }
}

function readChatIdAllowlist(argv: readonly string[]): string[] {
  const chatIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--chat-id') {
      continue;
    }
    const rawValue = argv[index + 1];
    if (!rawValue || rawValue.startsWith('--')) {
      throw new Error('--chat-id requires a value');
    }
    const entries = rawValue.split(',').map((value) => value.trim());
    if (entries.some((value) => value.length === 0)) {
      throw new Error('--chat-id values must be non-empty chat IDs');
    }
    for (const chatId of entries) {
      if (!chatIds.includes(chatId)) {
        chatIds.push(chatId);
      }
    }
  }
  return chatIds;
}

function readDateOption(argv: readonly string[], name: string): Date | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date`);
  }
  return parsed;
}

function readBoundedPositiveIntOption(
  argv: readonly string[],
  name: string,
  max: number,
): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function readBoundedPositiveNumberOption(
  argv: readonly string[],
  name: string,
  max: number,
): number | undefined {
  const value = readOptionValue(argv, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a number greater than 0 and at most ${max}`);
  }
  return parsed;
}

function readOptionValue(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) {
    throw new Error(`${name} may be specified only once`);
  }
  const index = indexes[0];
  return index === undefined ? undefined : argv[index + 1];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
