import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { extractHttpStatusCode } from '../common/http-error.util';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  MaxClientService,
  type MaxApiTrafficClass,
} from './max-client.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxModerationApiBudgetError } from './max-moderation-api-budget';
import { resolveExplicitMembershipAccessDenial } from './max-membership-access-error';
import { wasMaxMemberMutationAttempted } from './max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from './max-mutation-outcome.util';

export type MaxMembershipLookupPolicy =
  | 'moderation_required_subscription'
  | 'giveaway_interactive'
  | 'giveaway_strict'
  | 'giveaway_draw_interactive'
  | 'giveaway_draw_background';

export type MaxMembershipLookupIssueKind = 'transient' | 'terminal';

export type MaxMembershipLookupIssue = {
  chatId: string;
  policyName: MaxMembershipLookupPolicy;
  kind: MaxMembershipLookupIssueKind;
  retryAfterMs: number;
  observedAtMs: number;
  expiresAtMs: number;
  statusCode: number | null;
  message: string;
};

type MaxMembershipLookupOptions = {
  forceRefresh?: boolean;
  allowStaleOnError?: boolean;
  botId?: string | null;
};

export type MaxMembershipLookupResolution = {
  membership: boolean | null;
  fresh: boolean;
  unavailableReason?: 'membership_get_local_quota';
};

type MembershipLookupScope = {
  chatId: string;
  userId: string;
  policyName: MaxMembershipLookupPolicy;
  botId: string | null;
};

type MembershipLookupBackoff = {
  untilMs: number;
  localQuotaScope?: MembershipLookupScope;
};

const membershipGetLocalQuotaResolutions = new WeakMap<object, MembershipLookupScope>();

// FLAG: Only an actual membership GET's nominal pre-dispatch refusal can nominate a
// bounded recheck. Copied result fields and diagnostics grant no continuation authority.
export function isMaxMembershipLookupLocalQuotaResolution(
  value: unknown,
): value is MaxMembershipLookupResolution & { unavailableReason: 'membership_get_local_quota' } {
  if (!value || typeof value !== 'object' || !membershipGetLocalQuotaResolutions.has(value))
    return false;
  const resolution = value as MaxMembershipLookupResolution;
  return (
    resolution.membership === null &&
    resolution.fresh === false &&
    resolution.unavailableReason === 'membership_get_local_quota'
  );
}

function sameMembershipLookupScope(left: MembershipLookupScope, right: MembershipLookupScope) {
  return (
    left.chatId === right.chatId &&
    left.userId === right.userId &&
    left.policyName === right.policyName &&
    left.botId === right.botId
  );
}

function withMembershipGetLocalQuotaProvenance(
  resolution: MaxMembershipLookupResolution,
  scope?: MembershipLookupScope,
): MaxMembershipLookupResolution {
  if (!scope || resolution.membership !== null || resolution.fresh) return resolution;
  const marked: MaxMembershipLookupResolution = {
    ...resolution,
    unavailableReason: 'membership_get_local_quota',
  };
  membershipGetLocalQuotaResolutions.set(marked, scope);
  return marked;
}

function isMembershipGetLocalQuotaRefusal(error: unknown): error is MaxApiInternalRateLimitError {
  const evidence = error as {
    response?: unknown;
    request?: unknown;
    config?: { method?: unknown };
  };
  return (
    error instanceof MaxApiInternalRateLimitError &&
    // FLAG: This nominal subtype belongs to its bounded muted-user DELETE attempt.
    // It cannot mint an independent candidate that would escape that protection budget.
    !(error instanceof MaxModerationApiBudgetError) &&
    error.preDispatch === true &&
    extractHttpStatusCode(error) === null &&
    evidence.response == null &&
    evidence.request == null &&
    (evidence.config?.method === undefined || evidence.config.method === 'get') &&
    !wasMaxMessageSendAttempted(error) &&
    !wasMaxMemberMutationAttempted(error) &&
    !isMaxMutationOutcomeAmbiguous(error)
  );
}

type MembershipCacheSnapshot = {
  isMember: boolean;
  checkedAtMs: number;
  probeStartedAtMs?: number;
  writerPolicy?: MaxMembershipLookupPolicy;
};

type CacheEpochState = {
  epoch: number;
  expiresAtMs: number;
  invalidatedAtMs: number;
};

type ChatBackoffState = {
  failureCount: number;
  lastFailureAtMs: number;
};

type HotChannelState = {
  failureCount: number;
  lastFailureAtMs: number;
  hotUntilMs: number;
};

type MembershipLookupPolicyConfig = {
  positiveFreshTtlSec: number;
  negativeFreshTtlSec: number;
  backoffMs: number;
  trafficClass: MaxApiTrafficClass;
  allowStaleOnError: boolean;
  sourceTag?: string;
  ignoreFailureMetricStatuses?: readonly number[];
};

type PendingSingleLookup = {
  cacheKey: string;
  cacheEpoch: number;
  probeSequence: number;
  allowStaleOnError: boolean;
  resolve: (value: MaxMembershipLookupResolution) => void;
};

type PendingSingleLookupBatch = {
  chatId: string;
  policy: MembershipLookupPolicyConfig;
  policyName: MaxMembershipLookupPolicy;
  botId: string | null;
  bypassTransportCache: boolean;
  lookups: Map<string, PendingSingleLookup>;
  scheduled: boolean;
  timeout: NodeJS.Timeout | null;
};

const MEMBERSHIP_LOOKUP_POLICIES: Record<MaxMembershipLookupPolicy, MembershipLookupPolicyConfig> =
  {
    moderation_required_subscription: {
      positiveFreshTtlSec: 15,
      negativeFreshTtlSec: 10,
      backoffMs: 15_000,
      trafficClass: 'critical',
      allowStaleOnError: false,
      sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
      ignoreFailureMetricStatuses: [403, 404],
    },
    giveaway_interactive: {
      positiveFreshTtlSec: 15,
      negativeFreshTtlSec: 3,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: true,
    },
    giveaway_strict: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: false,
    },
    giveaway_draw_interactive: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: false,
    },
    giveaway_draw_background: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'background',
      allowStaleOnError: false,
      sourceTag: MAX_API_SOURCE_TAGS.GIVEAWAY_DRAW_BACKGROUND,
    },
  };

const BASE_MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.positiveFreshTtlSec),
);
const BASE_MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.negativeFreshTtlSec),
);
const MEMBERSHIP_INVALIDATION_CHANNEL = 'max:membership:invalidate:v1';
const MEMBERSHIP_INVALIDATION_GUARD_TTL_MS = 120_000;
const MEMBERSHIP_CACHE_EPOCH_SWEEP_INTERVAL_MS = 5_000;
const MEMBERSHIP_CACHE_EPOCH_SWEEP_BATCH_SIZE = 256;
const MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS = 10_000;
const MEMBERSHIP_REDIS_READ_TIMEOUT_MS = 100;
const MEMBERSHIP_LOOKUP_GUARD_SLACK_MS = 400;
const MEMBERSHIP_LOOKUP_SLOW_LOG_THRESHOLD_MS = 1_500;
const GIVEAWAY_DRAW_TERMINAL_CHAT_BACKOFF_MS = 30 * 60 * 1_000;
const REQUIRED_SUBSCRIPTION_TERMINAL_CHAT_BACKOFF_MS = 60_000;
const MEMBERSHIP_CACHE_LEGACY_KEY_PREFIX = 'max:membership:v1';
const MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX = 'max:membership:v2';
const MEMBERSHIP_CACHE_INVALIDATION_FENCE_SUFFIX = ':invalidation-fence';
const MEMBERSHIP_CACHE_COMPARE_AND_SET_SCRIPT = `-- membership-cache-compare-and-set-v1
local incoming_ok, incoming = pcall(cjson.decode, ARGV[1])
local ttl_sec = tonumber(ARGV[2])
local strict_policy = ARGV[3]
local invalidation_fence_suffix = ARGV[4]
if not incoming_ok or type(incoming) ~= 'table' or not ttl_sec then
  return redis.error_reply('invalid membership cache snapshot')
end

local incoming_started_at = tonumber(incoming.probeStartedAtMs)
local incoming_checked_at = tonumber(incoming.checkedAtMs)
local incoming_policy = incoming.writerPolicy
if not incoming_started_at or not incoming_checked_at or type(incoming_policy) ~= 'string' then
  return redis.error_reply('missing membership cache ordering metadata')
end

local applied = {}
for index, key in ipairs(KEYS) do
  local should_write = true
  local invalidated_at = tonumber(redis.call('GET', key .. invalidation_fence_suffix))
  if invalidated_at and incoming_started_at <= invalidated_at then
    should_write = false
  end
  local current_raw = redis.call('GET', key)
  if should_write and current_raw then
    local current_ok, current = pcall(cjson.decode, current_raw)
    if current_ok and type(current) == 'table' then
      local current_started_at = tonumber(current.probeStartedAtMs)
      local current_checked_at = tonumber(current.checkedAtMs)
      local current_policy = current.writerPolicy
      if current_started_at and current_checked_at and type(current_policy) == 'string' then
        local incoming_is_strict = incoming_policy == strict_policy
        local current_is_strict = current_policy == strict_policy
        if incoming_is_strict and not current_is_strict then
          should_write = incoming_checked_at >= current_started_at
        elseif not incoming_is_strict and current_is_strict then
          should_write = incoming_started_at > current_checked_at
        else
          should_write = incoming_started_at > current_started_at or
            (incoming_started_at == current_started_at and incoming_checked_at >= current_checked_at)
        end
      elseif current_checked_at then
        should_write = incoming_checked_at >= current_checked_at
      end
    end
  end

  if should_write then
    redis.call('SET', key, ARGV[1], 'EX', ttl_sec)
    applied[index] = 1
  else
    applied[index] = 0
  end
end
return applied
`;
const MEMBERSHIP_CACHE_INVALIDATE_SCRIPT = `-- membership-cache-invalidation-v1
local invalidated_at = tonumber(ARGV[1])
local fence_ttl_ms = tonumber(ARGV[2])
local invalidation_fence_suffix = ARGV[3]
if not invalidated_at or not fence_ttl_ms then
  return redis.error_reply('invalid membership cache invalidation')
end

for _, key in ipairs(KEYS) do
  redis.call('DEL', key)
  local fence_key = key .. invalidation_fence_suffix
  local current_invalidated_at = tonumber(redis.call('GET', fence_key))
  if not current_invalidated_at or invalidated_at > current_invalidated_at then
    redis.call('SET', fence_key, invalidated_at, 'PX', fence_ttl_ms)
  else
    redis.call('PEXPIRE', fence_key, fence_ttl_ms)
  end
end
redis.call('PUBLISH', ARGV[4], ARGV[5])
return #KEYS
`;

