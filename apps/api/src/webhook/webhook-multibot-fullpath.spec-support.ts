import { countFixtureBatches } from './multibot-harness-batches.spec-support';
import { AutomaticMuteCleanupService } from '../moderation/automatic-mute-cleanup.service';
import type { MaxUpdate } from '@maxim/contracts';
import type { ManagedEntityExplicitActivation } from '../max/managed-entity-activation.util';
import { ModerationRuleFollowupService } from '../moderation/moderation-rule-followup.service';
import { ClosedChatDeleteGuardService } from '../moderation/closed-chat-delete-guard.service';
import { ModerationStateDeleteGuardService } from '../moderation/moderation-state-delete-guard.service';
import { RequiredSubscriptionExecutionGuardService } from '../moderation/required-subscription-execution-guard.service';
import { ModerationRuleSanctionGuardService } from '../moderation/moderation-rule-sanction-guard.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { StopWordsDeleteGuardService } from '../moderation/stop-words/stop-words-delete-guard.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { MaxModerationRuleNoticeGuardService } from '../max/max-moderation-rule-notice.guard';
import { MaxRequiredSubscriptionNoticeGuardService } from '../max/max-required-subscription-notice.guard';
import { MaxDuplicateNoticeGuardService } from '../max/max-duplicate-notice.guard';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { from } from 'rxjs';
import Redis from 'ioredis';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService } from '../max/max-client.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';
import { ModerationDeleteIntentAccessWakeService } from '../max/moderation-delete-intent-access-wake.service';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { ModerationService } from '../moderation/moderation.service';
import { RuleEngineService } from '../moderation/rule-engine.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { SanctionService } from '../moderation/sanction.service';
import { LinkHistoryDeleteGuardService } from '../moderation/link-history-delete-guard.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { MessageLimitsDeleteGuardService } from '../moderation/message-limits-delete-guard.service';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import { MessageDuplicateHistoryService } from '../moderation/message-duplicate/message-duplicate-history.service';
import {
  MessageDuplicatePolicyService,
  MESSAGE_DUPLICATE_CONTROL_KEY,
} from '../moderation/message-duplicate/message-duplicate-policy.service';
import { MessageDuplicateAuthorizationService } from '../moderation/message-duplicate/message-duplicate-authorization.service';
import { MessageDuplicateDeleteGuardService } from '../moderation/message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateEnforcementService } from '../moderation/message-duplicate/message-duplicate-enforcement.service';
import { MessageDuplicateService } from '../moderation/message-duplicate/message-duplicate.service';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
} from '../moderation/message-duplicate/message-duplicate.queue';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { ActionHealthService } from '../system/action-health.service';
import { createPrismaClient, Prisma, readPrismaPoolConfig } from '../prisma/prisma-client';
import { WebhookService } from './webhook.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WebhookRoutingService } from './webhook-routing.service';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';
import {
  getDefaultWebhookShardConcurrencies,
  getDefaultWebhookWorkerGroupQueues,
  getJoinWebhookShardConcurrencies,
} from '../runtime/moderation-runtime';
import { resolveRuntimeServiceProfile } from '../runtime/runtime-topology';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';

export type MultibotHarnessOptions = {
  databaseUrl: string;
  redisUrl: string;
  bots: number;
  mode?: 'off' | 'shadow' | 'on';
  quotaProfile?: 'production' | 'fixture';
  tokenRps?: 25 | 30;
  productionEnqueueCapacity?: boolean;
  productionOutboxSelection?: boolean;
  recoverDueDeletes?: boolean;
  recoverAutomaticMuteHistory?: boolean;
  split?: { runId: string; role: MultibotHarnessRole };
};
export const MULTIBOT_HARNESS_POOLS = {
  'api-ingress': 6,
  'api-enqueue': 24,
  'api-moderation': 3,
  'api-moderation-critical': 4,
  'api-moderation-join': 4,
  'api-moderation-realtime-b': 3,
  'api-moderation-realtime-c': 3,
  'api-moderation-realtime-d': 3,
  'api-moderation-background': 2,
  'api-action': 4,
} as const;
export type MultibotHarnessRole = keyof typeof MULTIBOT_HARNESS_POOLS;
export type SimulatedMaxEffect = {
  callId: string;
  observedAtMs: number;
  method: string;
  path: string;
  botId: string;
  messageId?: string;
  body?: unknown;
  params?: Record<string, unknown>;
};
type SimulatedOwnMemberProbe =
  | 'unavailable'
  | 'permissions_unknown'
  | 'partial_admin_false'
  | 'partial_owner_false'
  | 'null_payload'
  | 'role_unknown_permissions_empty'
  | 'not_found'
  | { status: 403 | 404; code?: string };

