import type { ChatSettings } from '../prisma/prisma-client';
import type { BotSpeechPersona } from '@maxim/contracts/bot-speech';
import type { ChannelSettings as PersistedChannelSettings } from '../prisma/prisma-client';
import { getJoinWebhookShardConcurrencies } from '../runtime/moderation-runtime';
import {
  readPositiveInt,
  resolveModerationConcurrencySplit,
  resolveShardConcurrencyDistribution,
} from './moderation-concurrency.util';
import { DEFAULT_WEBHOOK_QUEUE_NAMES, JOIN_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';

export const CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES = [400, 404] as const;
export const PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES = [403, 404] as const;
export const BOT_ADDED_ONBOARDING_TERMINAL_FAILURE_METRIC_STATUSES = [403, 404] as const;
// FLAG: Apply to mutations and their pre-dispatch reads. Target-local denial/absence still
// throws, but must not pause unrelated publication work through global API health pressure.
export const MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES = [403, 404] as const;
export type ActiveMute = {
  eventId: string;
  issuedAt: Date;
  expiresAt: Date | null;
  durationHours: number | null;
  permanent: boolean;
  ruleCode?: string | null;
};
export type ActiveMuteCacheReadResult =
  | { status: 'active'; mute: ActiveMute }
  | { status: 'inactive' }
  | { status: 'miss' };
export type ChatAdminCheckSource =
  | 'remote'
  | 'local'
  | 'remote+local'
  | 'local_fallback'
  | 'persisted_roster';
export type ChatAdminCheckResult = {
  isAdmin: boolean;
  source: ChatAdminCheckSource;
};
export type RequiredSubscriptionChannelMetadata = {
  id: string;
  title: string;
  link: string | null;
  usable: boolean;
  checkMembership: boolean;
};
export type SharedChatExecutionGuard =
  | {
      mode: 'allow';
      activeBotId: string | null;
      primaryBotId: string | null;
      assignedBotIds: string[];
      requiresExecutionLock: boolean;
      lockScope?: 'owner' | 'chat';
    }
  | {
      mode: 'skip' | 'blocked-join-check-only';
      activeBotId: string | null;
      primaryBotId: string | null;
      assignedBotIds: string[];
      reason: 'non-primary-bot' | 'removed-membership';
    };
export type RemoteChatAdminAccessState = 'granted' | 'user_denied';
export type ManagedChannelContext = {
  channelSettings: PersistedChannelSettings;
  adminUserIds: string[];
};
export type ChannelAutoPostExecutionPlan = {
  batchSize: number;
  interChannelDelayMs: number;
  maxNewMessagesPerScan: number;
};
export type PendingChatAdminLookup = {
  cacheKey: string;
  userId: string;
  staleCached: RemoteChatAdminAccessState | null;
  resolve: (value: RemoteChatAdminAccessState | null) => void;
};
export type PendingChatAdminLookupBatch = {
  chatId: string;
  lookups: Map<string, PendingChatAdminLookup>;
  scheduled: boolean;
};
export type PendingChatAdminSharedCacheRead = {
  cacheKey: string;
  userId: string;
  resolve: (value: RemoteChatAdminAccessState | null) => void;
  reject: (reason?: unknown) => void;
};
export type PendingChatAdminSharedCacheBatch = {
  chatId: string;
  reads: Map<string, PendingChatAdminSharedCacheRead>;
  scheduled: boolean;
};
export type PendingGlobalSpammerExemptionLookup = {
  userId: string;
  resolve: (value: LocalGlobalSpammerAdminDecision | null) => void;
  reject: (reason?: unknown) => void;
};

export type LocalGlobalSpammerAdminDecision = 'ALLOW' | 'BLOCK' | 'REVIEW';

export type PendingGlobalSpammerExemptionLookupBatch = {
  scopeKey: string;
  adminUserIds: string[];
  lookups: Map<string, PendingGlobalSpammerExemptionLookup>;
  scheduled: boolean;
};

export type NightModeCloseNoticeEventRecovery =
  | {
      version: 2;
      pending: true;
      timezone: string;
      startMinutes: number;
      endMinutes: number;
    }
  | {
      version: 'unsupported';
      pending: true;
    };

export type NightModeTransitionState = {
  status: 'open' | 'closed';
  sessionKey: string;
  closeNoticeMessageId?: string | null;
  closeNoticeBotId?: string | null;
  closeNoticeEventRecovery?: NightModeCloseNoticeEventRecovery;
  updatedAt?: string;
};

// FLAG: Runtime delivery and durable schedule repair must share this key and parser.
export function buildNightModeTransitionStateKey(chatId: string): string {
  return `night-mode-transition-state:v1:${chatId}`;
}

export function parseNightModeTransitionState(value: unknown): NightModeTransitionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  const sessionKey = record.sessionKey;
  if ((status !== 'open' && status !== 'closed') || typeof sessionKey !== 'string') {
    return null;
  }

  const closeNoticeMessageId =
    typeof record.closeNoticeMessageId === 'string' && record.closeNoticeMessageId.trim()
      ? record.closeNoticeMessageId.trim()
      : null;
  const closeNoticeBotId =
    typeof record.closeNoticeBotId === 'string' && record.closeNoticeBotId.trim()
      ? record.closeNoticeBotId.trim()
      : null;
  const recoveryRecord =
    record.closeNoticeEventRecovery &&
    typeof record.closeNoticeEventRecovery === 'object' &&
    !Array.isArray(record.closeNoticeEventRecovery)
      ? (record.closeNoticeEventRecovery as Record<string, unknown>)
      : null;
  const recoveryTimezone =
    typeof recoveryRecord?.timezone === 'string' && recoveryRecord.timezone.trim()
      ? recoveryRecord.timezone.trim()
      : null;
  const recoveryStartMinutes = recoveryRecord?.startMinutes;
  const recoveryEndMinutes = recoveryRecord?.endMinutes;
  const closeNoticeEventRecovery: NightModeCloseNoticeEventRecovery | null =
    recoveryRecord?.pending === true
      ? recoveryRecord.version === 2 &&
        recoveryTimezone !== null &&
        typeof recoveryStartMinutes === 'number' &&
        Number.isInteger(recoveryStartMinutes) &&
        recoveryStartMinutes >= 0 &&
        recoveryStartMinutes < 24 * 60 &&
        typeof recoveryEndMinutes === 'number' &&
        Number.isInteger(recoveryEndMinutes) &&
        recoveryEndMinutes >= 0 &&
        recoveryEndMinutes < 24 * 60
        ? {
            version: 2,
            pending: true,
            timezone: recoveryTimezone,
            startMinutes: recoveryStartMinutes,
            endMinutes: recoveryEndMinutes,
          }
        : { version: 'unsupported', pending: true }
      : null;
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : undefined;

  return {
    status,
    sessionKey,
    closeNoticeMessageId,
    closeNoticeBotId,
    ...(closeNoticeEventRecovery ? { closeNoticeEventRecovery } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export type WebhookHotPathProfile = {
  startedAtMs: number;
  lastMarkedAtMs: number;
  latestStage: string;
  stages: Map<string, number>;
  stageTimelineMs: Map<string, number>;
  successBoundaryReached: boolean;
  successBoundaryStage: string | null;
};

export type RulesButtonReference = {
  publishedUrl: string | null;
  publishedMessageId: string | null;
};

export type RequiredSubscriptionMembershipLookupOptions = {
  forceFresh?: boolean;
  allowStaleOnError?: boolean;
};

export type InvitationAccessProgressSnapshot = {
  invitedUserIds: string[];
  invitedCount: number;
  completedAt: Date | null;
};

export type InvitationAccessProgressUpdateResult = InvitationAccessProgressSnapshot & {
  addedInviteeUserIds: string[];
  completed: boolean;
};

export type InvitationAccessProgressDelegate = {
  findUnique?: (args: {
    where: { chatId_userId: { chatId: string; userId: string } };
    select: { invitedUserIds: true; completedAt: true };
  }) => Promise<{ invitedUserIds: string[]; completedAt: Date | null } | null>;
  create?: (args: {
    data: {
      chatId: string;
      userId: string;
      invitedUserIds: string[];
      completedAt?: Date;
    };
    select: { invitedUserIds: true; completedAt: true };
  }) => Promise<{ invitedUserIds: string[]; completedAt: Date | null }>;
  update?: (args: {
    where: { chatId_userId: { chatId: string; userId: string } };
    data: {
      invitedUserIds: { set: string[] };
      completedAt?: Date;
    };
    select: { invitedUserIds: true; completedAt: true };
  }) => Promise<{ invitedUserIds: string[]; completedAt: Date | null }>;
};

export type ChannelDialogType = 'comments' | 'suggest';

export type ModerationActionAttemptResult =
  | { status: 'executor_rejected' }
  | { status: 'success'; botId: string | null }
  | { status: 'no_candidates' }
  | { status: 'backoff_blocked' }
  | {
      status: 'terminal_error';
      attemptedBotIds: string[];
      error: unknown;
    };

export type ModerationActionExecutionResult = {
  ok: boolean;
  botId: string | null;
};

export type AdminForwardedModerationCommand =
  | {
      action: 'BAN';
      fanoutAllChats?: boolean;
    }
  | {
      action: 'SUPER_BAN';
    }
  | {
      action: 'MUTE';
      fanoutAllChats?: boolean;
      muteDurationHours?: number;
      mutePermanent?: true;
    }
  | {
      action: 'RULES';
    }
  | {
      action: 'SILENCE';
      silenceDurationHours?: number;
    }
  | {
      action: 'OPEN_CHAT';
    };

export type ForwardedModerationTarget = {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  senderName: string | null;
  messageId: string | null;
};

export type ForwardedRulesSource = {
  chatId: string;
  chatTitle: string | null;
  messageId: string | null;
  url: string | null;
  text: string | null;
};

export const DEFAULT_MUTE_DURATION_HOURS = 6;
export const MAX_ACTIVE_MUTE_DURATION_HOURS = 336;
export const PERMANENT_MUTE_COMMAND_DURATION_HOURS = 88;
export const DELETE_MESSAGE_PERMISSION_ALIASES = new Set(['delete', 'delete_message']);
export const CHAT_DELETE_MESSAGE_PERMISSION_ALIASES = new Set([
  'write',
  'post_edit_delete_message',
]);
export const MODERATE_MEMBER_PERMISSION_ALIASES = new Set([
  'add_remove_members',
  'can_add_remove_members',
  'remove_members',
  'can_remove_members',
  'manage_members',
  'can_manage_members',
  'kick_members',
  'can_kick_members',
  'ban_members',
  'can_ban_members',
  'delete_members',
  'can_delete_members',
]);
export const DEFAULT_BOT_BUTTON_TEXT = 'Открыть';
export const RULES_BOT_BUTTON_TEXT = 'Правила';
export const RULES_CALLBACK_PAYLOAD = 'rules:open';
export const DEFAULT_NIGHT_MODE_TIMEZONE = 'Europe/Moscow';
export const LINK_ESCALATION_WINDOW_HOURS = 24;
export const TEXT_FILTER_ESCALATION_WINDOW_HOURS = 24;
export const PROFANITY_AUTOMATIC_ESCALATION_MIN_SCORE = 0.9;
export const MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS = 12;
export const REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS = 24;
export const REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC = 90;
export const REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC = 45;
export const REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS = 15_000;
export const REQUIRED_SUBSCRIPTION_NOTICE_LOCK_TTL_MS = 60_000;
export const REQUIRED_SUBSCRIPTION_CHANNEL_METADATA_CACHE_TTL_MS = 10 * 60_000;
export const REQUIRED_SUBSCRIPTION_RULE_CODE = 'REQUIRED_SUBSCRIPTION';
export const INVITATION_ACCESS_ESCALATION_WINDOW_HOURS = 24;
export const INVITATION_ACCESS_NOTICE_COOLDOWN_SEC = 15 * 60;
export const INVITATION_ACCESS_RULE_CODE = 'INVITATION_ACCESS_REQUIRED';
export const MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS = 5 * 60 * 1_000;
export const MODERATION_ACTION_PERMISSION_BACKOFF_MS = 30 * 60 * 1_000;
export const MODERATION_ACTION_PERMISSION_REFRESH_TIMEOUT_MS = 1_500;
export const MODERATION_ACTION_PERMISSION_REFRESH_MIN_INTERVAL_MS = 15_000;
export const REQUIRED_SUBSCRIPTION_UNRESOLVED_LOG_INTERVAL_MS = 5 * 60 * 1_000;
export const WEBHOOK_HOT_CHAT_BACKOFF_MS = 60_000;
export const WEBHOOK_HOT_CHAT_SKIP_LOG_INTERVAL_MS = 30_000;
export const WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES = new Set([
  'violation-follow-up',
  'required-subscription.follow-up',
  'required-subscription.sanction',
  'required-subscription.notice-plan',
  'required-subscription.notice-handoff',
]);
export const REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC = 10;
export const BOT_NOTICE_TOKEN_BUCKET_TTL_SEC = 60;
export const DEFAULT_BOT_NOTICE_TOKEN_BUCKET_LIMIT = 6;
export const CHAT_ADMIN_SOFT_LOOKUP_FAILURE_METRIC_STATUSES = [403, 404] as const;
export const CHAT_ADMIN_CACHE_TTL_MS = 60_000;
export const ADMIN_CONTACT_DISPLAY_NAME_CACHE_TTL_MS = 10 * 60_000;
export const ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS = 450;
export const CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS = 500;
export const DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS = 30_000;
export const CHAT_ADMIN_SOFT_TIMEOUT_BACKOFF_MS = 5_000;
export const CHAT_ADMIN_LOOKUP_BACKOFF_MS = 30_000;
export const DEFAULT_CHAT_ADMIN_LOOKUP_TIMEOUT_MS = 2_000;
export const CHAT_ADMIN_LOOKUP_GUARD_SLACK_MS = 750;
export const CHAT_ADMIN_LOOKUP_SLOW_LOG_THRESHOLD_MS = 1_500;
export const BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS = 60_000;
export const MODERATION_CONCURRENCY_SPLIT = resolveModerationConcurrencySplit(
  readPositiveInt(process.env.MODERATION_CONCURRENCY, 24),
);
export const LEGACY_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_LEGACY,
  1,
);
export const CRITICAL_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_CRITICAL,
  MODERATION_CONCURRENCY_SPLIT.critical,
);
export const JOIN_MODERATION_SHARD_CONCURRENCIES_BY_NAME = getJoinWebhookShardConcurrencies();
export const JOIN_MODERATION_SHARD_CONCURRENCIES = JOIN_WEBHOOK_QUEUE_NAMES.map(
  (queueName) => JOIN_MODERATION_SHARD_CONCURRENCIES_BY_NAME[queueName],
);
export const DEFAULT_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_DEFAULT,
  MODERATION_CONCURRENCY_SPLIT.default,
);
export const DEFAULT_MODERATION_SHARD_CONCURRENCY_DEFAULTS = resolveShardConcurrencyDistribution(
  DEFAULT_MODERATION_CONCURRENCY,
  DEFAULT_WEBHOOK_QUEUE_NAMES.length,
);
export const DEFAULT_MODERATION_SHARD_CONCURRENCIES = DEFAULT_WEBHOOK_QUEUE_NAMES.map((_, index) =>
  readPositiveInt(
    process.env[`MODERATION_CONCURRENCY_DEFAULT_SHARD_${index}`],
    DEFAULT_MODERATION_SHARD_CONCURRENCY_DEFAULTS[index] ?? 1,
  ),
);
export const BACKGROUND_MODERATION_CONCURRENCY = readPositiveInt(
  process.env.MODERATION_CONCURRENCY_BACKGROUND,
  MODERATION_CONCURRENCY_SPLIT.background,
);
export const SUPPORT_CHAT_URL = 'https://max.ru/join/qX7U_Hj-L-xMJG8V7wlF6dD-6a6cXIzTBGRtU2mRMzk';
export const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
export const PRIVATE_MENU_CALLBACK_MENU = 'private_menu:menu';
export const PRIVATE_MENU_CALLBACK_CHATS = 'private_menu:chats';
export const PRIVATE_MENU_CALLBACK_CHANNELS = 'private_menu:channels';
export const PRIVATE_MENU_CALLBACK_HELP = 'private_menu:help';
export const PRIVATE_BOT_CHATS_PREVIEW_LIMIT = 12;
export const MAX_FORWARD_SCAN_DEPTH = 8;
export const DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS = 30_000;
export const DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS = 8;
export const DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS = 150;
export const DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS = 5 * 60 * 1_000;
export const DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS = 30_000;
export const DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS = 15_000;
export const DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN = 3;
export const DEFAULT_CHANNEL_AUTO_POST_REPAIR_SWEEP_MS = 10 * 60 * 1_000;
export const CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR = 2;
export const CHANNEL_AUTO_POST_SLOW_INTER_CHANNEL_DELAY_MS = 500;
export const CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN = 1;
export const CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS = 60_000;
export const CHANNEL_AUTO_POST_GOVERNOR_UNAVAILABLE_BACKOFF_MS = 180_000;
export const DEFAULT_CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS = 5 * 60 * 1_000;
export const DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS = 5_000;
export const NIGHT_MODE_TRANSITION_LOCK_TTL_MS = 20_000;
export const NIGHT_MODE_TRANSITION_STATE_TTL_SEC = 3 * 24 * 60 * 60;
export const DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC = 5;
export const DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE = 0.75;
export const DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE = 4;
export const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
export const CHANNEL_DIALOG_TOKEN_PREFIX = 'cdt-';
export const SHARED_CHAT_EXECUTION_LOCK_TTL_MS = 45_000;
export const SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS =
  SHARED_CHAT_EXECUTION_LOCK_TTL_MS + 15_000;
