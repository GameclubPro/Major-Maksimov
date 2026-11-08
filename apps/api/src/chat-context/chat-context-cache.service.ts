import { preserveManagedEntityTitle } from '../common/managed-entity-title';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSummary, ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatSettings } from '../prisma/prisma-client';
import Redis from 'ioredis';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import type { MaxBotChat } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import {
  ChatContextLocalCache,
  type ChatContextLocalCacheSnapshot,
} from './chat-context-local-cache';
import { ChatContextMediaCache, CHAT_CONTEXT_MEDIA_TTL_SEC } from './chat-context-media-cache';
import { readChatContextSource } from './chat-context-source';
import type { ChatAdminRosterSnapshot } from '../max/chat-admin-roster-state';
import { ChatSettingsTemplateCache } from './chat-settings-template-cache';
import {
  createChatContextCacheActivity,
  parseChatContextInvalidationReason,
  type ChatContextCacheActivitySnapshot,
  type ChatContextInvalidationReason,
} from './chat-context-cache-metrics';

export type ChatAdminAccessState = 'granted' | 'user_denied' | 'bot_denied';

export async function invalidateSharedChatContext(
  redis: Pick<Redis, 'eval'>,
  chatId: string,
  reason: ChatContextInvalidationReason = 'explicit',
): Promise<void> {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) return;
  await redis.eval(
    INVALIDATE_CHAT_CONTEXT_SCRIPT,
    3,
    ChatContextCacheService.chatContextRevisionKey(normalizedChatId),
    ChatContextCacheService.cacheKey(normalizedChatId),
    ChatContextCacheService.legacyCacheKey(normalizedChatId),
    CHAT_CONTEXT_INVALIDATION_CHANNEL,
    JSON.stringify({ chatId: normalizedChatId, reason }),
  );
}

export type ChatContext = {
  chatId: string;
  title: string;
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: string[];
  adminRoster?: ChatAdminRosterSnapshot | null;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
};

type ChatContextReadGeneration = { invalidated: boolean; readers: number };

type ManagedEntitiesDiscoverySnapshot = MaxBotChat[];
type ManagedEntitiesRecentBootstrapEntry = ChatSummary & {
  bootstrapUserIds?: string[];
};
type ManagedEntitiesRecentBootstrapSnapshot = ManagedEntitiesRecentBootstrapEntry[];
export type ManagedEntitiesPublishedSnapshot = {
  version: string;
  builtAt: string;
  lastSyncedAt: string | null;
  itemCount: number;
  itemsHash: string;
  items: ChatSummary[];
};
export type ManagedEntitiesPublishedSnapshotWriteOptions = {
  expectedVersion: string | null;
};
export type ManagedEntityPublishedSnapshotUpsert = Omit<ChatSummary, 'link' | 'avatarUrl'> & {
  link?: ChatSummary['link'];
  avatarUrl?: ChatSummary['avatarUrl'];
};
export type AdminAccessEpochMutation = {
  chatId: string;
  userId: string;
  state: ChatAdminAccessState;
  eventAt: Date;
  publishedSummary?: ManagedEntityPublishedSnapshotUpsert & { entityType: ManagedEntityType };
  publishedSnapshotTtlSec?: number;
  recentBootstrapSummary?: ChatSummary;
  recentBootstrapTtlSec?: number;
};
export type AdminAccessEpochMutationMetric =
  | {
      phase: 'precheck';
      outcome: 'hit' | 'miss' | 'fail_open';
      durationMs: number;
    }
  | {
      phase: 'lua';
      outcome: 'applied' | 'superseded' | 'conflict' | 'retry' | 'exhausted' | 'failed';
      durationMs?: number;
    };
export type AdminAccessEpochMutationOptions = {
  acceptNewerGrantedEpoch?: boolean;
  precheckSupersededEpoch?: boolean;
  recordMetric?: (metric: AdminAccessEpochMutationMetric) => void;
};
export type ManagedEntitiesPublishedDiff = {
  baseVersion: string;
  nextVersion: string;
  added: ChatSummary[];
  updated: ChatSummary[];
  removedIds: string[];
  orderedIds: string[];
  changeCount: number;
};
type ManagedEntityBotProfileSnapshot = {
  avatarUrl: string | null;
};
type OpaqueRedisMutation = {
  expectedRaw: string | null;
  action: 'keep' | 'set' | 'delete';
  nextRaw: string;
  ttlSec: number;
};

const CHAT_CONTEXT_INVALIDATION_CHANNEL = 'chat:context:invalidate:v1';

const SET_MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_CAS_SCRIPT = `
-- operation:managed_entities_published_snapshot_set_cas
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '1' and current ~= ARGV[2]) or
   (ARGV[1] == '0' and current ~= false) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

const UPSERT_MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_SCRIPT = `
-- operation:managed_entities_recent_bootstrap_upsert_cas
local global = redis.call('GET', KEYS[1])
if (ARGV[1] == '1' and global ~= ARGV[2]) or
   (ARGV[1] == '0' and global ~= false) then
  return 0
end

if ARGV[4] == '1' then
  local user_scoped = redis.call('GET', KEYS[2])
  if (ARGV[5] == '1' and user_scoped ~= ARGV[6]) or
     (ARGV[5] == '0' and user_scoped ~= false) then
    return 0
  end
end

redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[8])
redis.call('SET', KEYS[3], '1', 'EX', ARGV[8])
if ARGV[4] == '1' then
  redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[8])
  redis.call('SADD', KEYS[4], ARGV[9])
  redis.call('EXPIRE', KEYS[4], ARGV[8])
end
return 1
`;

const REMOVE_MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_SCRIPT = `
-- operation:managed_entities_recent_bootstrap_remove_cas
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '1' and current ~= ARGV[2]) or
   (ARGV[1] == '0' and current ~= false) then
  return 0
end

if ARGV[3] == 'set' then
  redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])
elseif ARGV[3] == 'delete' then
  redis.call('DEL', KEYS[1])
end
if ARGV[6] == 'global' then
  redis.call('DEL', KEYS[2])
else
  redis.call('SREM', KEYS[3], ARGV[7])
end
return 1
`;

// Keep both tabs consistent without decoding snapshot JSON in Redis. Redis 7 lua-cjson encodes an
// empty JSON array as an object after a decode/encode round trip, so the snapshots stay opaque.
const UPSERT_MANAGED_ENTITY_PUBLISHED_SNAPSHOT_CAS_SCRIPT = `
local function matches(actual, expected_exists, expected)
  if expected_exists == '1' then
    return actual == expected
  end
  return actual == false
end

local current = redis.call('GET', KEYS[1])
local opposite = redis.call('GET', KEYS[2])
if not matches(current, ARGV[1], ARGV[2]) or
   not matches(opposite, ARGV[3], ARGV[4]) then
  return 0
end

redis.call('SET', KEYS[1], ARGV[5], 'EX', ARGV[8])
if ARGV[6] == 'set' then
  redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[8])
elseif ARGV[6] == 'delete' then
  redis.call('DEL', KEYS[2])
end
return 1
`;

// FLAG: Access state and every user-visible derivative advance under the same event epoch. Keep
// snapshot JSON opaque: Redis cjson turns nested empty arrays into objects on a decode/encode pass.
const APPLY_ADMIN_ACCESS_EPOCH_MUTATION_SCRIPT = `
local incoming_timestamp = tonumber(ARGV[1])
local incoming_priority = tonumber(ARGV[2])
local current_epoch = redis.call('GET', KEYS[1])
local exact_epoch_and_state = false
if current_epoch then
  local separator = string.find(current_epoch, ':', 1, true)
  if separator then
    local current_timestamp = tonumber(string.sub(current_epoch, 1, separator - 1))
    local current_priority = tonumber(string.sub(current_epoch, separator + 1))
    exact_epoch_and_state = current_timestamp == incoming_timestamp and
      current_priority == incoming_priority and
      redis.call('GET', KEYS[2]) == ARGV[4]
    -- FLAG: A separately verified bot may reuse a newer human grant without
    -- overwriting its caches or extending its lifetime. Negative epochs never qualify.
    if ARGV[48] == '1' and incoming_priority == 0 and current_priority == 0 and
       current_timestamp and current_timestamp > incoming_timestamp and
       redis.call('GET', KEYS[2]) == 'granted' then
      return 3
    end
    if current_timestamp and current_priority and
       (current_timestamp > incoming_timestamp or
        (current_timestamp == incoming_timestamp and current_priority > incoming_priority)) then
      return 0
    end
  end
end

local opaque_keys = { KEYS[3], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10] }
local argument_offset = 9
local function matches(actual, expected_exists, expected)
  if expected_exists == '1' then
    return actual == expected
  end
  return actual == false
end

local opaque_mutations_are_noop = true
for index, key in ipairs(opaque_keys) do
  local offset = argument_offset + ((index - 1) * 5)
  if not matches(redis.call('GET', key), ARGV[offset], ARGV[offset + 1]) then
    return -1
  end
  if ARGV[offset + 2] ~= 'keep' then
    opaque_mutations_are_noop = false
  end
end

-- FLAG: Rollback writers know only v3 but still advance the shared revision.
local context_revision_current = redis.call('GET', KEYS[16]) ==
  (redis.call('GET', KEYS[4]) or '0')
local recent_mode = ARGV[44]
if exact_epoch_and_state and
   opaque_mutations_are_noop and
   recent_mode == 'deny' and
   redis.call('SISMEMBER', KEYS[11], ARGV[6]) == 0 and
   redis.call('SISMEMBER', KEYS[12], ARGV[6]) == 0 then
  redis.call('DEL', KEYS[15])
  if not context_revision_current then redis.call('DEL', KEYS[3], KEYS[16]) end
  redis.call('PUBLISH', ARGV[7], ARGV[8])
  return 2
end

for index, key in ipairs(opaque_keys) do
  local offset = argument_offset + ((index - 1) * 5)
  local expected_exists = ARGV[offset]
  local action = ARGV[offset + 2]
  if action == 'set' then
    if expected_exists == '1' then
      redis.call('SET', key, ARGV[offset + 3], 'KEEPTTL')
    else
      redis.call('SET', key, ARGV[offset + 3], 'EX', ARGV[offset + 4])
    end
  elseif action == 'delete' then
    redis.call('DEL', key)
  end
end

redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[47])
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[5])
local next_context_revision = redis.call('INCR', KEYS[4])
if context_revision_current and redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('SET', KEYS[16], tostring(next_context_revision), 'EX', ARGV[49])
else
  redis.call('DEL', KEYS[3], KEYS[16])
end
redis.call('DEL', KEYS[15])

local recent_entity_type = ARGV[46]
if recent_mode == 'grant' then
  if recent_entity_type == 'chat' then
    redis.call('SADD', KEYS[11], ARGV[6])
    redis.call('EXPIRE', KEYS[11], ARGV[45])
    redis.call('SET', KEYS[13], '1', 'EX', ARGV[45])
  elseif recent_entity_type == 'channel' then
    redis.call('SADD', KEYS[12], ARGV[6])
    redis.call('EXPIRE', KEYS[12], ARGV[45])
    redis.call('SET', KEYS[14], '1', 'EX', ARGV[45])
  end
elseif recent_mode == 'deny' then
  redis.call('SREM', KEYS[11], ARGV[6])
  redis.call('SREM', KEYS[12], ARGV[6])
end

redis.call('PUBLISH', ARGV[7], ARGV[8])
return 1
`;

const WRITE_CHAT_CONTEXT_AT_REVISION_SCRIPT = `
local revision = redis.call('GET', KEYS[1]) or '0'
if revision ~= ARGV[1] then
  return 0