// FLAG: This fixture accepts only disposable local stores and never opens a MAX socket.
// Its HTTP adapter supplies MAX responses; SQL, Redis, BullMQ, rule and mutation services run normally.
export async function createMultibotHarness(options: MultibotHarnessOptions) {
  const dbUrl = new URL(options.databaseUrl);
  const redisUrl = new URL(options.redisUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) ||
    !dbUrl.pathname.includes('race_test') ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname)
  ) {
    throw new Error('Multibot harness requires disposable local PostgreSQL race_test and Redis');
  }
  const split = options.split;
  if (
    split &&
    (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(split.runId) ||
      !Object.hasOwn(MULTIBOT_HARNESS_POOLS, split.role))
  )
    throw new Error('Invalid local split fixture identity');
  const ownsFixture = !split || split.role === 'api-ingress';
  const preparationPoolMax = readPrismaPoolConfig().max ?? 10;
  if (
    options.productionEnqueueCapacity &&
    (!split || split.role === 'api-enqueue') &&
    preparationPoolMax !== 24
  ) {
    throw new Error('Production enqueue fixture requires PRISMA_PG_POOL_MAX=24');
  }
  if (options.productionOutboxSelection && !options.productionEnqueueCapacity) {
    throw new Error('Production outbox selection requires the production enqueue fixture budget');
  }
  const sqlPoolMax = split
    ? MULTIBOT_HARNESS_POOLS[split.role]
    : options.productionEnqueueCapacity
      ? 24
      : 12;
  const enqueueConcurrency = options.productionEnqueueCapacity ? 32 : 8;
  const prisma = createPrismaClient(options.databaseUrl, {
    max: sqlPoolMax,
    statement_timeout: 15_000,
  });
  await prisma.$connect();
  const [native] = await prisma.$queryRaw<
    Array<{ version: string; timezone: string; connections: string }>
  >`
    SELECT version(), current_setting('TimeZone') AS timezone,
      current_setting('max_connections') AS connections
  `;
  if (
    !native?.version.startsWith('PostgreSQL ') ||
    /pglite|wasm/iu.test(native.version) ||
    native.timezone !== 'UTC' ||
    process.env.TZ !== 'UTC'
  ) {
    await prisma.$disconnect();
    throw new Error('Multibot harness requires native PostgreSQL and process/server UTC');
  }
  if (split && Number(native.connections) < 64) {
    await prisma.$disconnect();
    throw new Error(
      'Split fixture requires with-test-stores.mjs --profile=split-load (at least 64 local PostgreSQL connections)',
    );
  }
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const previousControl = await redis.get(MESSAGE_DUPLICATE_CONTROL_KEY);
  const previousRevision = await redis.get(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
  const now = Date.now();
  if (ownsFixture)
    await redis.set(
      MESSAGE_DUPLICATE_CONTROL_KEY,
      JSON.stringify({
        version: 2,
        revision: 1,
        mode: 'delete_only',
        scope: 'all_enabled_chats',
        chatIds: [],
        effectiveAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
      }),
    );
  if (ownsFixture) await redis.set(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`, '1');
  const config = new ConfigService({
    REDIS_URL: options.redisUrl,
    MAX_API_BASE_URL: 'https://max-harness.invalid',
    NODE_ENV: 'test',
    WEBHOOK_CANONICAL_EXECUTION_MODE: options.mode ?? 'shadow',
    MODERATION_DELETE_INTENT_MODE: 'on',
    MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: '*',
    MAX_ROUTED_MUTATIONS_MODE: 'on',
    MAX_CROSS_BOT_EDIT_DELETE_ENABLED: true,
    MAX_MUTED_USER_API_PROTECTION_ENABLED: true,
    MESSAGE_DUPLICATE_ENABLED: true,
    APP_SERVICE_NAME: split?.role ?? 'api-moderation',
    MODERATION_BACKGROUND_TASKS_ENABLED: false,
    CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: 0,
    MAX_API_GLOBAL_RPS: options.tokenRps ?? 30,
    ...(options.tokenRps === undefined ? {} : { MAX_API_GLOBAL_BURST: 0 }),
    ...(split
      ? {
          MAX_API_GLOBAL_RPS_CRITICAL: 12,
          MAX_API_GLOBAL_RPS_INTERACTIVE: 10,
          MAX_API_GLOBAL_RPS_BACKGROUND:
            split.role === 'api-action' || split.role === 'api-moderation-background' ? 3 : 4,
        }
      : {}),
    MAX_API_CHAT_RPS: options.quotaProfile === 'production' ? 5 : 30,
    MAX_API_MANAGED_REFRESH_RPS: options.quotaProfile === 'production' ? 2 : 30,
    MODERATION_DELETE_INTENT_LEASE_MS: 60_000,
    ENQUEUE_MAX_ATTEMPTS: 120,
  });
  const prefix = `multibot-fixture-${split?.runId ?? randomUUID()}`;
  const queue = new Queue(`${prefix}-${split ? LEGACY_WEBHOOK_QUEUE : 'webhook'}`, {
    connection: redis as unknown as ConnectionOptions,
  });
  const deleteQueue = new Queue(`${prefix}-delete`, {
    connection: redis as unknown as ConnectionOptions,
  });
  const queuesByName = Object.fromEntries(
    ALL_WEBHOOK_QUEUE_NAMES.map((name) => [
      name,
      split && name !== LEGACY_WEBHOOK_QUEUE
        ? new Queue(`${prefix}-${name}`, { connection: redis as unknown as ConnectionOptions })
        : queue,
    ]),
  );
  const allQueues = [...new Set([queue, deleteQueue, ...Object.values(queuesByName)])];
  const bots = Array.from({ length: options.bots }, (_, index) => ({
    id: `fixture-bot-${index + 1}`,
    token: `fixture-token-${prefix}-${index + 1}`,
    label: `Fixture ${index + 1}`,
    state: 'active',
    username: null,
  }));
  const registry = {
    getDefaultBot: () => bots[0]!,
    getEntryBot: () => bots[0]!,
    getAllBots: () => bots,
    getBotById: (id?: string | null) => bots.find((bot) => bot.id === id) ?? null,
    isKnownBotUserId: (id?: string | null) => bots.some((bot) => bot.id === id),
    resolveBotIdFromUserId: (id?: string | null) => bots.find((bot) => bot.id === id)?.id ?? null,
    getValidationTokens: () => bots.map((bot) => bot.token),
    getValidationTokensForBot: (id: string) =>
      bots.filter((bot) => bot.id === id).map((bot) => bot.token),
    getPublisherBotDescriptor: () => ({ id: 'fixture-publisher' }),
  };
  const context = new MaxBotContextService();
  const counters = new RedisCounterService(config);
  const counterClient: unknown = Reflect.get(counters, 'redis');
  if (!(counterClient instanceof Redis))
    throw new Error('Expected the actual counter Redis client');
  const counterRedis = counterClient;
  await counterRedis.ping();
  const health = new ActionHealthService(config);
  const legacyHolds = new WebhookLegacyHoldService(prisma as never);
  const ledger = new MaxActionLedgerService(prisma as never, legacyHolds);
  const links = new MaxBotLinkService(
    prisma as never,
    registry as never,
    context,
    new ModerationDeleteIntentAccessWakeService(prisma as never),
    undefined,
    counters,
  );
  const peerRouteRoles: MaxBotLinkService[] = [];
  const createRouteRole = () => {
    const role = new MaxBotLinkService(
      prisma as never,
      registry as never,
      new MaxBotContextService(),
      new ModerationDeleteIntentAccessWakeService(prisma as never),
      undefined,
      counters,
    );
    peerRouteRoles.push(role);
    return role;
  };
  const effects: SimulatedMaxEffect[] = [];
  const requests: SimulatedMaxEffect[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  // FLAG: Only the disposable split fixture shares simulated MAX state through Redis.
  // Every role keeps the same synthetic tokens, so real quota admission is shared too.
  const messageStoreKey = `${prefix}:simulated-messages`;
  const readMessage = async (id: string): Promise<Record<string, unknown> | undefined> => {
    if (!split) return messages.get(id);
    const saved = await redis.hget(messageStoreKey, id);
    return saved ? (JSON.parse(saved) as Record<string, unknown>) : undefined;
  };
  const saveMessage = async (id: string, value: Record<string, unknown>) => {
    if (!split) messages.set(id, value);
    else {
      await redis.hset(messageStoreKey, id, JSON.stringify(value));
      await redis.expire(messageStoreKey, 3600);
    }
  };
  const channelIds = new Set<string>();
  const deniedBots = new Set<string>();
  const rateLimitedDeleteBots = new Set<string>();
  const ownMemberProbeOverrides = new Map<string, SimulatedOwnMemberProbe>();
  const botPermissions = new Map(
    bots.map((bot) => [bot.id, ['read_all_messages', 'write', 'add_remove_members']]),
  );
  const messageLookupFailures = new Map<string, { status: number; code?: string }>();
  const adminUsers = new Set<string>();
  let ambiguousNextSend = false;
  let ambiguousNextEdit = false;
  let ambiguousNextDelete = false;
  let ambiguousNextMemberMutation = false;
  const http = {
    request: (request: {
      method: string;
      url: string;
      headers: { Authorization: string };
      params?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }) =>
      from(
        (async () => {
          const url = new URL(request.url);
          if (url.hostname !== 'max-harness.invalid')
            throw new Error('Harness transport refuses external URLs');
          const bot = bots.find((candidate) => candidate.token === request.headers.Authorization);
          if (!bot) throw new Error('Harness transport received an unknown token');
          const path = url.pathname;
          const method = request.method.toLowerCase();
          const messageId = String(request.params?.message_id ?? request.params?.message_ids ?? '');
          const call = {
            callId: randomUUID(),
            observedAtMs: Date.now(),
            method,
            path,
            botId: bot.id,
            ...(messageId ? { messageId } : {}),
            body: request.data,
            ...(path.endsWith('/members') || path === '/answers'
              ? { params: { ...Object.fromEntries(url.searchParams), ...request.params } }
              : {}),
          };
          requests.push(call);
          if (rateLimitedDeleteBots.has(bot.id) && method === 'delete' && path === '/messages') {
            throw Object.assign(new Error('Simulated MAX token rate limit'), {
              config: request,
              response: {
                status: 429,
                data: { code: 'too.many.requests' },
                headers: { 'retry-after': '1' },
              },
            });
          }
          if (
            deniedBots.has(bot.id) &&
            (path === '/messages' || (method !== 'get' && path.endsWith('/members')))
          ) {
            throw Object.assign(new Error('Simulated MAX chat access denied'), {
              response: { status: 403, data: { code: 'chat.denied' } },
            });
          }
          const member = (id: string, isBot: boolean) => ({
            user_id: id,
            is_bot: isBot,
            is_admin: (isBot && !deniedBots.has(id)) || adminUsers.has(id),
            is_owner: false,
            permissions: isBot && !deniedBots.has(id) ? (botPermissions.get(id) ?? []) : [],
          });
          let data: unknown;
          if (method === 'get' && path.endsWith('/members/me')) {
            const override = ownMemberProbeOverrides.get(bot.id);
            if (typeof override === 'object')
              throw Object.assign(new Error('Simulated own-member lookup HTTP failure'), {
                response: {
                  status: override.status,
                  data: override.code ? { code: override.code } : {},
                },
              });
            if (override === 'unavailable')
              throw Object.assign(new Error('Simulated own-member lookup unavailable'), {
                response: { status: 503, data: { code: 'fixture.lookup.unavailable' } },
              });
            if (override === 'not_found')
              throw Object.assign(new Error('Simulated own-member lookup not found'), {
                response: { status: 404, data: { code: 'fixture.lookup.not_found' } },
              });
            switch (override) {
              case 'permissions_unknown':
                data = { user_id: bot.id, is_bot: true, is_admin: true, is_owner: false };
                break;
              case 'partial_admin_false':
                data = { user_id: bot.id, is_bot: true, is_admin: false };
                break;
              case 'partial_owner_false':
                data = { user_id: bot.id, is_bot: true, is_owner: false };
                break;
              case 'null_payload':
                data = null;
                break;
              case 'role_unknown_permissions_empty':
                data = { user_id: bot.id, is_bot: true, permissions: [] };
                break;
              default:
                data = member(bot.id, true);
            }
          } else if (method === 'get' && path.endsWith('/members/admins'))
            data = {
              members: bots.filter((b) => !deniedBots.has(b.id)).map((b) => member(b.id, true)),
              marker: null,
            };
          else if (method === 'get' && path.endsWith('/members'))
            data = {
              members: String(
                request.params?.user_ids ?? url.searchParams.get('user_ids') ?? 'fixture-user',
              )
                .split(',')
                .map((id) =>
                  member(
                    id,
                    bots.some((b) => b.id === id),
                  ),
                ),
              marker: null,
            };
          else if (method === 'get' && path === '/messages') {
            const message = await readMessage(messageId);
            data = { messages: message ? [message] : [] };
          } else if (method === 'get' && path.startsWith('/messages/')) {
            const exactMessageId = decodeURIComponent(path.slice('/messages/'.length));
            const failure = messageLookupFailures.get(exactMessageId);
            if (failure)
              throw Object.assign(new Error('Simulated exact message lookup failure'), {
                response: {
                  status: failure.status,
                  data: failure.code ? { code: failure.code } : {},
                },
              });
            const message = await readMessage(exactMessageId);
            if (!message)
              throw Object.assign(new Error('Simulated exact message absence'), {
                response: { status: 404, data: { code: 'message.not.found' } },
              });
            data = message;
          } else if (method === 'get' && path.startsWith('/chats/'))
            data = {
              chat_id: path.split('/')[2],
              type: channelIds.has(path.split('/')[2]!) ? 'channel' : 'chat',
              title: 'Fixture chat',
              participants_count: 2,
            };
          else if (method === 'delete' && path === '/messages') {
            effects.push(call);
            if (ambiguousNextDelete) {
              ambiguousNextDelete = false;
              throw Object.assign(new Error('Simulated ambiguous MAX delete timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            if (split) await redis.hdel(messageStoreKey, messageId);
            else messages.delete(messageId);
            data = { success: true };
          } else if (method === 'put' && path === '/messages') {
            effects.push(call);
            if (ambiguousNextEdit) {
              ambiguousNextEdit = false;
              throw Object.assign(new Error('Simulated ambiguous MAX edit timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            const existing = await readMessage(messageId);
            if (!existing) throw new Error('Fixture edit requires an existing message');
            await saveMessage(messageId, {
              ...existing,
              body: { ...(existing.body as object), ...request.data },
            });
            data = { success: true };
          } else if (method === 'post' && path === '/answers') {
            effects.push(call);
            data = { success: true };
          } else if (method === 'post' && path === '/messages') {
            effects.push(call);
            if (ambiguousNextSend) {
              ambiguousNextSend = false;
              throw Object.assign(new Error('Simulated ambiguous MAX send timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            data = {
              message: {
                recipient: { chat_id: request.params?.chat_id },
                timestamp: Date.now(),
                body: { mid: `fixture-reply-${effects.length}`, text: request.data?.text },
              },
            };
          } else if (method !== 'get' && path.endsWith('/members')) {
            effects.push(call);
            if (ambiguousNextMemberMutation) {
              ambiguousNextMemberMutation = false;
              throw Object.assign(new Error('Simulated ambiguous MAX member mutation timeout'), {
                code: 'ECONNABORTED',
                request: {},
              });
            }
            data = { success: true };
          } else throw new Error(`Unhandled simulated MAX endpoint: ${method} ${path}`);
          return { status: 200, data, headers: {}, config: request };
        })(),
      ),
  };
  const max = new MaxClientService(
    http as never,
    config,
    health,
    registry as never,
    context,
    undefined,
    undefined,
    ledger,
    links,
    undefined,
    undefined,
    undefined,
    undefined,
    new MaxModerationRuleNoticeGuardService(
      prisma as never,
      registry as never,
      new ParticipantModerationImmunityService(prisma as never),
      config,
    ),
    new MaxRequiredSubscriptionNoticeGuardService(
      prisma as never,
      registry as never,
      new ParticipantModerationImmunityService(prisma as never),
      config,
    ),
    new MaxDuplicateNoticeGuardService({ get: () => duplicateGuard } as never),
    legacyHolds,
  );
  const readiness = new MaxExecutionOwnerReadinessService(links, max, counters);
  const canonical = new WebhookCanonicalExecutionService(
    prisma as never,
    readiness,
    undefined,
    legacyHolds,
  );
  const cache = new ChatContextCacheService(prisma as never, config, links);
  const immunity = new ParticipantModerationImmunityService(prisma as never);
  const policy = new MessageDuplicatePolicyService(counters, config);
  const history = new MessageDuplicateHistoryService(counters);
  const ordering = new MessageDuplicateOrderingStore(config);
  const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
  const duplicateGuard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    policy,
    history,
    config,
    authorization,
    undefined,
    legacyHolds,
  );
  const lengthGuard = new MessageLimitsDeleteGuardService(
    prisma as never,
    max,
    links as never,
    immunity,
    config,
  );
  const closedGuard = new ClosedChatDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const globalPolicy = new GlobalSpammerIntelligenceService(
    prisma as never,
    config,
    registry as never,
    counters,
    undefined,
    undefined,
    legacyHolds,
  );
  const sanctionFence = new ModerationSanctionStateFenceService(prisma as never);
  const stateGuard = new ModerationStateDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    sanctionFence,
    globalPolicy,
    config,
    legacyHolds,
  );
  const membership = new MaxMembershipLookupService(max, config, links, registry as never);
  const subscriptionGuard = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max,
    links,
    membership,
    immunity,
    config,
  );
  const sanctionGuard = new ModerationRuleSanctionGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const stopWordsGuard = new StopWordsDeleteGuardService(
    prisma as never,
    max,
    links,
    immunity,
    config,
  );
  const intents = new ModerationDeleteIntentService(
    prisma as never,
    max,
    links,
    deleteQueue as never,
    config,
    new LinkHistoryDeleteGuardService(prisma as never, max, links, config),
    {} as never,
    {} as never,
    {} as never,
    immunity,
    duplicateGuard,
    stopWordsGuard,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lengthGuard,
    closedGuard,
    stateGuard,
    subscriptionGuard,
    legacyHolds,
  );
  const duplicateService = new MessageDuplicateService(
    policy,
    history,
    new MessageDuplicateEnforcementService(intents, policy, duplicateGuard),
    new MessageDuplicateEnqueueService(),
    authorization,
  );
  const moderation = new ModerationService(
    prisma as never,
    new RuleEngineService(counters),
    new SanctionService(prisma as never),
    max,
    cache,
    undefined,
    config,
    counters,
    undefined,
    undefined,
    undefined,
    links,
    context,
  );
  const automaticMuteCleanup = new AutomaticMuteCleanupService(
    prisma as never,
    intents,
    legacyHolds,
  );
  const ruleFollowups = new ModerationRuleFollowupService(
    prisma as never,
    sanctionGuard,
    links,
    {
      get: () => moderation,
    } as never,
    legacyHolds,
  );
  const groupCommands = new GroupCommandAuthorityService(prisma as never, legacyHolds);
  Object.assign(moderation, {
    legacyHolds,
    injectedWebhookCanonicalExecutionService: canonical,
    moderationDeleteIntentService: intents,
    moderationRuleFollowupService: ruleFollowups,
    maxActionLedgerService: ledger,
    messageDuplicateService: duplicateService,
    participantImmunity: immunity,
    injectedGroupCommandAuthority: groupCommands,
    moderationRuleSanctionGuard: sanctionGuard,
    moderationStateDeleteGuard: stateGuard,
    requiredSubscriptionExecutionGuard: subscriptionGuard,
    membershipLookupService: membership,
    stopWordsDeleteGuard: stopWordsGuard,
    globalSpammerIntelligence: globalPolicy,
  });
  Object.assign(moderation, { injectedExecutionOwnerReadiness: readiness });
  const ingress = new WebhookService(prisma as never, config, links);
  Object.assign(ingress, { executionOwnerReadiness: readiness, maxClient: max, legacyHolds });
  const routing = new WebhookRoutingService(
    prisma as never,
    {
      getWebhookDefaultShardSnapshot: async () => {
        if (split) {
          const entries = await Promise.all(
            DEFAULT_WEBHOOK_QUEUE_NAMES.map(async (name) => {
              const counts = await queuesByName[name]!.getJobCounts(
                'waiting',
                'active',
                'delayed',
                'failed',
                'completed',
                'prioritized',
                'paused',
              );
              return [name, counts] as const;
            }),
          );
          const shards = Object.fromEntries(entries);
          return {
            generatedAt: new Date().toISOString(),
            webhookDefaultShards: shards,
            webhookDefaultWorkerGroups: Object.fromEntries(
              Object.entries(getDefaultWebhookWorkerGroupQueues()).map(([name, queues]) => [
                name,
                {
                  queues,
                  counters: Object.fromEntries(
                    [
                      'waiting',
                      'active',
                      'delayed',
                      'failed',
                      'completed',
                      'prioritized',
                      'paused',
                    ].map((key) => [
                      key,
                      queues.reduce((sum, queueName) => sum + (shards[queueName]?.[key] ?? 0), 0),
                    ]),
                  ),
                },
              ]),
            ),
          };
        }
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        const counters = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          prioritized: 0,
          paused: 0,
        };
        return {
          generatedAt: new Date().toISOString(),
          webhookDefaultShards: Object.fromEntries(
            DEFAULT_WEBHOOK_QUEUE_NAMES.map((name) => [name, counters]),
          ),
          webhookDefaultWorkerGroups: Object.fromEntries(
            Object.entries(getDefaultWebhookWorkerGroupQueues()).map(([name, queues]) => [
              name,
              { queues, counters },
            ]),
          ),
        };
      },
    } as never,
    config,
  );
  const outbox = new WebhookOutboxService(
    prisma as never,
    config,
    {
      get: (token: string) => (split ? queuesByName[token.replace(/^BullQueue_/u, '')] : queue),
    } as never,
    routing,
    ingress,
    queuesByName[LEGACY_WEBHOOK_QUEUE] as never,
    queuesByName[WEBHOOK_QUEUE_CRITICAL] as never,
    queuesByName[WEBHOOK_QUEUE_BACKGROUND] as never,
    {
      // FLAG: Controlled normal-mode fixture, not evidence of production governor capacity.
      getEffectiveSnapshot: async () => ({ mode: 'normal', source: 'auto', condition: 'normal' }),
      peekCachedSnapshot: () => ({ mode: 'normal', source: 'auto', condition: 'normal' }),
    } as never,
    legacyHolds,
  );
  Object.assign(outbox, {
    queuesByName,
  });
  const failures: Error[] = [];
  const processedIds: string[] = [];
  const defaultConcurrency = getDefaultWebhookShardConcurrencies({});
  const joinConcurrency = getJoinWebhookShardConcurrencies({ MODERATION_CONCURRENCY_JOIN: 4 });
  const workerQueues = split
    ? resolveRuntimeServiceProfile({ APP_SERVICE_NAME: split.role }).service.moderationQueues
    : [LEGACY_WEBHOOK_QUEUE];
  const workerConnections: Redis[] = [];
  const workers: Worker[] = [];
  const webhookWorkers: Worker[] = [];
  const processedQueues = new Map<string, number>();
  for (const name of workerQueues) {
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    workerConnections.push(connection);
    const concurrency = !split
      ? 4
      : name === LEGACY_WEBHOOK_QUEUE
        ? 1
        : name === WEBHOOK_QUEUE_CRITICAL
          ? 4
          : name === WEBHOOK_QUEUE_BACKGROUND
            ? 2
            : (DEFAULT_WEBHOOK_QUEUE_NAMES as readonly string[]).includes(name)
              ? defaultConcurrency[name as keyof typeof defaultConcurrency]
              : joinConcurrency[name as keyof typeof joinConcurrency];
    const worker = new Worker(
      queuesByName[name]!.name,
      async (job) => {
        await moderation.processWebhookEvent(job.data.webhookEventId);
        processedIds.push(job.data.webhookEventId);
        processedQueues.set(name, (processedQueues.get(name) ?? 0) + 1);
      },
      { connection: connection as unknown as ConnectionOptions, concurrency },
    );
    worker.on('failed', (_job, error) => failures.push(error));
    workers.push(worker);
    webhookWorkers.push(worker);
  }
  if (!split || split.role === 'api-action') {
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    workerConnections.push(connection);
    const worker = new Worker(
      deleteQueue.name,
      async (job) => {
        await intents.attemptIntent(job.data.intentId);
      },
      { connection: connection as unknown as ConnectionOptions, concurrency: split ? 2 : 4 },
    );
    worker.on('failed', (_job, error) => failures.push(error));
    workers.push(worker);
  }
  await Promise.all([
    ...allQueues.map((q) => q.waitUntilReady()),
    ...workers.map((w) => w.waitUntilReady()),
  ]);
  const chatIds: string[] = [];
  const receiptIds: string[] = [];
  const touchedMessagesByChatId = new Map<string, Set<string>>();
  const messageWrites = new Map<string, Promise<void>>();
  let nextDeleteSweepAtMs = 0;

  async function seedCatalog(
    count: number,
    settings: Prisma.ChatSettingsUncheckedCreateWithoutChatInput = {},
    entityType: 'CHAT' | 'CHANNEL' = 'CHAT',
  ) {
    const added: string[] = [];
    for (let offset = 0; offset < count; offset += 250) {
      const batch = Array.from(
        { length: Math.min(250, count - offset) },
        () => `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`)}`,
      );
      await prisma.chat.createMany({
        data: batch.map((id) => ({
          id,
          title: 'Local multibot fixture',
          entityType,
          primaryBotId: bots[0]!.id,
          botId: bots[0]!.id,
          routingState: 'READY',
          routingVersion: 1,
        })),
      });
      await prisma.chatSettings.createMany({
        data: batch.map((chatId) => ({
          chatId,
          deleteSpammersEnabled: false,
          maxMessageLengthEnabled: true,
          maxMessageLength: 20,
          ...settings,
        })),
      });
      const checkedAt = new Date();
      if (entityType === 'CHANNEL') {
        for (const id of batch) channelIds.add(id);
        await prisma.channelSettings.createMany({
          data: batch.map((chatId) => ({ chatId, commentsEnabled: true })),
        });
      }
      await prisma.chatBotMembership.createMany({
        data: batch.flatMap((chatId) =>
          bots.map((bot, index) => ({
            chatId,
            botId: bot.id,
            role: index === 0 ? ('PRIMARY' as const) : ('STANDBY' as const),
            status: 'ACTIVE' as const,
            ...buildBotAccessSnapshotPersistence(
              {
                isAdmin: true,
                isOwner: false,
                permissionsKnown: true,
                permissions: botPermissions.get(bot.id) ?? [],
              },
              { source: 'fixture', now: checkedAt },
            ),
          })),
        ),
      });
      chatIds.push(...batch);
      added.push(...batch);
    }
    return added;
  }

  async function ingest(input: {
    chatId: string;
    messageId: string;
    text: string;
    textCarrier?: 'message_text' | 'body_plain' | 'payload_caption' | 'nested_caption';
    botId?: string;
    type?: 'message_created' | 'message_edited';
    at?: number;
    attachments?: unknown[];
    senderless?: boolean;
    link?: Record<string, unknown>;
  }) {
    const at = input.at ?? Date.now();
    const raw = {
      update_type: input.type ?? 'message_created',
      timestamp: at,
      message: {
        ...(input.senderless
          ? {}
          : { sender: { user_id: 'fixture-user', name: 'Fixture user', is_bot: false } }),
        recipient: {
          chat_id: input.chatId,
          chat_type: channelIds.has(input.chatId) ? 'channel' : 'chat',
        },
        timestamp: at,
        ...(input.link ? { link: input.link } : {}),
        ...(input.textCarrier === 'message_text' ? { text: input.text } : {}),
        ...(input.textCarrier === 'payload_caption' ? { payload: { caption: input.text } } : {}),
        ...(input.textCarrier === 'nested_caption' ? { message: { caption: input.text } } : {}),
        body: {
          mid: input.messageId,
          ...(!input.textCarrier ? { text: input.text } : {}),
          ...(input.textCarrier === 'body_plain' ? { plain: input.text } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        },
      },
    };
    if (split) {
      if (input.type && input.type !== 'message_created')
        throw new Error('Split load fixture currently accepts message_created only');
      // One synthetic remote publication precedes all mirrored receipts. A late
      // mirror must not recreate a message already deleted by another process.
      if (!messageWrites.has(input.messageId))
        messageWrites.set(input.messageId, saveMessage(input.messageId, raw.message));
      await messageWrites.get(input.messageId);
    } else messages.set(input.messageId, raw.message);
    const touchedMessages = touchedMessagesByChatId.get(input.chatId) ?? new Set<string>();
    touchedMessages.add(input.messageId);
    touchedMessagesByChatId.set(input.chatId, touchedMessages);
    const update = new WebhookParser().parse(raw);
    update.botId = input.botId ?? bots[0]!.id;
    update.updateId = `${prefix}-${randomUUID()}`;
    const result = await ingress.storeReceipt(update, null);
    if (result.webhookEventId) receiptIds.push(result.webhookEventId);
    return result.webhookEventId!;
  }

  async function pumpWork() {
    if (failures.length) throw failures[0];
    if (split && split.role !== 'api-enqueue' && split.role !== 'api-action') return;
    // FLAG: The production SQL sweeper owns future retries even when BullMQ is empty.
    // Keep its cadence and fixture opt-in so deliberate pending/unknown cases stay inspectable.
    if (
      (!split || split.role === 'api-action') &&
      options.recoverDueDeletes &&
      Date.now() >= nextDeleteSweepAtMs
    ) {
      nextDeleteSweepAtMs = Date.now() + 1_000;
      await intents.sweepDueIntents();
    }
    if (!split || split.role === 'api-action') {
      await ruleFollowups.sweep();
      if (options.recoverAutomaticMuteHistory) await automaticMuteCleanup.sweep();
    }
    if (split?.role === 'api-action') return;
    if (options.productionOutboxSelection) {
      const startedAt = Date.now();
      await (outbox as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 200 - (Date.now() - startedAt))),
      );
      return;
    }
    const candidates = await prisma.webhookEvent.findMany({
      where: {
        id: { in: receiptIds },
        OR: [
          { status: 'RECEIVED' },
          { status: 'QUEUED' },
          { status: 'FAILED', nextEnqueueAt: { lte: new Date() } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 128,
    });
    if (candidates.length)
      await (
        outbox as unknown as {
          enqueueCandidates: (events: unknown[], concurrency: number) => Promise<unknown>;
        }
      ).enqueueCandidates(
        candidates.map((event) => ({ ...event, priority: 5 })),
        enqueueConcurrency,
      );
  }

  async function pumpOnce() {
    await pumpWork();
    const pending = await countFixtureBatches(receiptIds, (ids) =>
      prisma.webhookEvent.count({
        where: { id: { in: ids }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
      }),
    );
    const queued = await deleteQueue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    const pendingWebhookJobs = split
      ? (
          await Promise.all(
            Object.values(queuesByName).map((q) =>
              q.getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
            ),
          )
        ).reduce((sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0)
      : 0;
    const unfinishedDeletes =
      options.recoverDueDeletes && touchedMessagesByChatId.size
        ? await prisma.moderationDeleteIntent.count({
            where: {
              OR: [...touchedMessagesByChatId].map(([chatId, messageIds]) => ({
                chatId,
                messageId: { in: [...messageIds] },
              })),
              status: {
                in: ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'],
              },
            },
          })
        : 0;
    const pendingFollowups = await prisma.moderationRuleFollowup.count({
      where: { chatId: { in: chatIds }, status: { in: ['READY', 'RETRYABLE', 'IN_PROGRESS'] } },
    });
    const pendingCleanup = options.recoverAutomaticMuteHistory
      ? await prisma.automaticMuteCleanup.count({
          where: { chatId: { in: chatIds }, status: 'PENDING' },
        })
      : 0;
    return (
      pendingCleanup +
      pendingWebhookJobs +
      pendingFollowups +
      pending +
      (queued.waiting ?? 0) +
      (queued.active ?? 0) +
      (queued.delayed ?? 0) +
      (queued.prioritized ?? 0) +
      unfinishedDeletes
    );
  }

  async function drain(maxMs = 15_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!(await pumpOnce())) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Multibot drain exceeded ${maxMs} ms; effects=${effects.length}`);
  }

  async function waitForConfirmedDelete(chatId: string, messageId: string, maxMs = 15_000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (failures.length) throw failures[0];
      const intent = await prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId, messageId } },
        select: {
          id: true,
          status: true,
          remoteDeleteSucceededAt: true,
          reasons: {
            where: { ruleCode: 'DUPLICATE_DELETE' },
            select: { metadata: true },
            take: 65,
          },
        },
      });
      // FLAG: A late-notice fault must follow our actual verified DELETE and completion
      // of this fixture's isolated delete queue. Never drain the blocked webhook job here.
      const queued = await deleteQueue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      const verified = intent?.reasons.some(
        (reason) =>
          (reason.metadata as Record<string, unknown> | null)?.moderationDeleteVerified === true,
      );
      if (
        intent?.status === 'SUCCEEDED' &&
        intent.remoteDeleteSucceededAt &&
        verified &&
        !messages.has(messageId) &&
        (queued.waiting ?? 0) +
          (queued.active ?? 0) +
          (queued.delayed ?? 0) +
          (queued.prioritized ?? 0) ===
          0
      ) {
        if (failures.length) throw failures[0];
        return intent;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Confirmed duplicate DELETE did not settle within ${maxMs} ms`);
  }

  async function demote(chatId: string, botId: string) {
    deniedBots.add(botId);
    await links.recordBotAccessProbe({
      chatId,
      botId,
      access: null,
      checkedAt: new Date(),
      source: 'fixture-demotion',
      allowMembershipRecovery: false,
    });
    await cache.invalidate(chatId);
  }

  async function dispose() {
    await outbox.onModuleDestroy();
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(workerConnections.map((connection) => connection.quit()));
    if (ownsFixture) {
      for (const ownedQueue of allQueues) await ownedQueue.obliterate({ force: true });
      if (split) await redis.del(messageStoreKey);
    }
    await Promise.all(allQueues.map((ownedQueue) => ownedQueue.close()));
    await ingress.onModuleDestroy();
    await readiness.onModuleDestroy();
    moderation.onModuleDestroy();
    links.onModuleDestroy();
    for (const role of peerRouteRoles) role.onModuleDestroy();
    await Promise.all([
      max.onModuleDestroy(),
      cache.onModuleDestroy(),
      health.onModuleDestroy(),
      counters.onModuleDestroy(),
      ordering.onModuleDestroy(),
      membership.onModuleDestroy(),
      globalPolicy.onModuleDestroy(),
    ]);
    if (ownsFixture) {
      if (previousControl === null) await redis.del(MESSAGE_DUPLICATE_CONTROL_KEY);
      else await redis.set(MESSAGE_DUPLICATE_CONTROL_KEY, previousControl);
      if (previousRevision === null) await redis.del(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
      else await redis.set(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`, previousRevision);
      await prisma.webhookExecutionClaim.deleteMany({
        where: { webhookEventId: { in: receiptIds } },
      });
      await prisma.webhookEvent.deleteMany({ where: { id: { in: receiptIds } } });
      await prisma.moderationVoiceSource.deleteMany({ where: { chatId: { in: chatIds } } });
      for (let offset = 0; offset < chatIds.length; offset += 1000)
        await prisma.chat.deleteMany({
          where: { id: { in: chatIds.slice(offset, offset + 1000) } },
        });
      await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId: { in: chatIds } } });
    }
    await prisma.$disconnect();
    await redis.quit();
  }

  return {
    prisma,
    legacyHolds,
    redis,
    counterRedis,
    bots,
    config,
    links,
    max,
    canonical,
    intents,
    ruleFollowups,
    automaticMuteCleanup,
    stateGuard,
    globalPolicy,
    subscriptionGuard,
    sanctionGuard,
    membership,
    deleteQueue,
    ingress,
    outbox,
    moderation,
    cache,
    routing,
    duplicateService,
    duplicatePolicy: policy,
    duplicateOrdering: ordering,
    counters,
    botContext: context,
    authorization,
    duplicateGuard,
    history,
    ledger,
    readiness,
    createRouteRole,
    groupCommands,
    effects,
    requests,
    processedIds,
    processedQueues,
    capacity: { sqlPoolMax, preparationPoolMax, enqueueConcurrency },
    failures,
    messages,
    hasSimulatedMessage: async (messageId: string) => !!(await readMessage(messageId)),
    messageLookupFailures,
    seedCatalog,
    ingest,
    pumpWork,
    pumpOnce,
    drain,
    waitForConfirmedDelete,
    demote,
    dispose,
    pause: () => Promise.all(webhookWorkers.map((worker) => worker.pause())),
    resume: () => Promise.all(webhookWorkers.map((worker) => worker.resume())),
    ambiguousNextSend: () => {
      ambiguousNextSend = true;
    },
    ambiguousNextEdit: () => {
      ambiguousNextEdit = true;
    },
    ambiguousNextDelete: () => {
      ambiguousNextDelete = true;
    },
    ambiguousNextMemberMutation: () => {
      ambiguousNextMemberMutation = true;
    },
    denyBot: (botId: string) => {
      deniedBots.add(botId);
    },
    allowBot: (botId: string) => {
      deniedBots.delete(botId);
    },
    setDeleteRateLimit: (botId: string, enabled: boolean) => {
      if (enabled) rateLimitedDeleteBots.add(botId);
      else rateLimitedDeleteBots.delete(botId);
    },
    setOwnMemberProbe: (botId: string, result: SimulatedOwnMemberProbe | null) => {
      if (result === null) ownMemberProbeOverrides.delete(botId);
      else ownMemberProbeOverrides.set(botId, result);
    },
    allowAdminUser: (userId: string) => {
      adminUsers.add(userId);
    },
    setBotPermissions: (botId: string, permissions: string[]) => {
      botPermissions.set(botId, [...permissions]);
    },
    mediaCoverage: 'ingress-and-caption-rules-without-native-photo-or-ocr' as const,
    receiptIds,
    chatIds,
  };
}

export type MultibotHarness = Awaited<ReturnType<typeof createMultibotHarness>>;

export async function activateHarnessBotByExplicitStart(
  s: MultibotHarness,
  chatId: string,
  botId: string,
): Promise<void> {
  // FLAG: This disposable fixture certifies fresh exact receipt/actor/bot proofs at the
  // central writer; it never publishes Start or grants shared message execution authority.
  s.allowBot(botId);
  s.allowAdminUser('fixture-activation-admin');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const sourceAt = new Date();
  const parsed = new WebhookParser().parse(
    {
      update_id: randomUUID(),
      update_type: 'message_created',
      timestamp: sourceAt.getTime(),
      message: {
        sender: { user_id: 'fixture-activation-admin', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: sourceAt.getTime(),
        body: { mid: randomUUID(), text: 'Старт' },
      },
    },
    { botId },
  );
  const stored = await s.ingress.storeReceipt(parsed, null);
  const id = stored.webhookEventId!;
  s.receiptIds.push(id);
  const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
  const update = receipt.normalizedPayload as MaxUpdate;
  const proof: ManagedEntityExplicitActivation = {
    kind: 'start_in_chat',
    sourceAt,
    updateId: update.updateId,
    actorUserId: 'fixture-activation-admin',
    botId,
    chatId,
  };
  const checkedAt = new Date();
  const access = await s.max.getCurrentChatMemberAccess(chatId, {
    botId,
    bypassCache: true,
    explicitActivation: proof,
  });
  const actor = await s.max.getChatMemberAccess(chatId, proof.actorUserId, {
    botId,
    bypassCache: true,
  });
  if (
    !(await s.links.recordBotAccessProbe({
      chatId,
      botId,
      access,
      checkedAt,
      source: 'native-explicit-start',
      explicitActivation: proof,
      activationActorAccess: actor ?? undefined,
      allowMembershipRecovery: true,
    }))
  )
    throw new Error('Native explicit activation was rejected');
  await s.prisma.webhookEvent.update({
    where: { id },
    data: {
      status: 'PROCESSED',
      processedAt: new Date(),
      errorMessage: 'native_fixture_activation',
    },
  });
  await s.cache.invalidate(chatId);
}