export const DEFAULT_SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS = 1_000;
export const DEFAULT_SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS = 1_000;
export const DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_FACING_SLOW_LOG_THRESHOLD_MS = 5_000;
export const WEBHOOK_OPTIONAL_STAGE_MIN_REMAINING_MS = 1_500;
export const REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS = 1_000;
export const REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS = 3_000;
export const REQUIRED_SUBSCRIPTION_MEMBERSHIP_MIN_REMAINING_MS = 1_000;
export const VIOLATION_ADMIN_RECHECK_RESERVE_MS = 250;
export const VIOLATION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS = 2_000;
export const DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS = 2_000;
export const DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS = 2_000;
export const CHANNEL_DIALOG_AUTO_ATTACH_ACTION = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT';
export const CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION = 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED';
export const CHAT_DIALOG_AUTO_ATTACH_ACTION = 'AUTO_ATTACH_CHAT_COMMENTS';
// FLAG: MAX rejects keyboard-only replies, so keep one invisible non-empty character.
export const CHAT_COMMENTS_REPLY_TEXT = '\u200B';
export const GLOBAL_SPAMMER_WINDOW_SEC = 2 * 60;
export const GLOBAL_SPAMMER_REDIS_TTL_SEC = GLOBAL_SPAMMER_WINDOW_SEC + 5;
export const GLOBAL_SPAMMER_LOCAL_CHAT_OBSERVATION_TTL_MS = GLOBAL_SPAMMER_REDIS_TTL_SEC * 1_000;
export const GLOBAL_SPAMMER_EXEMPTION_CACHE_TTL_MS = 60_000;
export const GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS = 350;
export const GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS = 500;
export const GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS = 350;
export const DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS = 350;
export const MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS = 500;
export const MODERATION_ACTION_DISPATCH_TIMEOUT_MS = 2_000;
export const GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS = 6;
export const GLOBAL_SPAMMER_EPISODE_LOCK_TTL_SEC = 5 * 60;
export const GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC = 7 * 24 * 60 * 60;
export const GLOBAL_SPAMMER_MEDIUM_FANOUT_EPISODE_THRESHOLD = 2;
export const GLOBAL_SPAMMER_STRONG_FANOUT_EPISODE_THRESHOLD = 3;
export const GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD = 4;
export const GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS = 16;
export const CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS = new Set([
  'chat_id',
  'chatid',
  'message_id',
  'messageid',
  'sender_id',
  'senderid',
  'user_id',
  'userid',
  'update_id',
  'updateid',
  'created_at',
  'createdat',
  'timestamp',
  'seq',
  'mid',
]);
export const NON_SANCTION_RULE_CODES = new Set([
  'LINK_BLOCKED',
  'PROFANITY',
  'COMMERCIAL_AD',
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
]);
export const MESSAGE_LIMITS_RULE_CODES = new Set([
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
]);
export type GlobalSpammerTrackingResult = {
  handled: boolean;
  skipKnownSpammerCheck: boolean;
  enforcementReady?: true;
};
export const TEXT_FILTER_RULE_CODES = new Set(['PROFANITY', 'COMMERCIAL_AD']);
export type PrivateControlCommand = 'menu' | 'chats' | 'channels' | 'help';
export type ActiveBotSpeechProfile = {
  persona: BotSpeechPersona;
  characterName: string;
};

export function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<ChatSettings, 'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds'>,
): boolean {
  const channelIds = Array.isArray(settings.requiredSubscriptionChannelIds)
    ? settings.requiredSubscriptionChannelIds
    : [];

  return settings.requiredSubscriptionEnabled && channelIds.length > 0;
}

export function isInvitationAccessCurrentlyActive(
  _settings: Pick<ChatSettings, 'invitationAccessEnabled' | 'invitationAccessRequiredCount'>,
): boolean {
  return false;
}