end
-- FLAG: A context cannot publish a dangling media reference. The original revision CAS
-- still owns authority; blobs carry only the immutable bytes of that settings snapshot.
for index = 5, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 0 then return 0 end
end
for index = 5, #KEYS do
  redis.call('EXPIRE', KEYS[index], ARGV[4])
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[4], revision, 'EX', ARGV[3])
redis.call('DEL', KEYS[3])
return 1
`;

const PATCH_CHAT_CONTEXT_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local revision = redis.call('GET', KEYS[2]) or '0'
if current == false or current ~= ARGV[1] or revision ~= ARGV[2] or
   redis.call('GET', KEYS[4]) ~= revision then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'KEEPTTL')
local next_revision = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[4], tostring(next_revision), 'KEEPTTL')
redis.call('DEL', KEYS[3])
redis.call('PUBLISH', ARGV[4], ARGV[5])
return 1
`;

const INVALIDATE_CHAT_CONTEXT_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('PUBLISH', ARGV[1], ARGV[2])
return 1
`;

@Injectable()
export class ChatContextCacheService implements OnModuleInit, OnModuleDestroy {
  private static readonly CHAT_CONTEXT_TTL_SEC = 60;
  private static readonly LOCAL_CHAT_CONTEXT_TTL_MS = 30_000;
  private static readonly CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS = 150;
  private static readonly CHAT_CONTEXT_REDIS_WRITE_TIMEOUT_MS = 150;
  private static readonly MANAGED_ENTITY_HEADER_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly MANAGED_ENTITY_BOT_PROFILE_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly ADMIN_ACCESS_GRANTED_TTL_SEC = 15 * 60;
  private static readonly ADMIN_ACCESS_DENIED_TTL_SEC = 60;
  private static readonly ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS = 100;
  private static readonly ACCESS_EPOCH_TTL_SEC = 30 * 24 * 60 * 60;
  private static readonly ACCESS_EPOCH_CAS_MAX_ATTEMPTS = 16;
  private static readonly CHAT_CONTEXT_REVISION_LOAD_MAX_ATTEMPTS = 8;
  private static readonly DEFAULT_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
  private static readonly DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC = 60 * 60;
  private static readonly DEFAULT_MANAGED_ENTITY_BOT_PROFILE_TTL_SEC = 6 * 60 * 60;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_ITEMS = 500;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_ITEMS = 100;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS = 64;
  private static readonly MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_MAX_ATTEMPTS = 16;
  private static readonly MANAGED_ENTITY_PUBLISHED_SNAPSHOT_CAS_MAX_ATTEMPTS = 16;
  private readonly logger = new Logger(ChatContextCacheService.name);
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly localChatContextSweepIntervalMs: number;
  private readonly managedEntityHeaderTtlSec: number;
  private readonly managedEntityBotProfileTtlSec: number;
  private readonly localChatContextCache: ChatContextLocalCache;
  private readonly mediaCache: ChatContextMediaCache;
  private readonly settingsTemplates: ChatSettingsTemplateCache;
  private readonly settingsSourceActivity = { fullLoads: 0, shellReads: 0, reuses: 0 };
  private localChatContextSweepTimer: NodeJS.Timeout | null = null;
  private readonly chatContextInFlightLoads = new Map<string, Promise<ChatContext>>();
  private readonly chatContextReadGenerations = new Map<string, ChatContextReadGeneration>();
  private readonly cacheActivity = createChatContextCacheActivity();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly storageRuntimeMetrics?: StorageRuntimeMetricsService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.mediaCache = new ChatContextMediaCache(this.redis, (key) =>
      this.readRedisStringWithin(key, ChatContextCacheService.CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS),
    );
    this.subscriber = this.redis.duplicate({ enableReadyCheck: false });
    const localChatContextTtlMs = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS',
      ),
      ChatContextCacheService.LOCAL_CHAT_CONTEXT_TTL_MS,
    );
    const readCacheLimit = (key: string, fallback: number) =>
      this.readPositiveInt(
        (configService as { get?: (key: string) => unknown }).get?.(key),
        fallback,
      );
    this.settingsTemplates = new ChatSettingsTemplateCache({
      maxBytes: readCacheLimit('CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_BYTES', 16 * 1024 * 1024),
      maxMediaBytes: readCacheLimit(
        'CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_MEDIA_BYTES',
        8 * 1024 * 1024,
      ),
      maxEntries: readCacheLimit('CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_ENTRIES', 2048),
    });
    this.localChatContextCache = new ChatContextLocalCache({
      ttlMs: localChatContextTtlMs,
      maxBytes: readCacheLimit('CHAT_CONTEXT_LOCAL_CACHE_MAX_BYTES', 128 * 1024 * 1024),
      maxEntries: readCacheLimit('CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRIES', 2048),
      maxEntryBytes: readCacheLimit('CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRY_BYTES', 128 * 1024 * 1024),
      sweepBatchSize: readCacheLimit('CHAT_CONTEXT_LOCAL_CACHE_SWEEP_BATCH_SIZE', 128),
    });
    this.localChatContextSweepIntervalMs = readCacheLimit(
      'CHAT_CONTEXT_LOCAL_CACHE_SWEEP_INTERVAL_MS',
      5000,
    );
    this.managedEntityHeaderTtlSec = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'MANAGED_ENTITY_HEADER_CACHE_SEC',
      ),
      ChatContextCacheService.DEFAULT_MANAGED_ENTITY_HEADER_TTL_SEC,
    );
    this.managedEntityBotProfileTtlSec = this.readPositiveInt(
      (configService as { get?: (key: string) => unknown }).get?.(
        'MANAGED_ENTITY_BOT_PROFILE_CACHE_SEC',
      ),
      ChatContextCacheService.DEFAULT_MANAGED_ENTITY_BOT_PROFILE_TTL_SEC,
    );
    this.storageRuntimeMetrics?.registerChatContextCacheSnapshot(() =>
      this.getLocalCacheSnapshot(),
    );
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== CHAT_CONTEXT_INVALIDATION_CHANNEL) {
        return;
      }

      const invalidation = this.parseInvalidationPayload(payload);
      if (!invalidation) {
        return;
      }

      this.applyLocalInvalidation(invalidation.chatId, invalidation.reason, 'remote');
      this.maxBotLinkService.forgetChatBotBinding(invalidation.chatId);
    });
    await this.subscriber.subscribe(CHAT_CONTEXT_INVALIDATION_CHANNEL);
    if (!this.localChatContextSweepTimer) {
      this.localChatContextSweepTimer = setInterval(
        () => this.localChatContextCache.sweepExpired(),
        this.localChatContextSweepIntervalMs,
      );
      this.localChatContextSweepTimer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.localChatContextSweepTimer) {
      clearInterval(this.localChatContextSweepTimer);
      this.localChatContextSweepTimer = null;
    }
    this.localChatContextCache.clear();
    this.settingsTemplates.clear();
    this.mediaCache.clear();
    await this.subscriber.quit();
    await this.redis.quit();
  }

  static cacheKey(chatId: string): string {
    return `chat:context:v4:${chatId}`;
  }

  static cachedContextRevisionKey(chatId: string): string {
    return `chat:context:v4-revision:${chatId}`;
  }

  static legacyCacheKey(chatId: string): string {
    return `chat:context:v3:${chatId}`;
  }

  getLocalCacheSnapshot(): ChatContextLocalCacheSnapshot & {
    activity: ChatContextCacheActivitySnapshot;
    settingsTemplates: ReturnType<ChatSettingsTemplateCache['snapshot']> & {
      fullLoads: number;
      shellReads: number;
      reuses: number;
    };
  } {
    return {
      ...this.localChatContextCache.snapshot(),
      settingsTemplates: { ...this.settingsTemplates.snapshot(), ...this.settingsSourceActivity },
      activity: {
        ...this.cacheActivity,
        invalidationsByReason: Object.fromEntries(
          Object.entries(this.cacheActivity.invalidationsByReason).map(([reason, counters]) => [
            reason,
            { ...counters },
          ]),
        ) as ChatContextCacheActivitySnapshot['invalidationsByReason'],
      },
    };
  }

  static adminAccessKey(chatId: string, userId: string): string {
    return `chat:admin-access:v2:${chatId}:${userId}`;
  }

  static adminAccessEpochKey(chatId: string, userId: string): string {
    return `chat:admin-access-epoch:v1:${chatId}:${userId}`;
  }

  static chatContextRevisionKey(chatId: string): string {
    return `chat:context-revision:v1:${chatId}`;
  }

  static adminLookupBackoffKey(chatId: string): string {
    return `chat:admin-lookup-backoff:v1:${chatId}`;
  }

  static managedEntityHeaderKey(chatId: string, entityType: ManagedEntityType): string {
    return `chat:managed-header:v1:${entityType}:${chatId}`;
  }

  static managedEntityBotProfileKey(botId: string): string {
    return `chat:managed-bot-profile:v1:${botId}`;
  }

  static managedEntitiesRefreshCooldownKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-cooldown:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRefreshBackoffKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-backoff:v1:${entityType}:${userId}`;
  }

  static managedRefreshSourceBackoffKey(botId?: string): string {
    return botId
      ? `maxapi:managed-refresh-source-backoff:v2:bot:${encodeURIComponent(botId)}`
      : 'maxapi:managed-refresh-source-backoff:v1';
  }

  static managedEntitiesRefreshCursorKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-cursor:v1:${entityType}:${userId}`;
  }

  static managedEntitiesDiscoverySnapshotKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-snapshot:v1:${entityType}:${userId}`;
  }

  static managedEntitiesLastSyncedKey(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): string {
    return `chat:managed-refresh-last-synced:v1:${entityType}:${userId}`;
  }

  static managedEntitiesPublishedSnapshotKey(
    userId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-view-snapshot:v1:${entityType}:${userId}`;
  }

  static managedEntitiesPublishedDiffKey(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
  ): string {
    return `chat:managed-view-diff:v1:${entityType}:${userId}:${baseVersion}`;
  }

  static managedEntitiesRecentBootstrapKey(entityType: ManagedEntityType): string {
    return `chat:managed-recent-bootstrap:v1:${entityType}`;
  }

  static managedEntitiesRecentBootstrapUserKey(
    entityType: ManagedEntityType,
    userId: string,
  ): string {
    return `chat:managed-recent-bootstrap-user:v1:${entityType}:${userId}`;
  }

  static managedEntitiesRecentBootstrapChatIndexKey(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-recent-bootstrap-index:v1:${entityType}:${chatId}`;
  }

  static managedEntitiesRecentBootstrapChatUsersKey(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    return `chat:managed-recent-bootstrap-users:v1:${entityType}:${chatId}`;
  }

  static managedGiveawayRunnerBackoffKey(giveawayId: string): string {
    return `managed-giveaway:runner-backoff:v1:${giveawayId}`;
  }

  static managedGiveawayRunnerFailureCountKey(giveawayId: string): string {
    return `managed-giveaway:runner-failure-count:v1:${giveawayId}`;
  }

  static managedGiveawayRunnerDeferKey(giveawayId: string): string {
    return `managed-giveaway:runner-defer:v1:${giveawayId}`;
  }

  async getChatContext(chatId: string, chatTitle?: string | null): Promise<ChatContext> {
    const normalizedTitle = chatTitle?.trim() || null;
    for (;;) {
      const generation = this.acquireChatContextReadGeneration(chatId);
      try {
        const localCached = this.readLocalChatContext(chatId);
        if (localCached) {
          const reconciled = this.reconcileCachedChatTitle(
            chatId,
            localCached,
            normalizedTitle,
            generation,
          );
          if (!this.isChatContextReadGenerationCurrent(chatId, generation)) continue;
          return reconciled;
        }

        const existingLoad = this.chatContextInFlightLoads.get(chatId);
        if (existingLoad) {
          this.cacheActivity.coalescedLoads += 1;
          const resolved = await existingLoad;
          if (!this.isChatContextReadGenerationCurrent(chatId, generation)) continue;
          return this.reconcileCachedChatTitle(chatId, resolved, normalizedTitle, generation);
        }

        const loadPromise = this.loadCachedOrSource(chatId, normalizedTitle, generation).finally(
          () => {
            if (this.chatContextInFlightLoads.get(chatId) === loadPromise) {
              this.chatContextInFlightLoads.delete(chatId);
            }
          },
        );
        this.chatContextInFlightLoads.set(chatId, loadPromise);
        const resolved = await loadPromise;
        if (!this.isChatContextReadGenerationCurrent(chatId, generation)) continue;
        return this.reconcileCachedChatTitle(chatId, resolved, normalizedTitle, generation);
      } finally {
        this.releaseChatContextReadGeneration(chatId, generation);
      }
    }
  }

  private acquireChatContextReadGeneration(chatId: string): ChatContextReadGeneration {
    // FLAG: Only active readers retain a generation. Identity-checked release cannot remove a
    // newer load, and invalidated objects held by retired readers must never become current again.
    let generation = this.chatContextReadGenerations.get(chatId);
    if (!generation) {
      generation = { invalidated: false, readers: 0 };
      this.chatContextReadGenerations.set(chatId, generation);
    }
    generation.readers += 1;
    return generation;
  }

  private releaseChatContextReadGeneration(
    chatId: string,
    generation: ChatContextReadGeneration,
  ): void {
    generation.readers -= 1;
    if (generation.readers === 0 && this.chatContextReadGenerations.get(chatId) === generation) {
      this.chatContextReadGenerations.delete(chatId);
    }
  }

  private isChatContextReadGenerationCurrent(
    chatId: string,
    generation: ChatContextReadGeneration,
  ): boolean {
    return !generation.invalidated && this.chatContextReadGenerations.get(chatId) === generation;
  }

  async invalidate(chatId: string) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    this.invalidateLocal(normalizedChatId);
    await invalidateSharedChatContext(this.redis, normalizedChatId);
  }

  invalidateLocal(chatId: string): void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }
    this.applyLocalInvalidation(normalizedChatId);
  }

  async getAdminAccess(chatId: string, userId: string): Promise<ChatAdminAccessState | null> {
    const raw = await this.readRedisStringWithin(
      ChatContextCacheService.adminAccessKey(chatId, userId),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    return this.parseAdminAccessState(raw);
  }

  async getAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
  ): Promise<Map<string, ChatAdminAccessState | null>> {
    const normalizedChatId = chatId.trim();
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((value) => value.length > 0)),
    );
    const results = new Map<string, ChatAdminAccessState | null>();
    if (!normalizedChatId || normalizedUserIds.length === 0) {
      return results;
    }

    const rawStates = await this.readRedisStringsWithin(
      normalizedUserIds.map((userId) =>
        ChatContextCacheService.adminAccessKey(normalizedChatId, userId),
      ),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    if (!rawStates) {
      for (const normalizedUserId of normalizedUserIds) {
        results.set(normalizedUserId, null);
      }
      return results;
    }

    normalizedUserIds.forEach((normalizedUserId, index) => {
      results.set(normalizedUserId, this.parseAdminAccessState(rawStates[index] ?? null));
    });
    return results;
  }

  async setAdminAccess(chatId: string, userId: string, state: ChatAdminAccessState): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.adminAccessKey(chatId, userId),
      state,
      'EX',
      this.resolveAdminAccessTtlSec(state),
    );
  }

  async applyAdminAccessEpochMutation(
    params: AdminAccessEpochMutation,
    options: AdminAccessEpochMutationOptions = {},
  ): Promise<boolean> {
    const chatId = params.chatId.trim();
    const userId = params.userId.trim();
    const eventAtMs = params.eventAt.getTime();
    if (!chatId || !userId || !Number.isSafeInteger(eventAtMs) || eventAtMs < 0) {
      return false;
    }

    const priority = params.state === 'granted' ? 0 : 1;
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    if (options.precheckSupersededEpoch) {
      // FLAG: Missing, failed, timed-out, and equal reads must reach the authoritative opaque CAS.
      const precheckStartedAtMs = Date.now();
      const precheck = await this.readAdminAccessEpochPrecheckWithin(
        epochKey,
        ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
      );
      const isSuperseded =
        precheck.kind === 'value' &&
        this.isAdminAccessEpochStrictlyNewer(precheck.value, eventAtMs, priority);
      this.recordAdminAccessEpochMutationMetric(options, {
        phase: 'precheck',
        outcome: isSuperseded ? 'hit' : precheck.kind === 'fail_open' ? 'fail_open' : 'miss',
        durationMs: Date.now() - precheckStartedAtMs,
      });
      if (isSuperseded) {
        return false;
      }
    }
    const publishedSnapshotTtlSec = this.readPositiveInt(
      params.publishedSnapshotTtlSec,
      ChatContextCacheService.DEFAULT_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
    const recentBootstrapTtlSec = this.readPositiveInt(
      params.recentBootstrapTtlSec,
      ChatContextCacheService.DEFAULT_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
    const contextKey = ChatContextCacheService.cacheKey(chatId);
    const publishedChatKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      userId,
      'chat',
    );
    const publishedChannelKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      userId,
      'channel',
    );
    const recentGlobalChatKey = ChatContextCacheService.managedEntitiesRecentBootstrapKey('chat');
    const recentUserChatKey = ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(
      'chat',
      userId,
    );
    const recentGlobalChannelKey =
      ChatContextCacheService.managedEntitiesRecentBootstrapKey('channel');
    const recentUserChannelKey = ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(
      'channel',
      userId,
    );
    const opaqueKeys = [
      contextKey,
      publishedChatKey,
      publishedChannelKey,
      recentGlobalChatKey,
      recentUserChatKey,
      recentGlobalChannelKey,
      recentUserChannelKey,
    ] as const;

    for (
      let attempt = 0;
      attempt < ChatContextCacheService.ACCESS_EPOCH_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const [
        contextRaw,
        publishedChatRaw,
        publishedChannelRaw,
        recentGlobalChatRaw,
        recentUserChatRaw,
        recentGlobalChannelRaw,
        recentUserChannelRaw,
      ] = await this.redis.mget(...opaqueKeys);
      const contextMutation = this.buildAdminAccessChatContextMutation(
        contextRaw,
        userId,
        params.state === 'granted',
      );
      const [publishedChatMutation, publishedChannelMutation] =
        this.buildAdminAccessPublishedSnapshotMutations({
          chatId,
          state: params.state,
          summary: params.publishedSummary,
          chatRaw: publishedChatRaw,
          channelRaw: publishedChannelRaw,
          ttlSec: publishedSnapshotTtlSec,
        });
      const [
        recentGlobalChatMutation,
        recentUserChatMutation,
        recentGlobalChannelMutation,
        recentUserChannelMutation,
      ] = this.buildAdminAccessRecentBootstrapMutations({
        chatId,
        userId,
        state: params.state,
        summary: params.recentBootstrapSummary,
        globalChatRaw: recentGlobalChatRaw,
        userChatRaw: recentUserChatRaw,
        globalChannelRaw: recentGlobalChannelRaw,
        userChannelRaw: recentUserChannelRaw,
        ttlSec: recentBootstrapTtlSec,
      });
      const opaqueMutations = [
        contextMutation,
        publishedChatMutation,
        publishedChannelMutation,
        recentGlobalChatMutation,
        recentUserChatMutation,
        recentGlobalChannelMutation,
        recentUserChannelMutation,
      ];
      const recentMode =
        params.state !== 'granted' ? 'deny' : params.recentBootstrapSummary ? 'grant' : 'keep';
      const recentEntityType = params.recentBootstrapSummary?.entityType ?? 'none';
      const luaStartedAtMs = Date.now();
      let result: number;
      try {
        result = Number(
          await this.redis.eval(
            APPLY_ADMIN_ACCESS_EPOCH_MUTATION_SCRIPT,
            16,
            epochKey,
            ChatContextCacheService.adminAccessKey(chatId, userId),
            contextKey,
            ChatContextCacheService.chatContextRevisionKey(chatId),
            publishedChatKey,
            publishedChannelKey,
            recentGlobalChatKey,
            recentUserChatKey,
            recentGlobalChannelKey,
            recentUserChannelKey,
            ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(chatId, 'chat'),
            ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(chatId, 'channel'),
            ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(chatId, 'chat'),
            ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(chatId, 'channel'),
            ChatContextCacheService.legacyCacheKey(chatId),
            ChatContextCacheService.cachedContextRevisionKey(chatId),
            String(eventAtMs),
            String(priority),
            `${eventAtMs}:${priority}`,
            params.state,
            String(this.resolveAdminAccessTtlSec(params.state)),
            userId,
            CHAT_CONTEXT_INVALIDATION_CHANNEL,
            JSON.stringify({
              chatId,
              reason: params.state === 'granted' ? 'access_granted' : 'access_denied',
            }),
            ...opaqueMutations.flatMap((mutation) => this.serializeOpaqueRedisMutation(mutation)),
            recentMode,
            String(recentBootstrapTtlSec),
            recentEntityType,
            String(ChatContextCacheService.ACCESS_EPOCH_TTL_SEC),
            options.acceptNewerGrantedEpoch === true ? '1' : '0',
            String(ChatContextCacheService.CHAT_CONTEXT_TTL_SEC),
          ),
        );
      } catch (error: unknown) {
        this.recordAdminAccessEpochMutationMetric(options, {
          phase: 'lua',
          outcome: 'failed',
          durationMs: Date.now() - luaStartedAtMs,
        });
        throw error;
      }
      if (result === 1 || result === 3) {
        this.recordAdminAccessEpochMutationMetric(options, {
          phase: 'lua',
          outcome: 'applied',
          durationMs: Date.now() - luaStartedAtMs,
        });
        if (result === 3) this.cacheActivity.grantsReused += 1;
        this.applyLocalInvalidation(
          chatId,
          result === 3
            ? 'access_grant_reused'
            : params.state === 'granted'
              ? 'access_granted'
              : 'access_denied',
        );
        return true;
      }
      if (result === 2) {
        this.cacheActivity.denialReplays += 1;
        this.recordAdminAccessEpochMutationMetric(options, {
          phase: 'lua',
          outcome: 'superseded',
          durationMs: Date.now() - luaStartedAtMs,
        });
        this.applyLocalInvalidation(chatId, 'access_denied');
        return false;
      }
      if (result === 0) {
        this.recordAdminAccessEpochMutationMetric(options, {
          phase: 'lua',
          outcome: 'superseded',
          durationMs: Date.now() - luaStartedAtMs,
        });
        return false;
      }
      this.recordAdminAccessEpochMutationMetric(options, {
        phase: 'lua',
        outcome: 'conflict',
        durationMs: Date.now() - luaStartedAtMs,
      });
      if (attempt + 1 < ChatContextCacheService.ACCESS_EPOCH_CAS_MAX_ATTEMPTS) {
        this.recordAdminAccessEpochMutationMetric(options, {
          phase: 'lua',
          outcome: 'retry',
        });
      }
    }

    this.recordAdminAccessEpochMutationMetric(options, {
      phase: 'lua',
      outcome: 'exhausted',
    });
    throw new Error(`Admin access epoch mutation conflicted repeatedly for chat ${chatId}`);
  }

  async clearAdminAccess(chatId: string, userId: string): Promise<void> {
    await this.redis.del(ChatContextCacheService.adminAccessKey(chatId, userId));
  }

  async getAdminLookupBackoffRemainingMs(chatId: string): Promise<number> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return 0;
    }

    const ttlMs = await this.runRedisReadWithin(
      this.redis
        .pttl(ChatContextCacheService.adminLookupBackoffKey(normalizedChatId))
        .catch(() => 0),
      ChatContextCacheService.ADMIN_ACCESS_REDIS_READ_TIMEOUT_MS,
    );
    return typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 0;
  }

  async activateAdminLookupBackoff(chatId: string, ttlSec: number): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedTtlSec = Math.max(1, Math.ceil(ttlSec));
    if (!normalizedChatId) {
      return;
    }

    await this.redis.set(
      ChatContextCacheService.adminLookupBackoffKey(normalizedChatId),
      '1',
      'EX',
      normalizedTtlSec,
    );
  }

  async rememberChatAdminUser(chatId: string, userId: string): Promise<void> {
    await this.rememberChatAdminUserInternal(chatId, userId, false);
  }

  async rememberChatAdminUserFenced(chatId: string, userId: string): Promise<void> {
    await this.rememberChatAdminUserInternal(chatId, userId, true);
  }

  private async rememberChatAdminUserInternal(
    chatId: string,
    userId: string,
    awaitRedisWrite: boolean,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChatId || !normalizedUserId) {
      return;
    }
    const operation = this.patchChatContextInRedis(normalizedChatId, (context) =>
      this.appendChatAdminUser(context, normalizedUserId),
    );
    if (awaitRedisWrite) {
      await operation;
      return;
    }
    void this.runRedisWriteWithin(
      operation,
      ChatContextCacheService.CHAT_CONTEXT_REDIS_WRITE_TIMEOUT_MS,
    );
  }

  async replaceChatAdminUsers(chatId: string, userIds: readonly string[]): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(
        userIds
          .map((userId) => (typeof userId === 'string' ? userId.trim() : ''))
          .filter((userId): userId is string => userId.length > 0),
      ),
    );

    const patchContext = (value: ChatContext): ChatContext => {
      const currentIds = value.adminUserIds ?? [];
      if (
        currentIds.length === normalizedUserIds.length &&
        currentIds.every((userId, index) => userId === normalizedUserIds[index])
      ) {
        return value;
      }

      return {
        ...value,
        adminUserIds: normalizedUserIds,
      };
    };

    await this.patchChatContextInRedis(normalizedChatId, patchContext);
  }

  private resolveAdminAccessTtlSec(state: ChatAdminAccessState): number {
    return state === 'granted'
      ? ChatContextCacheService.ADMIN_ACCESS_GRANTED_TTL_SEC
      : ChatContextCacheService.ADMIN_ACCESS_DENIED_TTL_SEC;
  }

  private isAdminAccessEpochStrictlyNewer(
    raw: string | null,
    incomingTimestamp: number,
    incomingPriority: number,
  ): boolean {
    if (!raw) {
      return false;
    }
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator >= raw.length - 1) {
      return false;
    }
    const currentTimestamp = Number(raw.slice(0, separator));
    const currentPriority = Number(raw.slice(separator + 1));
    if (
      !Number.isSafeInteger(currentTimestamp) ||
      currentTimestamp < 0 ||
      !Number.isSafeInteger(currentPriority) ||
      currentPriority < 0
    ) {
      return false;
    }
    return (
      currentTimestamp > incomingTimestamp ||
      (currentTimestamp === incomingTimestamp && currentPriority > incomingPriority)
    );
  }

  async getManagedEntityHeader(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntityHeader | null> {
    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.managedEntityHeaderKey(chatId, entityType),
      ChatContextCacheService.MANAGED_ENTITY_HEADER_REDIS_READ_TIMEOUT_MS,
    );
    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached) as ManagedEntityHeader;
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entity header cache',
      );
      return null;
    }
  }

  async getManagedEntityHeaders(
    entities: readonly { id: string; entityType: ManagedEntityType }[],
  ): Promise<Array<ManagedEntityHeader | null>> {
    const result: Array<ManagedEntityHeader | null> = [];
    const deadline =
      Date.now() + ChatContextCacheService.MANAGED_ENTITY_HEADER_REDIS_READ_TIMEOUT_MS;
    // Bounded commands avoid both one Redis round trip per row and a giant MGET.
    for (let offset = 0; offset < entities.length; offset += 64) {
      if (Date.now() >= deadline) return result.concat(entities.slice(offset).map(() => null));
      const batch = entities.slice(offset, offset + 64);
      const values = await this.readRedisStringsWithin(
        batch.map((item) =>
          ChatContextCacheService.managedEntityHeaderKey(item.id, item.entityType),
        ),
        Math.max(1, deadline - Date.now()),
      );
      if (values === null) return result.concat(entities.slice(offset).map(() => null));
      result.push(
        ...batch.map((entity, index) => {
          try {
            const raw = values?.[index];
            const header = raw ? (JSON.parse(raw) as ManagedEntityHeader) : null;
            return header?.id === entity.id && header.entityType === entity.entityType
              ? header
              : null;
          } catch {
            return null;
          }
        }),
      );
    }
    return result;
  }

  async setManagedEntityHeader(header: ManagedEntityHeader): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntityHeaderKey(header.id, header.entityType),
      JSON.stringify(header),
      'EX',
      this.managedEntityHeaderTtlSec,
    );
  }

  async claimManagedEntityHeaderRefresh(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<boolean> {
    // FLAG: Presentation-only admission; this key never supplies access authority.
    const key = `${ChatContextCacheService.managedEntityHeaderKey(chatId, entityType)}:refresh:v1`;
    return (await this.redis.set(key, '1', 'EX', 120, 'NX')) === 'OK';
  }

  async invalidateManagedEntityHeader(
    chatId: string,
    entityType?: ManagedEntityType,
  ): Promise<void> {
    if (entityType) {
      await this.redis.del(ChatContextCacheService.managedEntityHeaderKey(chatId, entityType));
      return;
    }

    await this.redis.del(
      ChatContextCacheService.managedEntityHeaderKey(chatId, 'chat'),
      ChatContextCacheService.managedEntityHeaderKey(chatId, 'channel'),
    );
  }

  async getManagedEntityBotProfile(botId: string): Promise<ManagedEntityBotProfileSnapshot | null> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return null;
    }

    const cached = await this.readRedisStringWithin(
      ChatContextCacheService.managedEntityBotProfileKey(normalizedBotId),
      ChatContextCacheService.MANAGED_ENTITY_BOT_PROFILE_REDIS_READ_TIMEOUT_MS,
    );
    if (!cached) {
      return null;
    }

    try {
      const parsed = JSON.parse(cached) as ManagedEntityBotProfileSnapshot;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !(parsed.avatarUrl === null || typeof parsed.avatarUrl === 'string')
      ) {
        return null;
      }

      return {
        avatarUrl:
          typeof parsed.avatarUrl === 'string' && parsed.avatarUrl.trim().length > 0
            ? parsed.avatarUrl.trim()
            : null,
      };
    } catch (error: unknown) {
      this.logger.warn(
        { botId: normalizedBotId, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entity bot profile cache',
      );
      return null;
    }
  }

  async setManagedEntityBotProfile(
    botId: string,
    profile: ManagedEntityBotProfileSnapshot,
  ): Promise<void> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return;
    }

    await this.redis.set(
      ChatContextCacheService.managedEntityBotProfileKey(normalizedBotId),
      JSON.stringify({
        avatarUrl:
          typeof profile.avatarUrl === 'string' && profile.avatarUrl.trim().length > 0
            ? profile.avatarUrl.trim()
            : null,
      }),
      'EX',
      this.managedEntityBotProfileTtlSec,
    );
  }

  async isManagedEntitiesRefreshCooldownActive(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<boolean> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey(userId, entityType),
    );
    return typeof raw === 'string' && raw.length > 0;
  }

  async activateManagedEntitiesRefreshCooldown(
    userId: string,
    entityType: ManagedEntityType | 'all',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey(userId, entityType),
      '1',
      'EX',
      ttlSec,
    );
  }

  async isManagedEntitiesRefreshBackoffActive(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<boolean> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
    );
    return typeof raw === 'string' && raw.length > 0;
  }

  async getManagedEntitiesRefreshBackoffRemainingMs(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedEntitiesRefreshBackoff(
    userId: string,
    entityType: ManagedEntityType | 'all',
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey(userId, entityType),
      '1',
      'EX',
      ttlSec,
    );
  }

  async isManagedRefreshSourceBackoffActive(botId?: string): Promise<boolean> {
    const raw = await this.redis.get(ChatContextCacheService.managedRefreshSourceBackoffKey(botId));
    return typeof raw === 'string' && raw.length > 0;
  }

  async readPublisherCatalogState(key: string): Promise<string | null> {
    return this.redis.get(`publisher:catalog:v2:${key}`);
  }

  async storePublisherCatalogState(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(`publisher:catalog:v2:${key}`, value, 'EX', ttlSec);
  }

  async getManagedRefreshSourceBackoffRemainingMs(botId?: string): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedRefreshSourceBackoffKey(botId),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedRefreshSourceBackoff(ttlSec: number, botId?: string): Promise<void> {
    const key = ChatContextCacheService.managedRefreshSourceBackoffKey(botId);
    // FLAG: Concurrent shorter backoffs must not shorten an existing Retry-After.
    await this.redis.eval(
      `if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[1]) then
        redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
      end; return 1`,
      1,
      key,
      Math.max(1, Math.ceil(ttlSec * 1000)),
    );
  }

  async getManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<number | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
    );
    if (raw === null) {
      return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  async setManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
    cursor: number,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
      String(cursor),
      'EX',
      ttlSec,
    );
  }

  async clearManagedEntitiesRefreshCursor(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesRefreshCursorKey(userId, entityType),
    );
  }

  async getManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<ManagedEntitiesDiscoverySnapshot | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesDiscoverySnapshot(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        { userId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities discovery snapshot cache',
      );
      return null;
    }
  }

  async setManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
    snapshot: ManagedEntitiesDiscoverySnapshot,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
      JSON.stringify(snapshot),
      'EX',
      ttlSec,
    );
  }

  async clearManagedEntitiesDiscoverySnapshot(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesDiscoverySnapshotKey(userId, entityType),
    );
  }

  async getManagedEntitiesLastSyncedAt(
    userId: string,
    entityType: ManagedEntityType | 'all',
  ): Promise<string | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesLastSyncedKey(userId, entityType),
    );
    if (typeof raw !== 'string') {
      return null;
    }

    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }

  async setManagedEntitiesLastSyncedAt(
    userId: string,
    entityType: ManagedEntityType | 'all',
    isoValue: string,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesLastSyncedKey(userId, entityType),
      isoValue,
      'EX',
      ttlSec,
    );
  }

  async getManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<ManagedEntitiesPublishedSnapshot | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesPublishedSnapshot(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        { userId, entityType, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities published snapshot cache',
      );
      return null;
    }
  }

  async setManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
    snapshot: ManagedEntitiesPublishedSnapshot,
    ttlSec: number,
    options: ManagedEntitiesPublishedSnapshotWriteOptions,
  ): Promise<boolean> {
    const key = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType);
    const currentRaw = await this.redis.get(key);
    const currentVersion = this.parseManagedEntitiesPublishedSnapshot(currentRaw)?.version ?? null;
    if (currentVersion !== options.expectedVersion) {
      return false;
    }

    const committed = await this.redis.eval(
      SET_MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_CAS_SCRIPT,
      1,
      key,
      currentRaw === null ? '0' : '1',
      currentRaw ?? '',
      JSON.stringify(snapshot),
      String(Math.max(1, Math.trunc(ttlSec))),
    );
    return Number(committed) === 1;
  }

  async upsertManagedEntityPublishedSnapshot(
    userId: string,
    summary: ManagedEntityPublishedSnapshotUpsert & { entityType: ManagedEntityType },
    ttlSec: number,
  ): Promise<void> {
    const normalizedUserId = userId.trim();
    const normalizedChatId = summary.id.trim();
    const normalizedTtlSec = Math.trunc(ttlSec);
    if (!normalizedUserId || !normalizedChatId || normalizedTtlSec <= 0) {
      return;
    }

    const oppositeType: ManagedEntityType = summary.entityType === 'channel' ? 'chat' : 'channel';
    const currentKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      normalizedUserId,
      summary.entityType,
    );
    const oppositeKey = ChatContextCacheService.managedEntitiesPublishedSnapshotKey(
      normalizedUserId,
      oppositeType,
    );
    const builtAt = new Date().toISOString();
    const versionBase = `handshake:${normalizedChatId}:${randomUUID()}`;

    for (
      let attempt = 0;
      attempt < ChatContextCacheService.MANAGED_ENTITY_PUBLISHED_SNAPSHOT_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const [currentRaw, oppositeRaw] = await this.redis.mget(currentKey, oppositeKey);
      const currentSnapshot = this.parseManagedEntitiesPublishedSnapshot(currentRaw);
      const oppositeSnapshot = this.parseManagedEntitiesPublishedSnapshot(oppositeRaw);
      const current = this.removeManagedEntityFromSnapshot(currentSnapshot, normalizedChatId);
      const opposite = this.removeManagedEntityFromSnapshot(oppositeSnapshot, normalizedChatId);
      const previous = current.previous ?? opposite.previous;
      const nextSummary: ChatSummary = {
        ...summary,
        id: normalizedChatId,
        title: preserveManagedEntityTitle(normalizedChatId, summary.title, previous?.title),
        link: summary.link === undefined ? (previous?.link ?? null) : summary.link,
      };
      if (summary.avatarUrl === undefined && previous?.avatarUrl !== undefined) {
        nextSummary.avatarUrl = previous.avatarUrl;
      }

      const nextCurrent = this.buildManagedEntitiesPublishedSnapshot(
        currentSnapshot,
        [nextSummary, ...current.items],
        `${versionBase}:current`,
        builtAt,
      );
      const oppositeAction = opposite.previous
        ? opposite.items.length > 0
          ? 'set'
          : 'delete'
        : 'keep';
      const nextOpposite =
        oppositeAction === 'set'
          ? this.buildManagedEntitiesPublishedSnapshot(
              oppositeSnapshot,
              opposite.items,
              `${versionBase}:opposite`,
              builtAt,
            )
          : null;

      const committed = await this.redis.eval(
        UPSERT_MANAGED_ENTITY_PUBLISHED_SNAPSHOT_CAS_SCRIPT,
        2,
        currentKey,
        oppositeKey,
        currentRaw === null ? '0' : '1',
        currentRaw ?? '',
        oppositeRaw === null ? '0' : '1',
        oppositeRaw ?? '',
        JSON.stringify(nextCurrent),
        oppositeAction,
        nextOpposite ? JSON.stringify(nextOpposite) : '',
        String(normalizedTtlSec),
      );
      if (Number(committed) === 1) {
        return;
      }
    }

    throw new Error('Managed entity published snapshot update conflicted repeatedly');
  }

  private parseManagedEntitiesPublishedSnapshot(
    raw: string | null,
  ): ManagedEntitiesPublishedSnapshot | null {
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesPublishedSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private removeManagedEntityFromSnapshot(
    snapshot: ManagedEntitiesPublishedSnapshot | null,
    chatId: string,
  ): { items: ChatSummary[]; previous: ChatSummary | null } {
    let previous: ChatSummary | null = null;
    const items = (snapshot?.items ?? []).filter((item) => {
      if (item.id === chatId) {
        previous = item;
        return false;
      }
      return true;
    });
    return { items, previous };
  }

  private buildManagedEntitiesPublishedSnapshot(
    previous: ManagedEntitiesPublishedSnapshot | null,
    items: ChatSummary[],
    version: string,
    builtAt: string,
  ): ManagedEntitiesPublishedSnapshot {
    const lastSyncedAt = previous?.lastSyncedAt ?? null;
    return {
      version,
      builtAt,
      lastSyncedAt,
      itemCount: items.length,
      itemsHash: createHash('sha256').update(JSON.stringify({ lastSyncedAt, items })).digest('hex'),
      items,
    };
  }

  private serializeOpaqueRedisMutation(mutation: OpaqueRedisMutation): string[] {
    return [
      mutation.expectedRaw === null ? '0' : '1',
      mutation.expectedRaw ?? '',
      mutation.action,
      mutation.nextRaw,
      String(mutation.ttlSec),
    ];
  }

  private buildOpaqueRedisMutation(
    expectedRaw: string | null,
    nextRaw: string | null | undefined,
    ttlSec: number,
  ): OpaqueRedisMutation {
    if (nextRaw === undefined || nextRaw === expectedRaw) {
      return { expectedRaw, action: 'keep', nextRaw: '', ttlSec };
    }
    if (nextRaw === null) {
      return { expectedRaw, action: 'delete', nextRaw: '', ttlSec };
    }
    return { expectedRaw, action: 'set', nextRaw, ttlSec };
  }

  private buildAdminAccessChatContextMutation(
    raw: string | null,
    userId: string,
    granted: boolean,
  ): OpaqueRedisMutation {
    if (!raw) {
      return this.buildOpaqueRedisMutation(
        raw,
        undefined,
        ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
      );
    }
    try {
      const context = JSON.parse(raw) as ChatContext;
      if (!context || !Array.isArray(context.adminUserIds)) {
        return this.buildOpaqueRedisMutation(
          raw,
          undefined,
          ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
        );
      }
      const adminUserIds = Array.from(
        new Set(
          context.adminUserIds
            .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
            .filter((candidate) => candidate.length > 0),
        ),
      );
      const userIdFamily = new Set(this.buildUserIdVariants(userId));
      const familyIndexes = adminUserIds
        .map((candidate, index) => (userIdFamily.has(candidate.toLowerCase()) ? index : -1))
        .filter((index) => index >= 0);
      if ((!granted && familyIndexes.length === 0) || (granted && familyIndexes.length === 1)) {
        return this.buildOpaqueRedisMutation(
          raw,
          undefined,
          ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
        );
      }
      const withoutFamily = adminUserIds.filter(
        (candidate) => !userIdFamily.has(candidate.toLowerCase()),
      );
      const nextAdminUserIds = granted ? [...withoutFamily, userId] : withoutFamily;
      return this.buildOpaqueRedisMutation(
        raw,
        JSON.stringify({ ...context, adminUserIds: nextAdminUserIds }),
        ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
      );
    } catch {
      return this.buildOpaqueRedisMutation(
        raw,
        undefined,
        ChatContextCacheService.CHAT_CONTEXT_TTL_SEC,
      );
    }
  }

  private buildAdminAccessPublishedSnapshotMutations(params: {
    chatId: string;
    state: ChatAdminAccessState;
    summary?: ManagedEntityPublishedSnapshotUpsert & { entityType: ManagedEntityType };
    chatRaw: string | null;
    channelRaw: string | null;
    ttlSec: number;
  }): [OpaqueRedisMutation, OpaqueRedisMutation] {
    const chatSnapshot = this.parseManagedEntitiesPublishedSnapshot(params.chatRaw);
    const channelSnapshot = this.parseManagedEntitiesPublishedSnapshot(params.channelRaw);
    const chatWithoutEntity = this.removeManagedEntityFromSnapshot(chatSnapshot, params.chatId);
    const channelWithoutEntity = this.removeManagedEntityFromSnapshot(
      channelSnapshot,
      params.chatId,
    );
    const versionBase = `access:${params.chatId}:${randomUUID()}`;
    const builtAt = new Date().toISOString();

    const buildRemovedRaw = (
      snapshot: ManagedEntitiesPublishedSnapshot | null,
      remaining: ChatSummary[],
      previous: ChatSummary | null,
      suffix: string,
    ): string | null | undefined => {
      if (!previous || !snapshot) {
        return undefined;
      }
      return remaining.length === 0
        ? null
        : JSON.stringify(
            this.buildManagedEntitiesPublishedSnapshot(
              snapshot,
              remaining,
              `${versionBase}:${suffix}`,
              builtAt,
            ),
          );
    };

    if (params.state !== 'granted' || !params.summary) {
      if (params.state === 'granted') {
        return [
          this.buildOpaqueRedisMutation(params.chatRaw, undefined, params.ttlSec),
          this.buildOpaqueRedisMutation(params.channelRaw, undefined, params.ttlSec),
        ];
      }
      return [
        this.buildOpaqueRedisMutation(
          params.chatRaw,
          buildRemovedRaw(
            chatSnapshot,
            chatWithoutEntity.items,
            chatWithoutEntity.previous,
            'chat-remove',
          ),
          params.ttlSec,
        ),
        this.buildOpaqueRedisMutation(
          params.channelRaw,
          buildRemovedRaw(
            channelSnapshot,
            channelWithoutEntity.items,
            channelWithoutEntity.previous,
            'channel-remove',
          ),
          params.ttlSec,
        ),
      ];
    }

    const summary = params.summary;
    const targetSnapshot = summary.entityType === 'chat' ? chatSnapshot : channelSnapshot;
    const targetWithoutEntity =
      summary.entityType === 'chat' ? chatWithoutEntity : channelWithoutEntity;
    const oppositeSnapshot = summary.entityType === 'chat' ? channelSnapshot : chatSnapshot;
    const oppositeWithoutEntity =
      summary.entityType === 'chat' ? channelWithoutEntity : chatWithoutEntity;
    const previous = targetWithoutEntity.previous ?? oppositeWithoutEntity.previous;
    const nextSummary: ChatSummary = {
      ...summary,
      id: params.chatId,
      title: preserveManagedEntityTitle(params.chatId, summary.title, previous?.title),
      link: summary.link === undefined ? (previous?.link ?? null) : summary.link,
    };
    if (summary.avatarUrl === undefined && previous?.avatarUrl !== undefined) {
      nextSummary.avatarUrl = previous.avatarUrl;
    }
    const nextTarget = JSON.stringify(
      this.buildManagedEntitiesPublishedSnapshot(
        targetSnapshot,
        [nextSummary, ...targetWithoutEntity.items],
        `${versionBase}:${summary.entityType}-upsert`,
        builtAt,
      ),
    );
    const nextOpposite = buildRemovedRaw(
      oppositeSnapshot,
      oppositeWithoutEntity.items,
      oppositeWithoutEntity.previous,
      summary.entityType === 'chat' ? 'channel-remove' : 'chat-remove',
    );
    const targetMutation = this.buildOpaqueRedisMutation(
      summary.entityType === 'chat' ? params.chatRaw : params.channelRaw,
      nextTarget,
      params.ttlSec,
    );
    const oppositeMutation = this.buildOpaqueRedisMutation(
      summary.entityType === 'chat' ? params.channelRaw : params.chatRaw,
      nextOpposite,
      params.ttlSec,
    );
    return summary.entityType === 'chat'
      ? [targetMutation, oppositeMutation]
      : [oppositeMutation, targetMutation];
  }

  private buildAdminAccessRecentBootstrapMutations(params: {
    chatId: string;
    userId: string;
    state: ChatAdminAccessState;
    summary?: ChatSummary;
    globalChatRaw: string | null;
    userChatRaw: string | null;
    globalChannelRaw: string | null;
    userChannelRaw: string | null;
    ttlSec: number;
  }): [OpaqueRedisMutation, OpaqueRedisMutation, OpaqueRedisMutation, OpaqueRedisMutation] {
    const buildForType = (
      entityType: ManagedEntityType,
      globalRaw: string | null,
      userRaw: string | null,
    ): [OpaqueRedisMutation, OpaqueRedisMutation] => {
      const global = this.parseManagedEntitiesRecentBootstrapRaw(globalRaw);
      const user = this.parseManagedEntitiesRecentBootstrapRaw(userRaw);
      if (params.state === 'granted' && params.summary?.entityType === entityType) {
        const previousGlobal = global.find((entry) => entry.id.trim() === params.chatId);
        const previousUser = user.find((entry) => entry.id.trim() === params.chatId);
        const mergedUserIds = Array.from(
          new Set([
            params.userId,
            ...(previousGlobal?.bootstrapUserIds ?? [])
              .map((candidate) => candidate.trim())
              .filter((candidate) => candidate.length > 0),
          ]),
        ).slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS);
        const globalEntry: ManagedEntitiesRecentBootstrapEntry = {
          ...params.summary,
          title: preserveManagedEntityTitle(
            params.chatId,
            params.summary.title,
            previousGlobal?.title,
          ),
          bootstrapUserIds: mergedUserIds,
        };
        const userEntry = this.ensureRecentBootstrapEntryUser(
          previousUser
            ? {
                ...previousUser,
                ...params.summary,
                title: preserveManagedEntityTitle(
                  params.chatId,
                  params.summary.title,
                  previousUser.title,
                ),
              }
            : globalEntry,
          params.userId,
        );
        const nextGlobal = [
          globalEntry,
          ...global.filter((entry) => entry.id.trim() !== params.chatId),
        ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_ITEMS);
        const nextUser = [
          userEntry,
          ...user.filter((entry) => entry.id.trim() !== params.chatId),
        ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_ITEMS);
        return [
          this.buildOpaqueRedisMutation(globalRaw, JSON.stringify(nextGlobal), params.ttlSec),
          this.buildOpaqueRedisMutation(userRaw, JSON.stringify(nextUser), params.ttlSec),
        ];
      }

      if (params.state === 'granted' && params.summary) {
        return this.buildRecentBootstrapUserRemovalMutations(
          globalRaw,
          userRaw,
          global,
          user,
          params.chatId,
          params.userId,
          params.ttlSec,
        );
      }
      if (params.state === 'granted') {
        return [
          this.buildOpaqueRedisMutation(globalRaw, undefined, params.ttlSec),
          this.buildOpaqueRedisMutation(userRaw, undefined, params.ttlSec),
        ];
      }
      return this.buildRecentBootstrapUserRemovalMutations(
        globalRaw,
        userRaw,
        global,
        user,
        params.chatId,
        params.userId,
        params.ttlSec,
      );
    };

    const [globalChat, userChat] = buildForType('chat', params.globalChatRaw, params.userChatRaw);
    const [globalChannel, userChannel] = buildForType(
      'channel',
      params.globalChannelRaw,
      params.userChannelRaw,
    );
    return [globalChat, userChat, globalChannel, userChannel];
  }

  private buildRecentBootstrapUserRemovalMutations(
    globalRaw: string | null,
    userRaw: string | null,
    global: ManagedEntitiesRecentBootstrapSnapshot,
    user: ManagedEntitiesRecentBootstrapSnapshot,
    chatId: string,
    userId: string,
    ttlSec: number,
  ): [OpaqueRedisMutation, OpaqueRedisMutation] {
    let globalChanged = false;
    const nextGlobal = global.map((entry) => {
      if (entry.id.trim() !== chatId || !entry.bootstrapUserIds?.includes(userId)) {
        return entry;
      }
      globalChanged = true;
      const bootstrapUserIds = entry.bootstrapUserIds.filter((candidate) => candidate !== userId);
      if (bootstrapUserIds.length === 0) {
        const withoutUsers: ManagedEntitiesRecentBootstrapSnapshot[number] = { ...entry };
        delete withoutUsers.bootstrapUserIds;
        return withoutUsers;
      }
      return { ...entry, bootstrapUserIds };
    });
    const nextUser = user.filter((entry) => entry.id.trim() !== chatId);
    return [
      this.buildOpaqueRedisMutation(
        globalRaw,
        globalChanged ? JSON.stringify(nextGlobal) : undefined,
        ttlSec,
      ),
      this.buildOpaqueRedisMutation(
        userRaw,
        nextUser.length === user.length
          ? undefined
          : nextUser.length > 0
            ? JSON.stringify(nextUser)
            : null,
        ttlSec,
      ),
    ];
  }

  private parseManagedEntitiesRecentBootstrapRaw(
    raw: string | null,
  ): ManagedEntitiesRecentBootstrapSnapshot {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesRecentBootstrapSnapshot(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private buildUserIdVariants(value: string): string[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    return Array.from(
      new Set([
        normalized,
        normalized.startsWith('id') && normalized.length > 2
          ? normalized.slice(2)
          : `id${normalized}`,
      ]),
    );
  }

  async clearManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, entityType),
    );
  }

  async clearManagedEntitiesPublishedSnapshotsForUsers(userIds: readonly string[]): Promise<void> {
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((userId) => userId.length > 0)),
    );
    if (normalizedUserIds.length === 0) {
      return;
    }

    await this.redis.del(
      ...normalizedUserIds.flatMap((userId) => [
        ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, 'chat'),
        ChatContextCacheService.managedEntitiesPublishedSnapshotKey(userId, 'channel'),
      ]),
    );
  }

  async getManagedEntitiesPublishedDiff(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
  ): Promise<ManagedEntitiesPublishedDiff | null> {
    const raw = await this.redis.get(
      ChatContextCacheService.managedEntitiesPublishedDiffKey(userId, entityType, baseVersion),
    );
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesPublishedDiff(parsed) ? parsed : null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          entityType,
          baseVersion,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse managed entities published diff cache',
      );
      return null;
    }
  }

  async setManagedEntitiesPublishedDiff(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
    diff: ManagedEntitiesPublishedDiff,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedEntitiesPublishedDiffKey(userId, entityType, baseVersion),
      JSON.stringify(diff),
      'EX',
      ttlSec,
    );
  }

  async getManagedEntitiesRecentBootstrap(
    entityType: ManagedEntityType,
    userId?: string | null,
  ): Promise<ManagedEntitiesRecentBootstrapSnapshot> {
    const global = await this.getManagedEntitiesRecentBootstrapFromKey(
      ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType),
      { entityType },
    );
    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    if (!normalizedUserId) {
      return global;
    }

    const userScoped = (
      await this.getManagedEntitiesRecentBootstrapFromKey(
        ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(entityType, normalizedUserId),
        { entityType, userId: normalizedUserId },
      )
    ).map((entry) => this.ensureRecentBootstrapEntryUser(entry, normalizedUserId));

    return this.mergeManagedEntitiesRecentBootstrapEntries(userScoped, global);
  }

  private async getManagedEntitiesRecentBootstrapFromKey(
    key: string,
    logData: {
      entityType: ManagedEntityType;
      userId?: string | null;
    },
  ): Promise<ManagedEntitiesRecentBootstrapSnapshot> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.isManagedEntitiesRecentBootstrapSnapshot(parsed) ? parsed : [];
    } catch (error: unknown) {
      this.logger.warn(
        { ...logData, err: error instanceof Error ? error.message : String(error) },
        'Failed to parse managed entities recent bootstrap cache',
      );
      return [];
    }
  }

  private mergeManagedEntitiesRecentBootstrapEntries(
    ...groups: ManagedEntitiesRecentBootstrapSnapshot[]
  ): ManagedEntitiesRecentBootstrapSnapshot {
    const merged = new Map<string, ManagedEntitiesRecentBootstrapEntry>();
    for (const group of groups) {
      for (const entry of group) {
        const chatId = entry.id.trim();
        if (!chatId || merged.has(chatId)) {
          continue;
        }
        merged.set(chatId, entry);
      }
    }
    return [...merged.values()];
  }

  private ensureRecentBootstrapEntryUser(
    entry: ManagedEntitiesRecentBootstrapEntry,
    userId: string,
  ): ManagedEntitiesRecentBootstrapEntry {
    const bootstrapUserIds = Array.from(
      new Set([
        userId,
        ...(entry.bootstrapUserIds ?? [])
          .map((value) =>
            typeof value === 'string' && value.trim().length > 0 ? value.trim() : null,
          )
          .filter((value): value is string => Boolean(value)),
      ]),
    ).slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS);

    return {
      ...entry,
      bootstrapUserIds,
    };
  }

  async upsertManagedEntitiesRecentBootstrap(
    item: ChatSummary,
    ttlSec: number,
    userId?: string | null,
  ): Promise<void> {
    const normalizedChatId = item.id.trim();
    const normalizedTtlSec = Math.trunc(ttlSec);
    if (!normalizedChatId || normalizedTtlSec <= 0) {
      return;
    }

    const entityType = item.entityType;
    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    const globalKey = ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType);
    const userKey = ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(
      entityType,
      normalizedUserId ?? '__none__',
    );
    const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
      normalizedChatId,
      entityType,
    );
    const chatUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
      normalizedChatId,
      entityType,
    );

    for (
      let attempt = 0;
      attempt < ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const [globalRaw, userRaw] = await this.redis.mget(globalKey, userKey);
      const current = this.parseManagedEntitiesRecentBootstrapRaw(globalRaw);
      const existing = current.find((entry) => entry.id.trim() === normalizedChatId) ?? null;
      const mergedBootstrapUserIds = Array.from(
        new Set([
          ...(normalizedUserId ? [normalizedUserId] : []),
          ...(existing?.bootstrapUserIds ?? [])
            .map((value) =>
              typeof value === 'string' && value.trim().length > 0 ? value.trim() : null,
            )
            .filter((value): value is string => Boolean(value)),
        ]),
      ).slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_IDS);
      const nextEntry: ManagedEntitiesRecentBootstrapEntry = {
        ...item,
        title: preserveManagedEntityTitle(normalizedChatId, item.title, existing?.title),
        ...(mergedBootstrapUserIds.length > 0 ? { bootstrapUserIds: mergedBootstrapUserIds } : {}),
      };
      const next = [
        nextEntry,
        ...current.filter((entry) => entry.id.trim() !== normalizedChatId),
      ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_ITEMS);
      const currentUserScoped = normalizedUserId
        ? this.parseManagedEntitiesRecentBootstrapRaw(userRaw)
        : [];
      const nextUserScoped = normalizedUserId
        ? [
            this.ensureRecentBootstrapEntryUser(
              {
                ...nextEntry,
                title: preserveManagedEntityTitle(
                  normalizedChatId,
                  item.title,
                  currentUserScoped.find((entry) => entry.id.trim() === normalizedChatId)?.title ??
                    nextEntry.title,
                ),
              },
              normalizedUserId,
            ),
            ...currentUserScoped.filter((entry) => entry.id.trim() !== normalizedChatId),
          ].slice(0, ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_MAX_USER_ITEMS)
        : [];
      const committed = await this.redis.eval(
        UPSERT_MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_SCRIPT,
        4,
        globalKey,
        userKey,
        indexKey,
        chatUsersKey,
        globalRaw === null ? '0' : '1',
        globalRaw ?? '',
        JSON.stringify(next),
        normalizedUserId ? '1' : '0',
        userRaw === null ? '0' : '1',
        userRaw ?? '',
        JSON.stringify(nextUserScoped),
        String(normalizedTtlSec),
        normalizedUserId ?? '',
      );
      if (Number(committed) === 1) {
        return;
      }
    }

    throw new Error(
      `Managed entities recent bootstrap update conflicted repeatedly for chat ${normalizedChatId}`,
    );
  }

  async removeManagedEntitiesRecentBootstrap(
    entityType: ManagedEntityType,
    chatId: string,
    userId?: string | null,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserId =
      typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
    const key = normalizedUserId
      ? ChatContextCacheService.managedEntitiesRecentBootstrapUserKey(entityType, normalizedUserId)
      : ChatContextCacheService.managedEntitiesRecentBootstrapKey(entityType);
    const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
      normalizedChatId,
      entityType,
    );
    const chatUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
      normalizedChatId,
      entityType,
    );

    for (
      let attempt = 0;
      attempt < ChatContextCacheService.MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const raw = await this.redis.get(key);
      const current = this.parseManagedEntitiesRecentBootstrapRaw(raw);
      const next = current.filter((entry) => entry.id.trim() !== normalizedChatId);
      const changed = next.length !== current.length;
      const remainingTtlSec = changed && next.length > 0 ? await this.redis.ttl(key) : 1;
      const action = !changed ? 'keep' : next.length > 0 ? 'set' : 'delete';
      const committed = await this.redis.eval(
        REMOVE_MANAGED_ENTITIES_RECENT_BOOTSTRAP_CAS_SCRIPT,
        3,
        key,
        indexKey,
        chatUsersKey,
        raw === null ? '0' : '1',
        raw ?? '',
        action,
        changed && next.length > 0 ? JSON.stringify(next) : '',
        String(remainingTtlSec > 0 ? remainingTtlSec : 1),
        normalizedUserId ? 'user' : 'global',
        normalizedUserId ?? '',
      );
      if (Number(committed) === 1) {
        return;
      }
    }

    throw new Error(
      `Managed entities recent bootstrap removal conflicted repeatedly for chat ${normalizedChatId}`,
    );
  }

  async clearManagedEntitiesRecentBootstrapForChat(
    chatId: string,
    entityType: ManagedEntityType | null,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const entityTypes: ManagedEntityType[] =
      entityType === 'chat' || entityType === 'channel' ? [entityType] : ['chat', 'channel'];

    for (const currentEntityType of entityTypes) {
      const indexKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatIndexKey(
        normalizedChatId,
        currentEntityType,
      );
      const exists = await this.redis.exists(indexKey);
      if (exists === 0) {
        continue;
      }

      const chatUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
        normalizedChatId,
        currentEntityType,
      );
      const userIds = await this.redis.smembers(chatUsersKey);
      await Promise.all([
        this.removeManagedEntitiesRecentBootstrap(currentEntityType, normalizedChatId),
        ...userIds
          .map((userId) =>
            typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null,
          )
          .filter((userId): userId is string => Boolean(userId))
          .map((userId) =>
            this.removeManagedEntitiesRecentBootstrap(currentEntityType, normalizedChatId, userId),
          ),
      ]);
    }
  }

  async getManagedGiveawayRunnerBackoffRemainingMs(giveawayId: string): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedGiveawayRunnerBackoff(giveawayId: string, ttlSec: number): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      '1',
      'EX',
      ttlSec,
    );
  }

  async getManagedGiveawayRunnerDeferRemainingMs(giveawayId: string): Promise<number> {
    const ttlMs = await this.redis.pttl(
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
    );
    return ttlMs > 0 ? ttlMs : 0;
  }

  async activateManagedGiveawayRunnerDefer(giveawayId: string, ttlSec: number): Promise<void> {
    await this.redis.set(
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
      '1',
      'EX',
      ttlSec,
    );
  }

  async incrementManagedGiveawayRunnerFailureCount(
    giveawayId: string,
    ttlSec: number,
  ): Promise<number> {
    const key = ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId);
    const result = await this.redis.multi().incr(key).expire(key, ttlSec).exec();
    const count = result?.[0]?.[1];
    return typeof count === 'number' ? count : Number.parseInt(String(count ?? '1'), 10) || 1;
  }

  async clearManagedGiveawayRunnerRetryCounters(giveawayId: string): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId),
    );
  }

  async clearManagedGiveawayRunnerFailureState(giveawayId: string): Promise<void> {
    await this.redis.del(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey(giveawayId),
      ChatContextCacheService.managedGiveawayRunnerDeferKey(giveawayId),
    );
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 1) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private async loadAndCache(
    chatId: string,
    chatTitle: string | null,
    generation: ChatContextReadGeneration,
  ): Promise<ChatContext> {
    const title = chatTitle?.trim();
    for (
      let attempt = 0;
      attempt < ChatContextCacheService.CHAT_CONTEXT_REVISION_LOAD_MAX_ATTEMPTS;
      attempt += 1
    ) {
      // FLAG: Capture the distributed generation before the DB read. A membership mutation bumps
      // it atomically, so an older full-context load can never restore stale adminUserIds.
      const expectedRevision = await this.readChatContextRevision(chatId);
      this.cacheActivity.sourceLoads += 1;
      const candidate = this.settingsTemplates.get(chatId);
      if (candidate) this.settingsSourceActivity.shellReads += 1;
      const source = await readChatContextSource(this.prisma, chatId, new Date(), candidate);
      if (source.mode === 'shell') this.settingsSourceActivity.reuses += 1;
      else this.settingsSourceActivity.fullLoads += 1;
      // FLAG: Only a coherent SQL snapshot binds the private settings to this proof.
      // Initialization and Redis bodies cannot seed or validate a reusable template.
      if (source.mode === 'full' && source.row?.settings && source.proof) {
        this.settingsTemplates.set(chatId, { settings: source.row.settings, proof: source.proof });
      } else if (!source.row?.settings || !source.proof) {
        this.settingsTemplates.delete(chatId);
      }
      let chat = source.row;
      if (!chat?.settings) {
        chat = await this.initializeChatContextRow(chatId, title);
      }

      if (!chat) {
        throw new Error(`Chat context missing for chat ${chatId}`);
      }
      if (!chat.settings) {
        throw new Error(`Chat settings missing after initialization for chat ${chatId}`);
      }

      this.maxBotLinkService.rememberChatBotBinding?.(chat.id, chat.primaryBotId ?? chat.botId);
      const resolvedTitle = title || chat.title;
      if (title && chat.title !== title) {
        void this.persistTitle(chatId, title);
      }

      const value: ChatContext = {
        chatId: chat.id,
        title: resolvedTitle,
        settings: { ...chat.settings, linkRulesPolicy: chat.settings.linkRulesPolicy ?? null },
        domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
        adminUserIds: (chat.admins ?? []).map((item) => item.userId),
        adminRoster: 'adminRosterState' in chat ? (chat.adminRosterState ?? null) : null,
        rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
        rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
      };

      if (!this.isChatContextReadGenerationCurrent(chatId, generation)) {
        return value;
      }
      const encoded = await this.mediaCache.encode(value);
      if (!(await this.writeChatContextAtRevision(chatId, encoded, expectedRevision))) {
        continue;
      }
      if (this.isChatContextReadGenerationCurrent(chatId, generation)) {
        this.writeLocalChatContext(chatId, value, encoded.fullBytesEstimate);
      }
      return value;
    }

    throw new Error(`Chat context revision changed repeatedly while loading chat ${chatId}`);
  }

  private async loadCachedOrSource(
    chatId: string,
    normalizedTitle: string | null,
    generation: ChatContextReadGeneration,
  ): Promise<ChatContext> {
    const key = ChatContextCacheService.cacheKey(chatId);
    // FLAG: Atomically bind the cached body to the shared revision, including mutations made
    // by an older rollback image. A missing version proof must reload the complete SQL source.
    this.cacheActivity.redisReads += 1;
    const snapshot = await this.readRedisStringsWithin(
      [
        key,
        ChatContextCacheService.cachedContextRevisionKey(chatId),
        ChatContextCacheService.chatContextRevisionKey(chatId),
      ],
      ChatContextCacheService.CHAT_CONTEXT_REDIS_READ_TIMEOUT_MS,
    );
    const cached =
      snapshot && snapshot[1] !== null && snapshot[1] === (snapshot[2] ?? '0') ? snapshot[0] : null;
    if (!snapshot) this.cacheActivity.redisReadUnavailable += 1;
    if (snapshot?.[0] && !cached) this.cacheActivity.redisRevisionMisses += 1;
    if (!cached) this.cacheActivity.redisMisses += 1;
    if (cached && this.isChatContextReadGenerationCurrent(chatId, generation)) {
      try {
        const decoded = await this.mediaCache.decode(cached);
        // FLAG: A pre-policy v4 body cannot establish that SQL still has no link rules.
        // Reload under the existing distributed revision fence before caching it locally.
        if (!Object.hasOwn(decoded.value.settings, 'linkRulesPolicy')) {
          this.cacheActivity.redisIncompatiblePayloads += 1;
          return this.loadAndCache(chatId, normalizedTitle, generation);
        }
        this.cacheActivity.redisHits += 1;
        if (this.isChatContextReadGenerationCurrent(chatId, generation)) {
          this.writeLocalChatContext(chatId, decoded.value, decoded.fullBytesEstimate);
        }
        return this.reconcileCachedChatTitle(chatId, decoded.value, normalizedTitle, generation);
      } catch (error: unknown) {
        this.cacheActivity.redisDecodeFailures += 1;
        this.logger.warn(
          { chatId, err: error instanceof Error ? error.message : String(error) },
          'Failed to read complete chat context cache',
        );
      }
    }

    return this.loadAndCache(chatId, normalizedTitle, generation);
  }

  private async initializeChatContextRow(chatId: string, title?: string | null) {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    const resolvedRoute =
      typeof routeResolver.resolveBotRoute === 'function'
        ? await routeResolver.resolveBotRoute({
            purpose: 'default',
            chatId,
          })
        : null;
    const resolvedBotId =
      resolvedRoute?.botId ??
      (typeof this.maxBotLinkService.resolveBotId === 'function'
        ? await this.maxBotLinkService.resolveBotId({ chatId })
        : null) ??
      this.maxBotLinkService.getContextOrDefaultBotId();
    return this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        botId: resolvedBotId,
        primaryBotId: resolvedBotId,
        title: title || `Chat ${chatId}`,
        settings: {
          create: {},
        },
      },
      update: {
        ...(title ? { title } : {}),
        settings: {
          upsert: {
            create: {},
            update: {},
          },
        },
      },
      include: {
        settings: true,
        rules: {
          select: {
            publishedUrl: true,
            publishedMessageId: true,
          },
        },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: {
            domain: true,
          },
        },
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });
  }

  private async persistTitle(chatId: string, title: string) {
    try {
      await this.prisma.chat.updateMany({
        where: {
          id: chatId,
          title: {
            not: title,
          },
        },
        data: { title },
      });
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to persist chat title from cache hit',
      );
    }
  }

  private reconcileCachedChatTitle(
    chatId: string,
    value: ChatContext,
    normalizedTitle: string | null,
    generation: ChatContextReadGeneration,
  ): ChatContext {
    if (!normalizedTitle || value.title === normalizedTitle) {
      return value;
    }

    const nextValue: ChatContext = {
      ...value,
      title: normalizedTitle,
    };
    if (this.isChatContextReadGenerationCurrent(chatId, generation)) {
      this.localChatContextCache.replace(chatId, nextValue);
    }
    void this.runRedisWriteWithin(
      this.patchChatContextInRedis(
        chatId,
        (current) =>
          current.title === normalizedTitle ? current : { ...current, title: normalizedTitle },
        'title_changed',
      ),
      ChatContextCacheService.CHAT_CONTEXT_REDIS_WRITE_TIMEOUT_MS,
    );
    void this.persistTitle(chatId, normalizedTitle);
    return nextValue;
  }

  private isManagedEntitiesDiscoverySnapshot(
    value: unknown,
  ): value is ManagedEntitiesDiscoverySnapshot {
    return (
      Array.isArray(value) &&
      value.every((item) => {
        if (!item || typeof item !== 'object') {
          return false;
        }

        const row = item as Record<string, unknown>;
        return (
          typeof row.chatId === 'string' &&
          (row.title === null || typeof row.title === 'string') &&
          (row.lastEventTime === null || typeof row.lastEventTime === 'number') &&
          (row.entityType === 'chat' || row.entityType === 'channel') &&
          (row.link === null || typeof row.link === 'string') &&
          (row.avatarUrl === null || typeof row.avatarUrl === 'string')
        );
      })
    );
  }

  private isManagedEntitiesRecentBootstrapSnapshot(
    value: unknown,
  ): value is ManagedEntitiesRecentBootstrapSnapshot {
    return (
      Array.isArray(value) &&
      value.every((item) => this.isManagedEntitiesRecentBootstrapEntry(item))
    );
  }

  private isManagedEntitiesRecentBootstrapEntry(
    value: unknown,
  ): value is ManagedEntitiesRecentBootstrapEntry {
    if (!this.isChatSummary(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      record.bootstrapUserIds === undefined ||
      (Array.isArray(record.bootstrapUserIds) &&
        record.bootstrapUserIds.every((userId) => typeof userId === 'string'))
    );
  }

  private isManagedEntitiesPublishedSnapshot(
    value: unknown,
  ): value is ManagedEntitiesPublishedSnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.version !== 'string' ||
      typeof record.builtAt !== 'string' ||
      (record.lastSyncedAt !== null && typeof record.lastSyncedAt !== 'string') ||
      typeof record.itemCount !== 'number' ||
      !Number.isInteger(record.itemCount) ||
      record.itemCount < 0 ||
      typeof record.itemsHash !== 'string' ||
      !Array.isArray(record.items)
    ) {
      return false;
    }

    return record.items.every((item) => this.isChatSummary(item));
  }

  private isManagedEntitiesPublishedDiff(value: unknown): value is ManagedEntitiesPublishedDiff {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.baseVersion !== 'string' ||
      typeof record.nextVersion !== 'string' ||
      !Array.isArray(record.added) ||
      !Array.isArray(record.updated) ||
      !Array.isArray(record.removedIds) ||
      !Array.isArray(record.orderedIds) ||
      typeof record.changeCount !== 'number' ||
      !Number.isInteger(record.changeCount) ||
      record.changeCount < 0
    ) {
      return false;
    }

    return (
      record.added.every((item) => this.isChatSummary(item)) &&
      record.updated.every((item) => this.isChatSummary(item)) &&
      record.removedIds.every((item) => typeof item === 'string' && item.trim().length > 0) &&
      record.orderedIds.every((item) => typeof item === 'string' && item.trim().length > 0)
    );
  }

  private isChatSummary(value: unknown): value is ChatSummary {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.title !== 'string' ||
      typeof record.createdAt !== 'string' ||
      (record.entityType !== undefined &&
        record.entityType !== 'chat' &&
        record.entityType !== 'channel') ||
      (record.link !== undefined && record.link !== null && typeof record.link !== 'string') ||
      (record.avatarUrl !== undefined &&
        record.avatarUrl !== null &&
        typeof record.avatarUrl !== 'string') ||
      (record.primaryBotId !== undefined &&
        record.primaryBotId !== null &&
        typeof record.primaryBotId !== 'string') ||
      (record.sharedMode !== undefined &&
        record.sharedMode !== 'owned' &&
        record.sharedMode !== 'shared-standby' &&
        record.sharedMode !== 'shared-assist' &&
        record.sharedMode !== 'shared-failover')
    ) {
      return false;
    }

    if (
      record.channelOverview !== undefined &&
      record.channelOverview !== null &&
      !this.isChannelOverview(record.channelOverview)
    ) {
      return false;
    }

    if (
      record.assignedBots !== undefined &&
      (!Array.isArray(record.assignedBots) ||
        !record.assignedBots.every((item) => this.isManagedEntityAssignedBot(item)))
    ) {
      return false;
    }

    return true;
  }

  private isChannelOverview(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      typeof record.enabledScenariosCount === 'number' &&
      Number.isInteger(record.enabledScenariosCount) &&
      record.enabledScenariosCount >= 0 &&
      typeof record.commentsEnabled === 'boolean' &&
      typeof record.postSuggestionsEnabled === 'boolean' &&
      typeof record.commentsModerationEnabled === 'boolean'
    );
  }

  private isManagedEntityAssignedBot(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    if (
      typeof record.botId !== 'string' ||
      typeof record.label !== 'string' ||
      (record.role !== undefined && record.role !== 'primary' && record.role !== 'standby') ||
      (record.membershipStatus !== undefined &&
        record.membershipStatus !== 'active' &&
        record.membershipStatus !== 'removed') ||
      (record.lifecycleState !== undefined &&
        record.lifecycleState !== 'active' &&
        record.lifecycleState !== 'dormant' &&
        record.lifecycleState !== 'draining' &&
        record.lifecycleState !== 'disabled') ||
      (record.speechPersona !== undefined &&
        record.speechPersona !== 'male' &&
        record.speechPersona !== 'female' &&
        record.speechPersona !== 'neutral') ||
      (record.characterName !== undefined &&
        record.characterName !== null &&
        typeof record.characterName !== 'string') ||
      (record.avatarUrl !== undefined &&
        record.avatarUrl !== null &&
        typeof record.avatarUrl !== 'string')
    ) {
      return false;
    }

    if (
      record.capabilities !== undefined &&
      (!Array.isArray(record.capabilities) ||
        !record.capabilities.every((capability) => typeof capability === 'string'))
    ) {
      return false;
    }

    if (
      record.permissionsSummary !== undefined &&
      record.permissionsSummary !== null &&
      !this.isManagedEntityPermissionsSummary(record.permissionsSummary)
    ) {
      return false;
    }

    return true;
  }

  private isManagedEntityPermissionsSummary(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      (record.checkedAt === null ||
        record.checkedAt === undefined ||
        typeof record.checkedAt === 'string') &&
      typeof record.isAdmin === 'boolean' &&
      typeof record.isOwner === 'boolean' &&
      Array.isArray(record.permissions) &&
      record.permissions.every((permission) => typeof permission === 'string')
    );
  }

  private readLocalChatContext(chatId: string): ChatContext | null {
    return this.localChatContextCache.get(chatId);
  }

  private writeLocalChatContext(chatId: string, value: ChatContext, encodedBytes?: number): void {
    this.localChatContextCache.set(chatId, value, encodedBytes);
  }

  private applyLocalInvalidation(
    chatId: string,
    reason: ChatContextInvalidationReason = 'explicit',
    origin: 'local' | 'remote' = 'local',
  ): void {
    const counters = this.cacheActivity.invalidationsByReason[reason];
    counters.events += 1;
    if (origin === 'remote') this.cacheActivity.remoteInvalidationCalls += 1;
    else this.cacheActivity.localInvalidationCalls += 1;
    if (this.localChatContextCache.delete(chatId)) counters.evictedEntries += 1;
    this.chatContextInFlightLoads.delete(chatId);
    // FLAG: Idle invalidations retain no keys. Retired objects stay invalid for every pending
    // reader, even after a newer generation finishes; resetting numeric epochs would allow ABA.
    const generation = this.chatContextReadGenerations.get(chatId);
    if (generation) {
      generation.invalidated = true;
      this.chatContextReadGenerations.delete(chatId);
    }
  }

  private parseInvalidationPayload(
    payload: string,
  ): { chatId: string; reason: ChatContextInvalidationReason } | null {
    try {
      const parsed = JSON.parse(payload) as { chatId?: unknown; reason?: unknown };
      return typeof parsed.chatId === 'string' && parsed.chatId.trim().length > 0
        ? {
            chatId: parsed.chatId.trim(),
            reason: parseChatContextInvalidationReason(parsed.reason),
          }
        : null;
    } catch {
      return null;
    }
  }

  private appendChatAdminUser(context: ChatContext, userId: string): ChatContext {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId || context.adminUserIds.includes(normalizedUserId)) {
      return context;
    }

    return {
      ...context,
      adminUserIds: [...context.adminUserIds, normalizedUserId],
    };
  }

  private async readChatContextRevision(chatId: string): Promise<string> {
    const raw = await this.redis.get(ChatContextCacheService.chatContextRevisionKey(chatId));
    if (!raw) {
      return '0';
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed) : '0';
  }

  private async writeChatContextAtRevision(
    chatId: string,
    encoded: Awaited<ReturnType<ChatContextMediaCache['encode']>>,
    expectedRevision: string,
  ): Promise<boolean> {
    const committed = await this.redis.eval(
      WRITE_CHAT_CONTEXT_AT_REVISION_SCRIPT,
      4 + encoded.blobKeys.length,
      ChatContextCacheService.chatContextRevisionKey(chatId),
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
      ChatContextCacheService.cachedContextRevisionKey(chatId),
      ...encoded.blobKeys,
      expectedRevision,
      encoded.serialized,
      String(ChatContextCacheService.CHAT_CONTEXT_TTL_SEC),
      String(CHAT_CONTEXT_MEDIA_TTL_SEC),
    );
    return Number(committed) === 1;
  }

  private async patchChatContextInRedis(
    chatId: string,
    patch: (current: ChatContext) => ChatContext,
    reason: ChatContextInvalidationReason = 'admin_list_changed',
  ): Promise<void> {
    const cacheKey = ChatContextCacheService.cacheKey(chatId);
    for (
      let attempt = 0;
      attempt < ChatContextCacheService.ACCESS_EPOCH_CAS_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const [raw, revisionRaw, cachedRevision] = await this.redis.mget(
        cacheKey,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.cachedContextRevisionKey(chatId),
      );
      if (!raw || cachedRevision !== (revisionRaw ?? '0')) {
        return;
      }
      const expectedRevision = revisionRaw ?? '0';
      let current: ChatContext;
      try {
        current = JSON.parse(raw) as ChatContext;
      } catch {
        return;
      }
      const next = patch(current);
      if (next === current) {
        return;
      }
      const committed = await this.redis.eval(
        PATCH_CHAT_CONTEXT_CAS_SCRIPT,
        4,
        cacheKey,
        ChatContextCacheService.chatContextRevisionKey(chatId),
        ChatContextCacheService.legacyCacheKey(chatId),
        ChatContextCacheService.cachedContextRevisionKey(chatId),
        raw,
        expectedRevision,
        JSON.stringify(next),
        CHAT_CONTEXT_INVALIDATION_CHANNEL,
        JSON.stringify({ chatId, reason }),
      );
      if (Number(committed) === 1) {
        this.applyLocalInvalidation(chatId, reason);
        return;
      }
    }
    throw new Error(`Chat context patch conflicted repeatedly for chat ${chatId}`);
  }

  private async readRedisStringWithin(key: string, maxWaitMs: number): Promise<string | null> {
    const readPromise = this.redis.get(key).catch(() => null);
    return this.runRedisReadWithin(readPromise, maxWaitMs);
  }

  private async readAdminAccessEpochPrecheckWithin(
    key: string,
    maxWaitMs: number,
  ): Promise<{ kind: 'value'; value: string | null } | { kind: 'fail_open' }> {
    let timeout: NodeJS.Timeout | null = null;
    const read = this.redis.get(key).then(
      (value) => ({ kind: 'value' as const, value }),
      () => ({ kind: 'fail_open' as const }),
    );
    const timeoutPromise = new Promise<{ kind: 'fail_open' }>((resolve) => {
      timeout = setTimeout(
        () => resolve({ kind: 'fail_open' }),
        Math.max(1, Math.trunc(maxWaitMs)),
      );
      timeout.unref();
    });

    try {
      return await Promise.race([read, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private recordAdminAccessEpochMutationMetric(
    options: AdminAccessEpochMutationOptions,
    metric: AdminAccessEpochMutationMetric,
  ): void {
    try {
      options.recordMetric?.(metric);
    } catch {
      // Metrics must never affect the authoritative cache mutation.
    }
  }

  private async readRedisStringsWithin(
    keys: readonly string[],
    maxWaitMs: number,
  ): Promise<Array<string | null> | null> {
    if (keys.length === 0) {
      return [];
    }

    const readPromise = this.redis.mget(...keys).catch(() => null);
    return this.runRedisReadWithin(readPromise, maxWaitMs);
  }

  private parseAdminAccessState(raw: string | null): ChatAdminAccessState | null {
    if (raw === null) {
      return null;
    }

    if (raw === 'granted' || raw === 'user_denied' || raw === 'bot_denied') {
      return raw;
    }

    if (raw === '1') {
      return 'granted';
    }

    if (raw === '0') {
      return 'user_denied';
    }

    return null;
  }

  private async runRedisReadWithin<T>(operation: Promise<T>, maxWaitMs: number): Promise<T | null> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), Math.max(1, Math.trunc(maxWaitMs)));
      timeout.unref();
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async runRedisWriteWithin(operation: Promise<unknown>, maxWaitMs: number): Promise<void> {
    const result = await this.runRedisReadWithin(
      operation.then(() => true).catch(() => false),
      maxWaitMs,
    );
    void result;
  }
}