@Injectable()
export class MaxMembershipLookupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxMembershipLookupService.name);
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly membershipLookupBatchWindowMs: number;
  private readonly maxChatBackoffMs: number;
  private readonly chatBackoffResetMs: number;
  private readonly hotChannelFailureThreshold: number;
  private readonly hotChannelWindowMs: number;
  private readonly hotChannelDurationMs: number;
  private readonly hotChannelPositiveFreshTtlSec: number;
  private readonly hotChannelBatchWindowMs: number;
  private readonly requiredSubscriptionTerminalChatBackoffMs: number;
  private readonly lookupTimeoutMsByTrafficClass: Record<MaxApiTrafficClass, number>;
  private readonly membershipRetentionPositiveTtlSec: number;
  private readonly membershipRetentionNegativeTtlSec: number;
  private readonly membershipInvalidationFenceTtlMs: number;
  private readonly botScopedCacheEnabled: boolean;
  private readonly botScopedCacheDualReadEnabled: boolean;
  private readonly botScopedCacheDualWriteEnabled: boolean;
  private readonly memoryCache = new Map<string, MembershipCacheSnapshot>();
  private memoryCacheSweepIterator: IterableIterator<[string, MembershipCacheSnapshot]> | null =
    null;
  private memoryCacheSweepRemaining = 0;
  private memoryCacheSweepTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<MaxMembershipLookupResolution>>();
  private readonly backoffUntilMs = new Map<string, MembershipLookupBackoff>();
  private readonly chatBackoffUntilMs = new Map<string, number>();
  private readonly chatBackoffState = new Map<string, ChatBackoffState>();
  private readonly hotChannelStates = new Map<string, HotChannelState>();
  // Invalidation epochs cancel stale work; probe sequences select cache writers across policies.
  private readonly cacheEpochs = new Map<string, CacheEpochState>();
  private readonly activeCacheEpochReaders = new Map<string, number>();
  private cacheEpochSweepIterator: IterableIterator<[string, CacheEpochState]> | null = null;
  private cacheEpochSweepRemaining = 0;
  private cacheEpochSweepTimer: NodeJS.Timeout | null = null;
  private destroying = false;
  private readonly seenInvalidationIds = new Map<string, number>();
  private readonly latestProbeSequenceByCacheKey = new Map<string, number>();
  private readonly pendingSingleLookupBatches = new Map<string, PendingSingleLookupBatch>();
  private readonly lookupIssues = new Map<string, MaxMembershipLookupIssue>();
  private nextProbeSequence = 0;
  private lastInvalidatedAtMs = 0;
  private nextSeenInvalidationCleanupAtMs = 0;
  private lastRedisWriteFailureLogAtMs = 0;
  private lastRedisInvalidationFailureLogAtMs = 0;

  constructor(
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.subscriber = this.redis.duplicate({ enableReadyCheck: false });
    this.membershipLookupBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS'),
      20,
      0,
    );
    this.maxChatBackoffMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_MAX_MS'),
      60_000,
      1_000,
    );
    this.chatBackoffResetMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_RESET_MS'),
      45_000,
      1_000,
    );
    this.hotChannelFailureThreshold = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_FAILURE_THRESHOLD'),
      2,
    );
    this.hotChannelWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_WINDOW_MS'),
      45_000,
      1_000,
    );
    this.hotChannelDurationMs =
      this.readConfigInt(configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_DURATION_SEC'), 120) *
      1_000;
    this.hotChannelPositiveFreshTtlSec = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_POSITIVE_TTL_SEC'),
      90,
      MEMBERSHIP_LOOKUP_POLICIES.moderation_required_subscription.positiveFreshTtlSec,
    );
    this.hotChannelBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS'),
      25,
      this.membershipLookupBatchWindowMs,
    );
    this.requiredSubscriptionTerminalChatBackoffMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_REQUIRED_SUBSCRIPTION_TERMINAL_BACKOFF_MS'),
      REQUIRED_SUBSCRIPTION_TERMINAL_CHAT_BACKOFF_MS,
      1_000,
    );
    this.lookupTimeoutMsByTrafficClass = {
      critical: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL'),
        1_500,
      ),
      interactive: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE'),
        3_000,
      ),
      background: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_BACKGROUND'),
        5_000,
      ),
    };
    this.membershipRetentionPositiveTtlSec = Math.max(
      BASE_MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC,
      this.hotChannelPositiveFreshTtlSec,
    );
    this.membershipRetentionNegativeTtlSec = BASE_MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC;
    this.membershipInvalidationFenceTtlMs =
      Math.max(this.membershipRetentionPositiveTtlSec, this.membershipRetentionNegativeTtlSec) *
        1_000 +
      MEMBERSHIP_INVALIDATION_GUARD_TTL_MS;
    this.botScopedCacheEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_ENABLED',
      true,
    );
    this.botScopedCacheDualReadEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_DUAL_READ',
      true,
    );
    this.botScopedCacheDualWriteEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_DUAL_WRITE',
      true,
    );
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== MEMBERSHIP_INVALIDATION_CHANNEL) {
        return;
      }

      const normalized = this.parseInvalidationMessage(payload);
      if (!normalized) {
        return;
      }

      this.applyLocalInvalidation(
        normalized.chatId,
        normalized.userIds,
        normalized.invalidatedAtMs,
        normalized.invalidationId,
      );
    });
    await this.subscriber.subscribe(MEMBERSHIP_INVALIDATION_CHANNEL);
    this.scheduleCacheEpochSweep(MEMBERSHIP_CACHE_EPOCH_SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy() {
    this.destroying = true;
    if (this.cacheEpochSweepTimer) {
      clearTimeout(this.cacheEpochSweepTimer);
      this.cacheEpochSweepTimer = null;
    }
    this.cacheEpochSweepIterator = null;
    this.cacheEpochSweepRemaining = 0;
    if (this.memoryCacheSweepTimer) {
      clearTimeout(this.memoryCacheSweepTimer);
      this.memoryCacheSweepTimer = null;
    }
    this.memoryCacheSweepIterator = null;
    this.memoryCacheSweepRemaining = 0;
    this.memoryCache.clear();
    this.clearPendingSingleLookupBatchTimers();
    await this.subscriber.quit();
    await this.redis.quit();
  }

  async invalidateMemberships(chatId: string, userIds: readonly string[]): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return;
    }

    const invalidatedAtMs = this.createInvalidatedAtMs();
    const invalidationId = randomUUID();
    const payload = JSON.stringify({
      chatId: normalizedChatId,
      userIds: normalizedUserIds,
      invalidatedAtMs,
      invalidationId,
    });
    this.applyLocalInvalidation(
      normalizedChatId,
      normalizedUserIds,
      invalidatedAtMs,
      invalidationId,
    );
    try {
      await this.invalidateRedisSnapshotsAndPublish(
        normalizedChatId,
        normalizedUserIds,
        invalidatedAtMs,
        payload,
      );
    } catch (error: unknown) {
      this.logRedisInvalidationFailure(normalizedChatId, normalizedUserIds, error);
      throw error;
    }
  }

  async getMembership(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<boolean | null> {
    const resolution = await this.getMembershipResolution(chatId, userId, policyName, options);
    return resolution.membership;
  }

  async getMembershipResolution(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<MaxMembershipLookupResolution> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return { membership: null, fresh: false };
    }

    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return { membership: false, fresh: true };
    }

    const membershipByUserId = await this.getMembershipResolutions(
      normalizedChatId,
      [normalizedUserId],
      policyName,
      options,
    );
    return membershipByUserId.get(normalizedUserId) ?? { membership: null, fresh: false };
  }

  async getMemberships(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<Map<string, boolean | null>> {
    const resolutions = await this.getMembershipResolutions(chatId, userIds, policyName, options);
    const memberships = new Map<string, boolean | null>();
    for (const [userId, resolution] of resolutions) {
      memberships.set(userId, resolution.membership);
    }
    return memberships;
  }

  async getMembershipResolutions(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<Map<string, MaxMembershipLookupResolution>> {
    const normalizedChatId = chatId.trim();
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    const results = new Map<string, MaxMembershipLookupResolution>();
    if (!normalizedChatId || normalizedUserIds.length === 0) {
      return results;
    }

    const now = Date.now();
    const requestedBotId = typeof options.botId === 'string' ? options.botId.trim() : '';
    const requireReadRoute = policyName === 'moderation_required_subscription';
    let lookupBotId: string | null = this.normalizeBotScopedCacheBotId(requestedBotId);
    if (
      !lookupBotId &&
      (this.botScopedCacheEnabled || requireReadRoute) &&
      normalizedUserIds.length > 0 &&
      this.maxBotLinkService
    ) {
      lookupBotId = await this.resolveLookupBotId(normalizedChatId, requireReadRoute);
      // FLAG: A refused target route cannot borrow a default token or retained
      // negative membership to authorize a subscription notice or sanction.
      if (requireReadRoute && !lookupBotId)
        return new Map(
          normalizedUserIds.map((userId) => [userId, { membership: null, fresh: false }]),
        );
    }
    const basePolicy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const policy = this.resolveEffectivePolicy(normalizedChatId, policyName, basePolicy, now);
    const allowStaleOnError = options.allowStaleOnError ?? policy.allowStaleOnError;
    // FLAG: A fresh eligibility decision cannot share a probe that may read the transport cache.
    const bypassTransportCache =
      requireReadRoute || (options.forceRefresh === true && !allowStaleOnError);
    const chatBackoffKey = this.buildChatBackoffKey(normalizedChatId, policyName, lookupBotId);
    const pendingPromises = new Map<string, Promise<MaxMembershipLookupResolution>>();
    const usersToLookup: string[] = [];
    const cacheKeyByUserId = new Map(
      normalizedUserIds.map((userId) => [
        userId,
        this.buildCacheKey(normalizedChatId, userId, lookupBotId, policyName),
      ]),
    );
    const legacyCacheKeyByUserId = new Map(
      normalizedUserIds.map((userId) => [
        userId,
        this.buildLegacyCacheKey(normalizedChatId, userId),
      ]),
    );
    let unresolvedUserIds: string[] = [];

    for (const userId of normalizedUserIds) {
      const cacheKey = cacheKeyByUserId.get(userId)!;
      const freshMemorySnapshot = !options.forceRefresh
        ? this.readFreshMemorySnapshot(cacheKey, policy, now)
        : null;
      if (freshMemorySnapshot) {
        results.set(userId, { membership: freshMemorySnapshot.isMember, fresh: true });
        continue;
      }

      unresolvedUserIds.push(userId);
    }

    if (!options.forceRefresh && unresolvedUserIds.length > 0) {
      const redisReadEpochByCacheKey = this.retainCacheEpochs(
        unresolvedUserIds.map((userId) => cacheKeyByUserId.get(userId)!),
      );
      try {
        const redisReadKeys = unresolvedUserIds.flatMap((userId) =>
          this.buildRedisReadKeys(
            cacheKeyByUserId.get(userId)!,
            legacyCacheKeyByUserId.get(userId)!,
            lookupBotId,
            policyName,
          ),
        );
        const redisSnapshots = await this.readRedisSnapshots(redisReadKeys);
        const stillUnresolvedUserIds: string[] = [];

        for (const userId of unresolvedUserIds) {
          const cacheKey = cacheKeyByUserId.get(userId)!;
          const legacyCacheKey = legacyCacheKeyByUserId.get(userId)!;
          if (!this.hasSameCacheEpoch(cacheKey, redisReadEpochByCacheKey.get(cacheKey) ?? 0)) {
            stillUnresolvedUserIds.push(userId);
            continue;
          }
          const redisSnapshot =
            redisSnapshots.get(cacheKey) ??
            (this.shouldReadLegacyCache(lookupBotId) ? redisSnapshots.get(legacyCacheKey) : null) ??
            null;
          if (redisSnapshot) {
            const selectedSnapshot = this.storeMemorySnapshot(cacheKey, redisSnapshot);
            if (this.isSnapshotFresh(selectedSnapshot, policy, now)) {
              results.set(userId, { membership: selectedSnapshot.isMember, fresh: true });
              continue;
            }
          }

          stillUnresolvedUserIds.push(userId);
        }

        unresolvedUserIds = stillUnresolvedUserIds;
      } finally {
        for (const cacheKey of redisReadEpochByCacheKey.keys()) {
          this.releaseCacheEpoch(cacheKey);
        }
      }
    }

    for (const userId of unresolvedUserIds) {
      const cacheKey = cacheKeyByUserId.get(userId)!;
      const backoff = this.backoffUntilMs.get(cacheKey);
      if (backoff && backoff.untilMs > now) {
        const quotaScopeBotId = backoff.localQuotaScope
          ? await this.resolveLocalQuotaScopeBotId(normalizedChatId, lookupBotId)
          : undefined;
        const scope =
          quotaScopeBotId !== undefined
            ? { chatId: normalizedChatId, userId, policyName, botId: quotaScopeBotId }
            : undefined;
        results.set(
          userId,
          withMembershipGetLocalQuotaProvenance(
            {
              membership: this.resolveLookupFallback(
                normalizedChatId,
                policyName,
                cacheKey,
                allowStaleOnError,
                now,
              ),
              fresh: false,
            },
            backoff.localQuotaScope &&
              scope &&
              sameMembershipLookupScope(backoff.localQuotaScope, scope)
              ? scope
              : undefined,
          ),
        );
        continue;
      }
      if (backoff) this.backoffUntilMs.delete(cacheKey);

      const inFlightKey = this.buildInFlightKey(
        cacheKey,
        policyName,
        allowStaleOnError,
        bypassTransportCache,
      );
      const inFlight = this.inFlight.get(inFlightKey);
      if (inFlight) {
        pendingPromises.set(userId, inFlight);
        continue;
      }

      const chatBackoffUntilMs = this.chatBackoffUntilMs.get(chatBackoffKey) ?? 0;
      if (chatBackoffUntilMs > now) {
        results.set(userId, {
          membership: this.resolveLookupFallback(
            normalizedChatId,
            policyName,
            cacheKey,
            allowStaleOnError,
            now,
          ),
          fresh: false,
        });
        continue;
      }

      usersToLookup.push(userId);
    }

    if (usersToLookup.length > 0 && !lookupBotId && this.maxBotLinkService) {
      lookupBotId = await this.resolveLookupBotId(normalizedChatId, requireReadRoute);
    }

    if (usersToLookup.length === 1) {
      const [userId] = usersToLookup;
      pendingPromises.set(
        userId,
        this.enqueueSingleLookupBatch(
          normalizedChatId,
          userId,
          policyName,
          allowStaleOnError,
          lookupBotId,
          bypassTransportCache,
        ),
      );
    } else if (usersToLookup.length > 1) {
      const batchPromises = this.createBatchLookupPromises(
        normalizedChatId,
        usersToLookup,
        policyName,
        allowStaleOnError,
        lookupBotId,
        bypassTransportCache,
      );
      for (const [userId, promise] of batchPromises) {
        pendingPromises.set(userId, promise);
      }
    }

    for (const userId of normalizedUserIds) {
      if (results.has(userId)) {
        continue;
      }

      const promise = pendingPromises.get(userId);
      const resolution = promise ? await promise : { membership: null, fresh: false };
      const origin = membershipGetLocalQuotaResolutions.get(resolution);
      const quotaScopeBotId = origin
        ? await this.resolveLocalQuotaScopeBotId(normalizedChatId, lookupBotId)
        : undefined;
      results.set(
        userId,
        origin &&
          (quotaScopeBotId === undefined ||
            !sameMembershipLookupScope(origin, {
              chatId: normalizedChatId,
              userId,
              policyName,
              botId: quotaScopeBotId,
            }))
          ? { membership: resolution.membership, fresh: resolution.fresh }
          : resolution,
      );
    }

    const unresolvedIds = normalizedUserIds.filter((id) => !results.get(id)?.fresh);
    if (!requestedBotId && lookupBotId && unresolvedIds.length > 0 && this.maxBotLinkService) {
      // FLAG: Retry only a different currently selected read route, once. Explicit token requests
      // never switch identities; no unknown membership result can authorize a sanction.
      try {
        const peerBotId = await this.resolveLookupBotId(normalizedChatId, requireReadRoute);
        if (peerBotId && peerBotId !== lookupBotId) {
          const peerResults = await this.getMembershipResolutions(
            normalizedChatId,
            unresolvedIds,
            policyName,
            {
              ...options,
              botId: peerBotId,
              forceRefresh: true,
              allowStaleOnError: false,
            },
          );
          for (const [id, resolution] of peerResults) results.set(id, resolution);
        }
      } catch {
        // Preserve the observed unknown result if route resolution itself is unavailable.
      }
    }

    return results;
  }

  getLookupIssue(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): MaxMembershipLookupIssue | null {
    const key = this.buildChatPolicyKey(chatId.trim(), policyName);
    const issue = this.lookupIssues.get(key) ?? null;
    if (!issue) {
      return null;
    }

    if (issue.expiresAtMs <= now) {
      this.lookupIssues.delete(key);
      return null;
    }

    return { ...issue };
  }

  private enqueueSingleLookupBatch(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    botId: string | null,
    bypassTransportCache: boolean,
  ): Promise<MaxMembershipLookupResolution> {
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const batchKey = this.buildSingleLookupBatchKey(
      chatId,
      policyName,
      botId,
      allowStaleOnError,
      bypassTransportCache,
    );
    let batch = this.pendingSingleLookupBatches.get(batchKey);
    if (!batch) {
      batch = {
        chatId,
        policy,
        policyName,
        botId,
        bypassTransportCache,
        lookups: new Map(),
        scheduled: false,
        timeout: null,
      };
      this.pendingSingleLookupBatches.set(batchKey, batch);
    } else if (!batch.botId && botId) {
      batch.botId = botId;
    }

    const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
    const inFlightKey = this.buildInFlightKey(
      cacheKey,
      policyName,
      allowStaleOnError,
      bypassTransportCache,
    );
    const cacheEpoch = this.retainCacheEpoch(cacheKey);
    const probeSequence = this.beginProbe(cacheKey);
    const lookupPromise = new Promise<MaxMembershipLookupResolution>((resolve) => {
      batch!.lookups.set(userId, {
        cacheKey,
        cacheEpoch,
        probeSequence,
        allowStaleOnError,
        resolve,
      });
    });

    const trackedPromise = lookupPromise.finally(() => {
      if (this.inFlight.get(inFlightKey) === trackedPromise) {
        this.inFlight.delete(inFlightKey);
      }
      this.finishProbe(cacheKey, probeSequence);
      this.releaseCacheEpoch(cacheKey);
    });

    this.inFlight.set(inFlightKey, trackedPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      const batchWindowMs = this.resolveSingleLookupBatchWindowMs(chatId, policyName);
      if (batchWindowMs === 0) {
        void Promise.resolve().then(() => this.flushPendingSingleLookupBatch(batchKey));
      } else {
        batch.timeout = setTimeout(() => {
          batch!.timeout = null;
          void this.flushPendingSingleLookupBatch(batchKey);
        }, batchWindowMs);
        batch.timeout.unref?.();
      }
    }

    return trackedPromise;
  }

  private async flushPendingSingleLookupBatch(batchKey: string): Promise<void> {
    const batch = this.pendingSingleLookupBatches.get(batchKey);
    if (!batch) {
      return;
    }

    this.pendingSingleLookupBatches.delete(batchKey);
    if (batch.timeout) {
      clearTimeout(batch.timeout);
      batch.timeout = null;
    }
    const userIds = [...batch.lookups.keys()];
    if (userIds.length === 0) {
      return;
    }

    const probeStartedAt = new Date();
    let membershipGetQuotaRefusal: MaxApiInternalRateLimitError | undefined;
    try {
      const accessByUserId = await this.executeLookupWithGuard(
        async () => {
          try {
            return await this.maxClient.getChatMembersAccess(batch.chatId, userIds, {
              trafficClass: batch.policy.trafficClass,
              timeoutMs: this.resolveLookupTimeoutMs(batch.policy.trafficClass),
              ...(batch.bypassTransportCache ? { bypassCache: true } : {}),
              ...(batch.policy.sourceTag ? { sourceTag: batch.policy.sourceTag } : {}),
              ...(batch.policy.ignoreFailureMetricStatuses
                ? { ignoreFailureMetricStatuses: batch.policy.ignoreFailureMetricStatuses }
                : {}),
              ...(batch.botId ? { botId: batch.botId } : {}),
            });
          } catch (error: unknown) {
            if (isMembershipGetLocalQuotaRefusal(error)) membershipGetQuotaRefusal = error;
            throw error;
          }
        },
        {
          chatId: batch.chatId,
          userIds,
          policyName: batch.policyName,
          trafficClass: batch.policy.trafficClass,
        },
      );
      const checkedAtMs = Date.now();
      if (this.hasAuthoritativePendingLookup(batch.lookups.values())) {
        this.clearChatBackoff(batch.chatId, batch.policyName, batch.botId);
        this.clearHotChannelMode(batch.chatId, batch.policyName);
        this.clearLookupIssue(batch.chatId, batch.policyName);
      }

      for (const [userId, lookup] of batch.lookups.entries()) {
        if (!this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
          lookup.resolve({ membership: null, fresh: false });
          continue;
        }
        const isMember = accessByUserId.has(userId);
        const probeStartedAtMs = this.resolveProbeStartedAtMs(
          lookup.cacheKey,
          probeStartedAt.getTime(),
        );
        const snapshot: MembershipCacheSnapshot = {
          isMember,
          checkedAtMs: Math.max(checkedAtMs, probeStartedAtMs),
          probeStartedAtMs,
          writerPolicy: batch.policyName,
        };
        if (this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)) {
          this.storeSnapshot(lookup.cacheKey, snapshot, batch.policyName);
          this.backoffUntilMs.delete(lookup.cacheKey);
        }
        lookup.resolve({ membership: isMember, fresh: true });
      }
    } catch (error: unknown) {
      const localQuota =
        error === membershipGetQuotaRefusal && membershipGetQuotaRefusal !== undefined;
      const transient = localQuota || this.isTransientLookupError(error);
      const terminalBackoffMs = this.resolveTerminalChatBackoffMs(batch.policyName);
      const terminalAccess = this.isTerminalChatAccessError(error);
      const authoritative = this.hasAuthoritativePendingLookup(batch.lookups.values());
      const terminal = authoritative && terminalBackoffMs > 0 && terminalAccess;
      if (authoritative && terminalAccess) {
        await this.persistTerminalBotAccessProbe({
          chatId: batch.chatId,
          botId: batch.botId,
          policyName: batch.policyName,
          probeStartedAt,
          error,
        });
      }
      let appliedBackoffMs = 0;
      if (terminal) {
        const appliedBackoff = this.applyTerminalChatBackoff(
          batch.chatId,
          batch.policyName,
          terminalBackoffMs,
          batch.botId,
        );
        appliedBackoffMs = appliedBackoff.backoffMs;
      } else if (authoritative && transient) {
        const appliedBackoff = this.applyChatBackoff(
          batch.chatId,
          batch.policyName,
          batch.policy,
          batch.botId,
        );
        appliedBackoffMs = appliedBackoff.backoffMs;
        this.recordHotChannelFailure(batch.chatId, batch.policyName);
        for (const [userId, lookup] of batch.lookups) {
          if (
            this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch) &&
            this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)
          ) {
            this.backoffUntilMs.set(lookup.cacheKey, {
              untilMs: appliedBackoff.backoffUntilMs,
              ...(localQuota
                ? {
                    localQuotaScope: {
                      chatId: batch.chatId,
                      userId,
                      policyName: batch.policyName,
                      botId: batch.botId,
                    },
                  }
                : {}),
            });
          }
        }
      }

      if (terminal || (authoritative && transient)) {
        this.recordLookupIssue(batch.chatId, batch.policyName, error, {
          kind: terminal ? 'terminal' : 'transient',
          retryAfterMs: appliedBackoffMs,
        });
      }

      this.logLookupError(error, {
        chatId: batch.chatId,
        userIds,
        policyName: batch.policyName,
        backoffMs: appliedBackoffMs,
      });

      for (const [userId, lookup] of batch.lookups) {
        if (!this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
          lookup.resolve({ membership: null, fresh: false });
          continue;
        }
        lookup.resolve(
          withMembershipGetLocalQuotaProvenance(
            {
              membership: this.resolveLookupFallback(
                batch.chatId,
                batch.policyName,
                lookup.cacheKey,
                lookup.allowStaleOnError,
              ),
              fresh: false,
            },
            localQuota && this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)
              ? {
                  chatId: batch.chatId,
                  userId,
                  policyName: batch.policyName,
                  botId: batch.botId,
                }
              : undefined,
          ),
        );
      }
    }
  }

  private createBatchLookupPromises(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    botId: string | null,
    bypassTransportCache: boolean,
  ): Map<string, Promise<MaxMembershipLookupResolution>> {
    const normalizedUserIds = Array.from(new Set(userIds));
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const cacheEpochByKey = this.retainCacheEpochs(
      normalizedUserIds.map((userId) => this.buildCacheKey(chatId, userId, botId, policyName)),
    );
    const probeSequenceByKey = new Map(
      normalizedUserIds.map((userId) => {
        const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
        return [cacheKey, this.beginProbe(cacheKey)] as const;
      }),
    );
    const batchLookupPromise = (async () => {
      const probeStartedAt = new Date();
      let membershipGetQuotaRefusal: MaxApiInternalRateLimitError | undefined;
      try {
        const accessByUserId = await this.executeLookupWithGuard(
          async () => {
            try {
              return await this.maxClient.getChatMembersAccess(chatId, normalizedUserIds, {
                trafficClass: policy.trafficClass,
                timeoutMs: this.resolveLookupTimeoutMs(policy.trafficClass),
                ...(bypassTransportCache ? { bypassCache: true } : {}),
                ...(policy.sourceTag ? { sourceTag: policy.sourceTag } : {}),
                ...(policy.ignoreFailureMetricStatuses
                  ? { ignoreFailureMetricStatuses: policy.ignoreFailureMetricStatuses }
                  : {}),
                ...(botId ? { botId } : {}),
              });
            } catch (error: unknown) {
              if (isMembershipGetLocalQuotaRefusal(error)) membershipGetQuotaRefusal = error;
              throw error;
            }
          },
          {
            chatId,
            userIds: normalizedUserIds,
            policyName,
            trafficClass: policy.trafficClass,
          },
        );
        const checkedAtMs = Date.now();
        const results = new Map<string, MaxMembershipLookupResolution>();
        if (
          normalizedUserIds.some((userId) => {
            const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
            return (
              this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
              this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
            );
          })
        ) {
          this.clearChatBackoff(chatId, policyName, botId);
          this.clearHotChannelMode(chatId, policyName);
          this.clearLookupIssue(chatId, policyName);
        }

        for (const userId of normalizedUserIds) {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          if (!this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
            results.set(userId, { membership: null, fresh: false });
            continue;
          }
          const isMember = accessByUserId.has(userId);
          const probeStartedAtMs = this.resolveProbeStartedAtMs(cacheKey, probeStartedAt.getTime());
          const snapshot: MembershipCacheSnapshot = {
            isMember,
            checkedAtMs: Math.max(checkedAtMs, probeStartedAtMs),
            probeStartedAtMs,
            writerPolicy: policyName,
          };
          if (this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)) {
            this.storeSnapshot(cacheKey, snapshot, policyName);
            this.backoffUntilMs.delete(cacheKey);
          }
          results.set(userId, { membership: isMember, fresh: true });
        }

        return results;
      } catch (error: unknown) {
        const localQuota =
          error === membershipGetQuotaRefusal && membershipGetQuotaRefusal !== undefined;
        const transient = localQuota || this.isTransientLookupError(error);
        const terminalBackoffMs = this.resolveTerminalChatBackoffMs(policyName);
        const terminalAccess = this.isTerminalChatAccessError(error);
        const authoritative = normalizedUserIds.some((userId) => {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          return (
            this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
            this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
          );
        });
        const terminal = authoritative && terminalBackoffMs > 0 && terminalAccess;
        if (authoritative && terminalAccess) {
          await this.persistTerminalBotAccessProbe({
            chatId,
            botId,
            policyName,
            probeStartedAt,
            error,
          });
        }
        let appliedBackoffMs = 0;
        if (terminal) {
          const appliedBackoff = this.applyTerminalChatBackoff(
            chatId,
            policyName,
            terminalBackoffMs,
            botId,
          );
          appliedBackoffMs = appliedBackoff.backoffMs;
        } else if (authoritative && transient) {
          const appliedBackoff = this.applyChatBackoff(chatId, policyName, policy, botId);
          appliedBackoffMs = appliedBackoff.backoffMs;
          this.recordHotChannelFailure(chatId, policyName);
          for (const userId of normalizedUserIds) {
            const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
            if (
              this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
              this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
            ) {
              this.backoffUntilMs.set(cacheKey, {
                untilMs: appliedBackoff.backoffUntilMs,
                ...(localQuota ? { localQuotaScope: { chatId, userId, policyName, botId } } : {}),
              });
            }
          }
        }
        if (terminal || (authoritative && transient)) {
          this.recordLookupIssue(chatId, policyName, error, {
            kind: terminal ? 'terminal' : 'transient',
            retryAfterMs: appliedBackoffMs,
          });
        }
        this.logLookupError(error, {
          chatId,
          userIds: normalizedUserIds,
          policyName,
          backoffMs: appliedBackoffMs,
        });

        const results = new Map<string, MaxMembershipLookupResolution>();
        for (const userId of normalizedUserIds) {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          if (!this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
            results.set(userId, { membership: null, fresh: false });
            continue;
          }
          results.set(
            userId,
            withMembershipGetLocalQuotaProvenance(
              {
                membership: this.resolveLookupFallback(
                  chatId,
                  policyName,
                  cacheKey,
                  allowStaleOnError,
                ),
                fresh: false,
              },
              localQuota && this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
                ? { chatId, userId, policyName, botId }
                : undefined,
            ),
          );
        }
        return results;
      }
    })();

    const promises = new Map<string, Promise<MaxMembershipLookupResolution>>();
    for (const userId of normalizedUserIds) {
      const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
      const inFlightKey = this.buildInFlightKey(
        cacheKey,
        policyName,
        allowStaleOnError,
        bypassTransportCache,
      );
      const trackedPromise = batchLookupPromise
        .then((results) => results.get(userId) ?? { membership: null, fresh: false })
        .finally(() => {
          if (this.inFlight.get(inFlightKey) === trackedPromise) {
            this.inFlight.delete(inFlightKey);
          }
          this.finishProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0);
          this.releaseCacheEpoch(cacheKey);
        });
      this.inFlight.set(inFlightKey, trackedPromise);
      promises.set(userId, trackedPromise);
    }

    return promises;
  }

  private logLookupError(
    error: unknown,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      backoffMs: number;
    },
  ) {
    this.logger.warn(
      {
        chatId: context.chatId,
        userIds: context.userIds,
        policyName: context.policyName,
        backoffMs: context.backoffMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to resolve MAX membership',
    );
  }

  private async persistTerminalBotAccessProbe(params: {
    chatId: string;
    botId: string | null;
    policyName: MaxMembershipLookupPolicy;
    probeStartedAt: Date;
    error: unknown;
  }): Promise<void> {
    const botId = this.normalizeBotScopedCacheBotId(params.botId);
    const recordBotAccessProbe = this.maxBotLinkService?.recordBotAccessProbe;
    if (!botId || typeof recordBotAccessProbe !== 'function') {
      return;
    }

    try {
      await recordBotAccessProbe.call(this.maxBotLinkService, {
        chatId: params.chatId,
        botId,
        access: null,
        source: `membership_lookup_${params.policyName}`,
        checkedAt: params.probeStartedAt,
        lastErrorCode: this.resolveTerminalChatAccessErrorCode(params.error),
        allowMembershipRecovery: false,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          botId,
          policyName: params.policyName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist terminal MAX membership lookup bot access',
      );
    }
  }

  private async resolveLocalQuotaScopeBotId(
    chatId: string,
    botId: string | null,
  ): Promise<string | null | undefined> {
    if (botId || !this.maxBotLinkService) return botId;
    // FLAG: Legacy shared cache keys cannot lend another bot's local quota evidence.
    // Resolve this caller's route only to validate retained provenance; unknown stays unmarked.
    try {
      return await this.resolveLookupBotId(chatId);
    } catch {
      return undefined;
    }
  }

  private async resolveLookupBotId(
    chatId: string,
    requireReadRoute = false,
  ): Promise<string | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver.resolveBotRoute === 'function') {
      const route = await routeResolver.resolveBotRoute({
        purpose: 'read',
        chatId,
      });
      if (route.botId || requireReadRoute) {
        return route.botId;
      }
    }

    if (typeof this.maxBotLinkService.resolveBotIdForRead === 'function') {
      const botId = await this.maxBotLinkService.resolveBotIdForRead({ chatId });
      if (botId || requireReadRoute) {
        return botId;
      }
    }

    if (typeof this.maxBotLinkService.resolveBotIdForMemberAccess === 'function') {
      const botId = await this.maxBotLinkService.resolveBotIdForMemberAccess({ chatId });
      if (botId) {
        return botId;
      }
    }

    return (
      (await this.maxBotLinkService.resolveBotId({
        chatId,
      })) ?? null
    );
  }

  private parseInvalidationMessage(payload: string): {
    chatId: string;
    userIds: string[];
    invalidatedAtMs: number;
    invalidationId: string | null;
  } | null {
    try {
      const parsed = JSON.parse(payload) as {
        chatId?: unknown;
        invalidatedAtMs?: unknown;
        invalidationId?: unknown;
        userIds?: unknown;
      };
      if (
        (typeof parsed.chatId !== 'string' && typeof parsed.chatId !== 'number') ||
        !Array.isArray(parsed.userIds)
      ) {
        return null;
      }

      const chatId = String(parsed.chatId).trim();
      const userIds = Array.from(
        new Set(
          parsed.userIds
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter((value): value is string => value.length > 0),
        ),
      );
      if (!chatId || userIds.length === 0) {
        return null;
      }

      return {
        chatId,
        userIds,
        invalidatedAtMs:
          typeof parsed.invalidatedAtMs === 'number' && Number.isFinite(parsed.invalidatedAtMs)
            ? Math.trunc(parsed.invalidatedAtMs)
            : Date.now(),
        invalidationId:
          typeof parsed.invalidationId === 'string' && parsed.invalidationId.trim().length > 0
            ? parsed.invalidationId.trim()
            : null,
      };
    } catch {
      return null;
    }
  }

  private applyLocalInvalidation(
    chatId: string,
    userIds: readonly string[],
    invalidatedAtMs = Date.now(),
    invalidationId: string | null = null,
  ) {
    if (invalidationId && !this.markInvalidationSeen(invalidationId)) {
      return;
    }
    this.lastInvalidatedAtMs = Math.max(this.lastInvalidatedAtMs, invalidatedAtMs);
    const cacheKeys = new Set(this.cancelPendingSingleLookups(chatId, userIds));
    for (const userId of userIds) {
      for (const cacheKey of this.buildInvalidationCacheKeys(chatId, userId)) {
        cacheKeys.add(cacheKey);
      }
    }

    for (const cacheKey of cacheKeys) {
      this.memoryCache.delete(cacheKey);
      this.deleteInFlightLookups(cacheKey);
      this.backoffUntilMs.delete(cacheKey);
      this.bumpCacheEpoch(cacheKey, invalidatedAtMs);
    }
  }

  private cancelPendingSingleLookups(chatId: string, userIds: readonly string[]): string[] {
    const invalidatedUserIds = new Set(userIds);
    const cacheKeys = new Set<string>();

    for (const [batchKey, batch] of this.pendingSingleLookupBatches) {
      if (batch.chatId !== chatId) {
        continue;
      }

      for (const userId of invalidatedUserIds) {
        const lookup = batch.lookups.get(userId);
        if (!lookup) {
          continue;
        }
        batch.lookups.delete(userId);
        cacheKeys.add(lookup.cacheKey);
        lookup.resolve({ membership: null, fresh: false });
      }

      if (batch.lookups.size === 0) {
        if (batch.timeout) {
          clearTimeout(batch.timeout);
          batch.timeout = null;
        }
        this.pendingSingleLookupBatches.delete(batchKey);
      }
    }

    return [...cacheKeys];
  }

  private invalidateRedisSnapshotsAndPublish(
    chatId: string,
    userIds: readonly string[],
    invalidatedAtMs: number,
    payload: string,
  ): Promise<number> {
    const cacheKeys = Array.from(
      new Set(userIds.flatMap((userId) => this.buildInvalidationCacheKeys(chatId, userId))),
    );
    if (cacheKeys.length === 0) {
      return Promise.resolve(0);
    }

    return this.redis.eval(
      MEMBERSHIP_CACHE_INVALIDATE_SCRIPT,
      cacheKeys.length,
      ...cacheKeys,
      String(Math.trunc(invalidatedAtMs)),
      String(this.membershipInvalidationFenceTtlMs),
      MEMBERSHIP_CACHE_INVALIDATION_FENCE_SUFFIX,
      MEMBERSHIP_INVALIDATION_CHANNEL,
      payload,
    ) as Promise<number>;
  }

  private resolveLookupFallback(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    cacheKey: string,
    allowStaleOnError: boolean,
    now = Date.now(),
  ): boolean | null {
    if (!allowStaleOnError) {
      return null;
    }

    const snapshot = this.readRetainedMemorySnapshot(cacheKey, now);
    if (!snapshot) {
      return null;
    }

    if (
      snapshot.isMember ||
      !this.isHotChannelModeActive(chatId, policyName, now) ||
      policyName !== 'moderation_required_subscription'
    ) {
      return snapshot.isMember;
    }

    return null;
  }

  private storeSnapshot(
    cacheKey: string,
    snapshot: MembershipCacheSnapshot,
    policyName: MaxMembershipLookupPolicy,
  ) {
    const sharedCacheKey = this.deriveSharedCacheKey(cacheKey, policyName);
    const sharedWriterSequence =
      sharedCacheKey === cacheKey ? null : this.beginProbe(sharedCacheKey);
    try {
      this.storeMemorySnapshot(cacheKey, snapshot);
      // A bypassed moderation result may warm general reads; general reads never write its key.
      if (sharedCacheKey !== cacheKey) {
        this.storeMemorySnapshot(sharedCacheKey, snapshot);
      }
      const legacyCacheKey = this.deriveLegacyCacheKeyFromCacheKey(cacheKey);
      void this.writeRedisSnapshot(cacheKey, legacyCacheKey, snapshot, policyName)
        .then((rejectedCacheKeys) => {
          for (const rejectedCacheKey of rejectedCacheKeys) {
            if (this.memoryCache.get(rejectedCacheKey) === snapshot) {
              this.memoryCache.delete(rejectedCacheKey);
            }
          }
        })
        .catch((error: unknown) => {
          this.logRedisWriteFailure(cacheKey, error);
        });
    } finally {
      if (sharedWriterSequence !== null) {
        this.finishProbe(sharedCacheKey, sharedWriterSequence);
      }
    }
  }

  private readCacheEpoch(cacheKey: string, now = Date.now()): number {
    const state = this.cacheEpochs.get(cacheKey);
    if (!state) {
      return 0;
    }

    if (state.expiresAtMs <= now && !this.activeCacheEpochReaders.has(cacheKey)) {
      this.cacheEpochs.delete(cacheKey);
      return 0;
    }

    return state.epoch;
  }

  private hasSameCacheEpoch(cacheKey: string, epoch: number): boolean {
    return this.readCacheEpoch(cacheKey) === epoch;
  }

  // FLAG: A reader retains its invalidation epoch until it settles, including superseded
  // probes. Expiring a live reader's state can reset its epoch to zero and admit a stale result.
  private retainCacheEpoch(cacheKey: string): number {
    const epoch = this.readCacheEpoch(cacheKey);
    this.activeCacheEpochReaders.set(
      cacheKey,
      (this.activeCacheEpochReaders.get(cacheKey) ?? 0) + 1,
    );
    return epoch;
  }

  private retainCacheEpochs(cacheKeys: Iterable<string>): Map<string, number> {
    const epochs = new Map<string, number>();
    for (const cacheKey of cacheKeys) {
      if (!epochs.has(cacheKey)) {
        epochs.set(cacheKey, this.retainCacheEpoch(cacheKey));
      }
    }
    return epochs;
  }

  private releaseCacheEpoch(cacheKey: string): void {
    const remainingReaders = (this.activeCacheEpochReaders.get(cacheKey) ?? 0) - 1;
    if (remainingReaders > 0) {
      this.activeCacheEpochReaders.set(cacheKey, remainingReaders);
      return;
    }
    this.activeCacheEpochReaders.delete(cacheKey);
    this.readCacheEpoch(cacheKey);
  }

  private scheduleCacheEpochSweep(delayMs: number): void {
    if (this.destroying || this.cacheEpochSweepTimer) {
      return;
    }
    this.cacheEpochSweepTimer = setTimeout(() => {
      this.cacheEpochSweepTimer = null;
      this.sweepCacheEpochs();
      this.scheduleCacheEpochSweep(
        this.cacheEpochSweepIterator ? 1 : MEMBERSHIP_CACHE_EPOCH_SWEEP_INTERVAL_MS,
      );
    }, delayMs);
    this.cacheEpochSweepTimer.unref();
  }

  private sweepCacheEpochs(): void {
    if (!this.cacheEpochSweepIterator) {
      this.cacheEpochSweepIterator = this.cacheEpochs.entries();
      this.cacheEpochSweepRemaining = this.cacheEpochs.size;
    }
    const now = Date.now();
    // FLAG: A live Map iterator also visits new insertions. Fix each pass's budget so continuous
    // invalidations cannot prevent revisiting earlier entries after their expiration.
    for (
      let inspected = 0;
      inspected < MEMBERSHIP_CACHE_EPOCH_SWEEP_BATCH_SIZE && this.cacheEpochSweepRemaining > 0;
      inspected++
    ) {
      const next = this.cacheEpochSweepIterator.next();
      if (next.done) {
        this.cacheEpochSweepIterator = null;
        this.cacheEpochSweepRemaining = 0;
        return;
      }
      this.cacheEpochSweepRemaining--;
      const [cacheKey, state] = next.value;
      if (state.expiresAtMs <= now && !this.activeCacheEpochReaders.has(cacheKey)) {
        this.cacheEpochs.delete(cacheKey);
      }
    }
    if (this.cacheEpochSweepRemaining === 0) {
      this.cacheEpochSweepIterator = null;
    }
  }

  private scheduleMemoryCacheSweep(delayMs: number): void {
    if (this.destroying || this.memoryCacheSweepTimer || this.memoryCache.size === 0) {
      return;
    }
    this.memoryCacheSweepTimer = setTimeout(() => {
      this.memoryCacheSweepTimer = null;
      this.sweepMemoryCache();
      this.scheduleMemoryCacheSweep(
        this.memoryCacheSweepIterator ? 1 : MEMBERSHIP_CACHE_EPOCH_SWEEP_INTERVAL_MS,
      );
    }, delayMs);
    this.memoryCacheSweepTimer.unref();
  }

  private sweepMemoryCache(): void {
    if (!this.memoryCacheSweepIterator) {
      this.memoryCacheSweepIterator = this.memoryCache.entries();
      this.memoryCacheSweepRemaining = this.memoryCache.size;
    }
    const now = Date.now();
    // FLAG: Retained snapshots also order concurrent writers and provide stale fallback. Only
    // remove them after the full retention TTL; never evict fencing, readers, probes or backoff.
    // Fix the pass budget because a live Map iterator can visit newly appended entries.
    for (
      let inspected = 0;
      inspected < MEMBERSHIP_CACHE_EPOCH_SWEEP_BATCH_SIZE && this.memoryCacheSweepRemaining > 0;
      inspected++
    ) {
      const next = this.memoryCacheSweepIterator.next();
      if (next.done) {
        this.memoryCacheSweepRemaining = 0;
        break;
      }
      this.memoryCacheSweepRemaining--;
      const [cacheKey, snapshot] = next.value;
      if (snapshot.checkedAtMs + this.resolveRetentionTtlMs(snapshot.isMember) <= now) {
        this.memoryCache.delete(cacheKey);
      }
    }
    if (this.memoryCacheSweepRemaining === 0) {
      this.memoryCacheSweepIterator = null;
    }
  }

  private beginProbe(cacheKey: string): number {
    this.nextProbeSequence += 1;
    this.latestProbeSequenceByCacheKey.set(cacheKey, this.nextProbeSequence);
    return this.nextProbeSequence;
  }

  private isLatestProbe(cacheKey: string, probeSequence: number): boolean {
    return this.latestProbeSequenceByCacheKey.get(cacheKey) === probeSequence;
  }

  private finishProbe(cacheKey: string, probeSequence: number): void {
    if (this.isLatestProbe(cacheKey, probeSequence)) {
      this.latestProbeSequenceByCacheKey.delete(cacheKey);
    }
  }

  private hasAuthoritativePendingLookup(
    lookups: Iterable<Pick<PendingSingleLookup, 'cacheKey' | 'cacheEpoch' | 'probeSequence'>>,
  ): boolean {
    for (const lookup of lookups) {
      if (
        this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch) &&
        this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)
      ) {
        return true;
      }
    }
    return false;
  }

  private bumpCacheEpoch(cacheKey: string, invalidatedAtMs = Date.now()): number {
    const nextEpoch = this.readCacheEpoch(cacheKey) + 1;
    this.cacheEpochs.set(cacheKey, {
      epoch: nextEpoch,
      expiresAtMs: Date.now() + MEMBERSHIP_INVALIDATION_GUARD_TTL_MS,
      invalidatedAtMs,
    });
    return nextEpoch;
  }

  private createInvalidatedAtMs(): number {
    this.lastInvalidatedAtMs = Math.max(Date.now(), this.lastInvalidatedAtMs + 1);
    return this.lastInvalidatedAtMs;
  }

  private markInvalidationSeen(invalidationId: string, now = Date.now()): boolean {
    const seenUntilMs = this.seenInvalidationIds.get(invalidationId) ?? 0;
    if (seenUntilMs > now) {
      return false;
    }

    this.seenInvalidationIds.set(invalidationId, now + MEMBERSHIP_INVALIDATION_GUARD_TTL_MS);
    if (now >= this.nextSeenInvalidationCleanupAtMs) {
      this.nextSeenInvalidationCleanupAtMs = now + MEMBERSHIP_INVALIDATION_GUARD_TTL_MS;
      for (const [seenId, expiresAtMs] of this.seenInvalidationIds) {
        if (expiresAtMs <= now) {
          this.seenInvalidationIds.delete(seenId);
        }
      }
    }
    return true;
  }

  private async readRedisSnapshots(
    cacheKeys: readonly string[],
  ): Promise<Map<string, MembershipCacheSnapshot>> {
    const normalizedCacheKeys = Array.from(
      new Set(cacheKeys.filter((cacheKey): cacheKey is string => cacheKey.trim().length > 0)),
    );
    if (normalizedCacheKeys.length === 0) {
      return new Map();
    }

    const rawValues = await this.runRedisReadWithin(
      this.redis.mget(...normalizedCacheKeys).catch(() => normalizedCacheKeys.map(() => null)),
      MEMBERSHIP_REDIS_READ_TIMEOUT_MS,
    );
    if (!rawValues) {
      return new Map();
    }
    const snapshots = new Map<string, MembershipCacheSnapshot>();

    for (const [index, rawValue] of rawValues.entries()) {
      if (typeof rawValue !== 'string' || rawValue.length === 0) {
        continue;
      }

      const snapshot = this.parseRedisSnapshot(rawValue);
      if (!snapshot) {
        continue;
      }

      snapshots.set(normalizedCacheKeys[index]!, snapshot);
    }

    return snapshots;
  }

  private async writeRedisSnapshot(
    cacheKey: string,
    legacyCacheKey: string,
    snapshot: MembershipCacheSnapshot,
    policyName: MaxMembershipLookupPolicy,
  ): Promise<string[]> {
    const ttlSec = snapshot.isMember
      ? this.membershipRetentionPositiveTtlSec
      : this.membershipRetentionNegativeTtlSec;
    const redisWriteKeys = this.buildRedisWriteKeys(cacheKey, legacyCacheKey, policyName);
    const serializedSnapshot = JSON.stringify(snapshot);
    const rawResult = await this.redis.eval(
      MEMBERSHIP_CACHE_COMPARE_AND_SET_SCRIPT,
      redisWriteKeys.length,
      ...redisWriteKeys,
      serializedSnapshot,
      String(ttlSec),
      'moderation_required_subscription',
      MEMBERSHIP_CACHE_INVALIDATION_FENCE_SUFFIX,
    );
    if (!Array.isArray(rawResult) || rawResult.length !== redisWriteKeys.length) {
      throw new Error('Invalid membership cache compare-and-set result');
    }

    return redisWriteKeys.filter((_writeKey, index) => Number(rawResult[index]) !== 1);
  }

  private deriveLegacyCacheKeyFromCacheKey(cacheKey: string): string {
    if (cacheKey.startsWith(`${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:`)) {
      const parts = cacheKey.slice(`${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:`.length).split(':');
      if (parts.length >= 3) {
        const [chatId, userId] = parts;
        if (chatId && userId) {
          return this.buildLegacyCacheKey(chatId, userId);
        }
      }
    }

    return cacheKey;
  }

  private async runRedisReadWithin<T>(operation: Promise<T>, maxWaitMs: number): Promise<T | null> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), Math.max(1, Math.trunc(maxWaitMs)));
      timeout.unref?.();
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private parseRedisSnapshot(raw: string): MembershipCacheSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as {
        checkedAtMs?: unknown;
        isMember?: unknown;
        probeStartedAtMs?: unknown;
        writerPolicy?: unknown;
      };
      if (
        typeof parsed.checkedAtMs !== 'number' ||
        !Number.isFinite(parsed.checkedAtMs) ||
        typeof parsed.isMember !== 'boolean'
      ) {
        return null;
      }

      const snapshot: MembershipCacheSnapshot = {
        checkedAtMs: Math.trunc(parsed.checkedAtMs),
        isMember: parsed.isMember,
      };
      if (
        typeof parsed.probeStartedAtMs === 'number' &&
        Number.isFinite(parsed.probeStartedAtMs) &&
        parsed.probeStartedAtMs <= snapshot.checkedAtMs &&
        typeof parsed.writerPolicy === 'string' &&
        Object.prototype.hasOwnProperty.call(MEMBERSHIP_LOOKUP_POLICIES, parsed.writerPolicy)
      ) {
        snapshot.probeStartedAtMs = Math.trunc(parsed.probeStartedAtMs);
        snapshot.writerPolicy = parsed.writerPolicy as MaxMembershipLookupPolicy;
      }
      const retentionTtlMs = this.resolveRetentionTtlMs(snapshot.isMember);
      if (snapshot.checkedAtMs + retentionTtlMs <= Date.now()) {
        return null;
      }

      return snapshot;
    } catch {
      return null;
    }
  }

  private storeMemorySnapshot(
    cacheKey: string,
    incoming: MembershipCacheSnapshot,
  ): MembershipCacheSnapshot {
    const current = this.readRetainedMemorySnapshot(cacheKey);
    if (current && !this.shouldReplaceCacheSnapshot(current, incoming)) {
      return current;
    }

    if (!this.destroying) {
      this.memoryCache.set(cacheKey, incoming);
      this.scheduleMemoryCacheSweep(MEMBERSHIP_CACHE_EPOCH_SWEEP_INTERVAL_MS);
    }
    return incoming;
  }

  private shouldReplaceCacheSnapshot(
    current: MembershipCacheSnapshot,
    incoming: MembershipCacheSnapshot,
  ): boolean {
    if (incoming.probeStartedAtMs === undefined || incoming.writerPolicy === undefined) {
      return incoming.checkedAtMs > current.checkedAtMs;
    }
    if (current.probeStartedAtMs === undefined || current.writerPolicy === undefined) {
      return incoming.checkedAtMs >= current.checkedAtMs;
    }

    const incomingIsStrict = incoming.writerPolicy === 'moderation_required_subscription';
    const currentIsStrict = current.writerPolicy === 'moderation_required_subscription';
    if (incomingIsStrict && !currentIsStrict) {
      return incoming.checkedAtMs >= current.probeStartedAtMs;
    }
    if (!incomingIsStrict && currentIsStrict) {
      return incoming.probeStartedAtMs > current.checkedAtMs;
    }
    return (
      incoming.probeStartedAtMs > current.probeStartedAtMs ||
      (incoming.probeStartedAtMs === current.probeStartedAtMs &&
        incoming.checkedAtMs >= current.checkedAtMs)
    );
  }

  private resolveProbeStartedAtMs(cacheKey: string, probeStartedAtMs: number): number {
    const cacheEpoch = this.cacheEpochs.get(cacheKey);
    if (
      cacheEpoch &&
      cacheEpoch.expiresAtMs > Date.now() &&
      probeStartedAtMs <= cacheEpoch.invalidatedAtMs
    ) {
      return cacheEpoch.invalidatedAtMs + 1;
    }

    return probeStartedAtMs;
  }

  private readFreshMemorySnapshot(
    cacheKey: string,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): MembershipCacheSnapshot | null {
    const snapshot = this.readRetainedMemorySnapshot(cacheKey, now);
    if (!snapshot) {
      return null;
    }

    return this.isSnapshotFresh(snapshot, policy, now) ? snapshot : null;
  }

  private readRetainedMemorySnapshot(
    cacheKey: string,
    now = Date.now(),
  ): MembershipCacheSnapshot | null {
    const snapshot = this.memoryCache.get(cacheKey);
    if (!snapshot) {
      return null;
    }

    const retentionTtlMs = this.resolveRetentionTtlMs(snapshot.isMember);
    if (snapshot.checkedAtMs + retentionTtlMs <= now) {
      this.memoryCache.delete(cacheKey);
      return null;
    }

    return snapshot;
  }

  private isSnapshotFresh(
    snapshot: MembershipCacheSnapshot,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): boolean {
    const freshTtlMs =
      (snapshot.isMember ? policy.positiveFreshTtlSec : policy.negativeFreshTtlSec) * 1_000;
    return snapshot.checkedAtMs + freshTtlMs > now;
  }

  private resolveRetentionTtlMs(isMember: boolean): number {
    return (
      (isMember ? this.membershipRetentionPositiveTtlSec : this.membershipRetentionNegativeTtlSec) *
      1_000
    );
  }

  private buildCacheKey(
    chatId: string,
    userId: string,
    botId: string | null,
    policyName: MaxMembershipLookupPolicy,
  ): string {
    const normalizedBotId = this.normalizeBotScopedCacheBotId(botId);
    const baseKey =
      this.botScopedCacheEnabled && normalizedBotId
        ? `${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:${chatId}:${userId}:${normalizedBotId}`
        : this.buildLegacyCacheKey(chatId, userId);
    return policyName === 'moderation_required_subscription'
      ? `${baseKey}:policy:${policyName}`
      : baseKey;
  }

  private buildInFlightKey(
    cacheKey: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    bypassTransportCache: boolean,
  ): string {
    return `${cacheKey}|${policyName}|${allowStaleOnError ? 'stale' : 'strict'}|${bypassTransportCache ? 'remote' : 'cached'}`;
  }

  private deleteInFlightLookups(cacheKey: string): void {
    const keyPrefix = `${cacheKey}|`;
    for (const inFlightKey of this.inFlight.keys()) {
      if (inFlightKey.startsWith(keyPrefix)) {
        this.inFlight.delete(inFlightKey);
      }
    }
  }

  private buildLegacyCacheKey(chatId: string, userId: string): string {
    return `${MEMBERSHIP_CACHE_LEGACY_KEY_PREFIX}:${chatId}:${userId}`;
  }

  private buildSingleLookupBatchKey(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    botId: string | null,
    allowStaleOnError: boolean,
    bypassTransportCache: boolean,
  ): string {
    const normalizedBotId = this.normalizeBotScopedCacheBotId(botId);
    const routeKey = normalizedBotId
      ? `${this.buildChatPolicyKey(chatId, policyName)}:${normalizedBotId}`
      : this.buildChatPolicyKey(chatId, policyName);
    return `${routeKey}:${allowStaleOnError ? 'stale' : 'strict'}:${bypassTransportCache ? 'remote' : 'cached'}`;
  }

  private shouldReadLegacyCache(botId: string | null): boolean {
    return (
      this.botScopedCacheDualReadEnabled &&
      (!this.botScopedCacheEnabled || !this.normalizeBotScopedCacheBotId(botId))
    );
  }

  private buildRedisReadKeys(
    primaryCacheKey: string,
    legacyCacheKey: string,
    botId: string | null,
    policyName: MaxMembershipLookupPolicy,
  ): string[] {
    if (policyName === 'moderation_required_subscription') {
      return [primaryCacheKey];
    }
    if (primaryCacheKey === legacyCacheKey) {
      return [primaryCacheKey];
    }

    if (this.shouldReadLegacyCache(botId)) {
      return [primaryCacheKey, legacyCacheKey];
    }

    return [primaryCacheKey];
  }

  private buildRedisWriteKeys(
    primaryCacheKey: string,
    legacyCacheKey: string,
    policyName: MaxMembershipLookupPolicy,
  ): string[] {
    if (policyName === 'moderation_required_subscription') {
      return Array.from(
        new Set([primaryCacheKey, this.deriveSharedCacheKey(primaryCacheKey, policyName)]),
      );
    }
    if (primaryCacheKey === legacyCacheKey || !this.botScopedCacheDualWriteEnabled) {
      return [primaryCacheKey];
    }

    return [primaryCacheKey, legacyCacheKey];
  }

  private deriveSharedCacheKey(cacheKey: string, policyName: MaxMembershipLookupPolicy): string {
    if (policyName !== 'moderation_required_subscription') {
      return cacheKey;
    }

    const suffix = `:policy:${policyName}`;
    return cacheKey.endsWith(suffix) ? cacheKey.slice(0, -suffix.length) : cacheKey;
  }

  private buildInvalidationCacheKeys(
    chatId: string,
    userId: string,
    botId?: string | null,
  ): string[] {
    const keys = new Set<string>([this.buildLegacyCacheKey(chatId, userId)]);
    const explicitBotId = this.normalizeBotScopedCacheBotId(botId ?? null);
    for (const policyName of Object.keys(
      MEMBERSHIP_LOOKUP_POLICIES,
    ) as MaxMembershipLookupPolicy[]) {
      keys.add(this.buildCacheKey(chatId, userId, explicitBotId, policyName));
    }

    if (this.botScopedCacheEnabled) {
      for (const configuredBotId of this.resolveConfiguredBotIds()) {
        for (const policyName of Object.keys(
          MEMBERSHIP_LOOKUP_POLICIES,
        ) as MaxMembershipLookupPolicy[]) {
          keys.add(this.buildCacheKey(chatId, userId, configuredBotId, policyName));
        }
      }
    }

    return [...keys];
  }

  private normalizeBotScopedCacheBotId(botId: string | null | undefined): string | null {
    const normalized = typeof botId === 'string' ? botId.trim() : '';
    if (!normalized) {
      return null;
    }

    return this.maxBotRegistry?.getBotById(normalized)?.id ?? normalized;
  }

  private resolveConfiguredBotIds(): string[] {
    const configuredBotIds = new Set<string>();
    for (const bot of this.maxBotRegistry?.getAllBots() ?? []) {
      configuredBotIds.add(bot.id);
    }
    const defaultBotId = this.maxBotLinkService?.getDefaultBotId?.();
    if (typeof defaultBotId === 'string' && defaultBotId.trim()) {
      configuredBotIds.add(defaultBotId.trim());
    }
    return [...configuredBotIds];
  }

  private buildChatPolicyKey(chatId: string, policyName: MaxMembershipLookupPolicy): string {
    return `max:membership:chat:v1:${policyName}:${chatId}`;
  }

  private buildChatBackoffKey(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    botId: string | null,
  ): string {
    // FLAG: A denied or throttled token must not prevent a healthy peer from reading this target.
    return `${this.buildChatPolicyKey(chatId, policyName)}:bot:${botId ?? 'default'}`;
  }

  private applyChatBackoff(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
    botId: string | null,
  ): {
    backoffMs: number;
    backoffUntilMs: number;
  } {
    const cacheKey = this.buildChatBackoffKey(chatId, policyName, botId);
    const now = Date.now();
    const previousState = this.chatBackoffState.get(cacheKey);
    const failureCount =
      previousState && now - previousState.lastFailureAtMs <= this.chatBackoffResetMs
        ? previousState.failureCount + 1
        : 1;
    const backoffMs = Math.min(
      this.resolveMaxChatBackoffMs(policyName, policy),
      policy.backoffMs * 2 ** Math.max(0, failureCount - 1),
    );
    const backoffUntilMs = now + backoffMs;

    this.chatBackoffState.set(cacheKey, {
      failureCount,
      lastFailureAtMs: now,
    });
    this.chatBackoffUntilMs.set(cacheKey, backoffUntilMs);
    void this.runtimeDiagnosticsService?.recordMembershipBackoff({
      chatId,
      policyName,
      retryAfterMs: backoffMs,
    });

    return {
      backoffMs,
      backoffUntilMs,
    };
  }

  private clearChatBackoff(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    botId: string | null,
  ) {
    const cacheKey = this.buildChatBackoffKey(chatId, policyName, botId);
    this.chatBackoffState.delete(cacheKey);
    this.chatBackoffUntilMs.delete(cacheKey);
  }

  private clearLookupIssue(chatId: string, policyName: MaxMembershipLookupPolicy) {
    this.lookupIssues.delete(this.buildChatPolicyKey(chatId, policyName));
  }

  private recordLookupIssue(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    error: unknown,
    options: {
      kind: MaxMembershipLookupIssueKind;
      retryAfterMs: number;
    },
  ): void {
    const now = Date.now();
    this.lookupIssues.set(this.buildChatPolicyKey(chatId, policyName), {
      chatId,
      policyName,
      kind: options.kind,
      retryAfterMs: Math.max(0, Math.ceil(options.retryAfterMs)),
      observedAtMs: now,
      expiresAtMs: now + Math.max(1_000, Math.ceil(options.retryAfterMs)),
      statusCode: this.extractStatusCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
    void this.runtimeDiagnosticsService?.recordMembershipIssue({
      chatId,
      policyName,
      kind: options.kind,
      retryAfterMs: Math.max(0, Math.ceil(options.retryAfterMs)),
    });
  }

  private applyTerminalChatBackoff(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    backoffMs: number,
    botId: string | null,
  ): {
    backoffMs: number;
    backoffUntilMs: number;
  } {
    const cacheKey = this.buildChatBackoffKey(chatId, policyName, botId);
    const now = Date.now();
    const backoffUntilMs = now + backoffMs;

    this.chatBackoffState.set(cacheKey, {
      failureCount: 0,
      lastFailureAtMs: now,
    });
    this.chatBackoffUntilMs.set(cacheKey, backoffUntilMs);
    void this.runtimeDiagnosticsService?.recordMembershipBackoff({
      chatId,
      policyName,
      retryAfterMs: backoffMs,
    });

    return {
      backoffMs,
      backoffUntilMs,
    };
  }

  private resolveEffectivePolicy(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): MembershipLookupPolicyConfig {
    if (!this.isHotChannelModeActive(chatId, policyName, now)) {
      return policy;
    }

    return {
      ...policy,
      positiveFreshTtlSec: Math.max(policy.positiveFreshTtlSec, this.hotChannelPositiveFreshTtlSec),
    };
  }

  private recordHotChannelFailure(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): void {
    if (policyName !== 'moderation_required_subscription') {
      return;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const previousState = this.hotChannelStates.get(cacheKey);
    const failureCount =
      previousState && now - previousState.lastFailureAtMs <= this.hotChannelWindowMs
        ? previousState.failureCount + 1
        : 1;
    const hotUntilMs =
      failureCount >= this.hotChannelFailureThreshold
        ? Math.max(previousState?.hotUntilMs ?? 0, now + this.hotChannelDurationMs)
        : Math.max(previousState?.hotUntilMs ?? 0, 0);

    this.hotChannelStates.set(cacheKey, {
      failureCount,
      lastFailureAtMs: now,
      hotUntilMs,
    });
    if (hotUntilMs > now) {
      void this.runtimeDiagnosticsService?.recordMembershipHotChannel({
        chatId,
        policyName,
        hotDurationMs: hotUntilMs - now,
      });
    }
  }

  private clearHotChannelMode(chatId: string, policyName: MaxMembershipLookupPolicy) {
    if (policyName !== 'moderation_required_subscription') {
      return;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    this.hotChannelStates.delete(cacheKey);
  }

  private isHotChannelModeActive(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): boolean {
    if (policyName !== 'moderation_required_subscription') {
      return false;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const state = this.hotChannelStates.get(cacheKey);
    if (!state) {
      return false;
    }

    if (state.hotUntilMs > now) {
      return true;
    }

    if (now - state.lastFailureAtMs > this.hotChannelWindowMs) {
      this.hotChannelStates.delete(cacheKey);
    }
    return false;
  }

  private resolveMaxChatBackoffMs(
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
  ): number {
    if (policyName === 'moderation_required_subscription') {
      return this.maxChatBackoffMs;
    }

    return Math.min(this.maxChatBackoffMs, Math.max(policy.backoffMs * 2, 15_000));
  }

  private resolveTerminalChatBackoffMs(policyName: MaxMembershipLookupPolicy): number {
    switch (policyName) {
      case 'moderation_required_subscription':
        return this.requiredSubscriptionTerminalChatBackoffMs;
      case 'giveaway_draw_background':
        return GIVEAWAY_DRAW_TERMINAL_CHAT_BACKOFF_MS;
      default:
        return 0;
    }
  }

  private logRedisWriteFailure(cacheKey: string, error: unknown) {
    const nowMs = Date.now();
    if (nowMs - this.lastRedisWriteFailureLogAtMs < MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastRedisWriteFailureLogAtMs = nowMs;
    this.logger.warn(
      {
        cacheKey,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to write MAX membership snapshot to Redis',
    );
  }

  private logRedisInvalidationFailure(chatId: string, userIds: readonly string[], error: unknown) {
    const nowMs = Date.now();
    if (nowMs - this.lastRedisInvalidationFailureLogAtMs < MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastRedisInvalidationFailureLogAtMs = nowMs;
    this.logger.warn(
      {
        chatId,
        userIds,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to invalidate MAX membership snapshots in Redis',
    );
  }

  private clearPendingSingleLookupBatchTimers() {
    for (const batch of this.pendingSingleLookupBatches.values()) {
      if (!batch.timeout) {
        continue;
      }
      clearTimeout(batch.timeout);
      batch.timeout = null;
    }
  }

  private resolveSingleLookupBatchWindowMs(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): number {
    if (policyName !== 'moderation_required_subscription') {
      return 0;
    }

    return this.isHotChannelModeActive(chatId, policyName, now)
      ? Math.max(this.membershipLookupBatchWindowMs, this.hotChannelBatchWindowMs)
      : this.membershipLookupBatchWindowMs;
  }

  private resolveLookupTimeoutMs(trafficClass: MaxApiTrafficClass): number {
    return this.lookupTimeoutMsByTrafficClass[trafficClass];
  }

  private resolveLookupGuardTimeoutMs(trafficClass: MaxApiTrafficClass): number {
    return this.resolveLookupTimeoutMs(trafficClass) + MEMBERSHIP_LOOKUP_GUARD_SLACK_MS;
  }

  private async executeLookupWithGuard<T>(
    operation: () => Promise<T>,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      trafficClass: MaxApiTrafficClass;
    },
  ): Promise<T> {
    const startedAtMs = Date.now();
    const guardTimeoutMs = this.resolveLookupGuardTimeoutMs(context.trafficClass);
    let timeoutHandle: NodeJS.Timeout | null = null;
    let timedOut = false;

    const operationPromise = operation().catch((error: unknown) => {
      if (timedOut) {
        return Promise.reject(error);
      }
      throw error;
    });
    operationPromise.catch(() => undefined);

    const guardPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(this.createLookupTimeoutError(context, guardTimeoutMs));
      }, guardTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const result = await Promise.race([operationPromise, guardPromise]);
      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= MEMBERSHIP_LOOKUP_SLOW_LOG_THRESHOLD_MS) {
        this.logger.warn(
          {
            chatId: context.chatId,
            userIds: context.userIds,
            policyName: context.policyName,
            trafficClass: context.trafficClass,
            durationMs,
          },
          'Slow MAX membership lookup completed close to the hot-path deadline',
        );
      }
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private createLookupTimeoutError(
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      trafficClass: MaxApiTrafficClass;
    },
    timeoutMs: number,
  ): Error & { code: string } {
    const error = new Error(
      `MAX membership lookup guard timed out after ${timeoutMs}ms for ${context.policyName}`,
    ) as Error & { code: string };
    error.code = 'ECONNABORTED';
    return error;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractErrorMessage(error);
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    return this.extractErrorMessage(error).includes('timeout');
  }

  private isTerminalChatAccessError(error: unknown): boolean {
    return resolveExplicitMembershipAccessDenial(error) !== null;
  }

  private resolveTerminalChatAccessErrorCode(error: unknown): string {
    return resolveExplicitMembershipAccessDenial(error) ?? 'unknown';
  }

  private isTransientLookupError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      this.isMaxApiThrottleError(error) ||
      this.isMaxApiTimeoutError(error) ||
      (status !== null &&
        (status >= 500 ||
          ((status === 403 || status === 404) && !this.isTerminalChatAccessError(error))))
    );
  }
}
