import { z } from 'zod';
import { botSpeechPersonaSchema } from '@maxim/contracts/bot-speech';
import {
  buildResolvedMaxBotConfigs,
  maxBotLifecycleStateSchema,
  parseAdditionalMaxBotsJson,
  resolveMaxEntryBotConfig,
} from '../max/max-bot-config.util';
import { APP_ROLES } from '../runtime/app-role';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  RUNTIME_SERVICE_NAMES,
  RUNTIME_SERVICE_PROFILES,
  WEBHOOK_DYNAMIC_LEASES_MODES,
} from '../runtime/runtime-topology';
import {
  PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS,
  PHOTO_DUPLICATE_MAX_ACTIONS,
  PHOTO_DUPLICATE_ROLLOUT_MODES,
} from '../moderation/photo-duplicate/photo-duplicate.runtime';
import { COMMERCIAL_OCR_ROLLOUT_MODES } from '../moderation/commercial-ocr/commercial-ocr.runtime';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from '../moderation/commercial-ocr/commercial-ocr.queue';
import { IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODES } from '../moderation/commercial-ocr/image-text-stop-list.runtime';
import { parseCanonicalCommercialOcrApprovalPublicKeyBase64 } from '../moderation/commercial-ocr/commercial-ocr-approval-key';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import {
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS,
} from '../publisher/publisher-auto-reply-flood-gate.config';
import {
  readPublisherActionTokenFile,
  readPublisherDialogSigningKeysFile,
  readPublisherWebhookCredentialFile,
} from '../publisher/publisher-secret-files';

const PRODUCTION_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const DISALLOWED_PRODUCTION_WEBHOOK_SECRETS = new Set([
  'change-me',
  'changeme',
  'secret-path',
  'secret-header',
  'header-secret',
  'replace-me',
  'replace-with-random-url-safe-secret',
]);
const DISALLOWED_ADMIN_ACCESS_CODES = new Set([
  'change-me',
  'changeme',
  'replace-me',
  'replace-with-random-admin-code',
]);

const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function isCanonicalEd25519SpkiBase64(value: string): boolean {
  return value === '' || parseCanonicalCommercialOcrApprovalPublicKeyBase64(value) !== null;
}

function envBoolean(defaultValue: boolean) {
  return z
    .preprocess((value) => {
      if (typeof value !== 'string') {
        return value;
      }

      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        return undefined;
      }
      if (BOOLEAN_TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (BOOLEAN_FALSE_VALUES.has(normalized)) {
        return false;
      }

      return value;
    }, z.boolean().optional())
    .transform((value) => value ?? defaultValue);
}

const photoDuplicateAllowedMatchKindsSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === '' ||
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .every((item) => PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS.some((kind) => kind === item)),
    {
      message: `PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS must contain only: ${PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS.join(', ')}`,
    },
  );

const photoDuplicateExactChatIdsSchema = z.string().refine(
  (value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .every((item) => item !== '*'),
  { message: 'Photo duplicate rollout chat IDs must be exact; wildcard is not allowed' },
);

const commercialOcrExactChatIdsSchema = z.string().refine(
  (value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .every((item) => item !== '*'),
  { message: 'Commercial OCR rollout chat IDs must be exact; wildcard is not allowed' },
);

function originOnlyUrl(key: string) {
  return z
    .string()
    .trim()
    .url()
    .refine(
      (value) => {
        const url = new URL(value);
        return (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
      },
      {
        message: `${key} must be an origin URL without path, query, or hash; use https://major-maksimov.ru, not https://major-maksimov.ru/app/`,
      },
    );
}

function assertProductionPublicHttpsOrigin(key: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port) {
    throw new Error(
      `Environment validation failed: ${key} must use public https on the default 443 port in production`,
    );
  }
}

function assertProductionCurrentMaxApiHost(value: string): void {
  const url = new URL(value);
  if (url.hostname.toLowerCase() === 'platform-api.max.ru') {
    throw new Error(
      'Environment validation failed: MAX_API_BASE_URL must use https://platform-api2.max.ru in production',
    );
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: originOnlyUrl('APP_BASE_URL'),
  MAX_WEBHOOK_BASE_URL: originOnlyUrl('MAX_WEBHOOK_BASE_URL').optional(),

  MAX_BOT_ID: z.string().min(3),
  MAX_BOT_LABEL: z.string().min(1).max(64).optional(),
  MAX_BOT_CHARACTER_NAME: z.string().min(1).max(128).optional(),
  MAX_BOT_SPEECH_PERSONA: botSpeechPersonaSchema.optional(),
  MAX_BOT_CONTACT_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^\d+$/).optional(),
  ),
  MAX_BOT_STATE: maxBotLifecycleStateSchema.default('active'),
  MAX_BOT_OWNERSHIP_WEIGHT: z.coerce.number().finite().positive().max(1_000).default(1),
  MAX_ENTRY_BOT_ID: z.string().min(3).optional(),
  MAX_BOT_TOKEN: z.string().min(10),
  MAX_BOT_TOKEN_PREVIOUS: z.string().min(10).optional(),
  MAX_WEBHOOK_SECRET_PATH: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET_PREVIOUS: z.string().min(8).optional(),
  MAX_BOTS_JSON: z.string().optional(),
  MAX_PUBLISHER_BOT_ID: z.string().trim().min(3).default(DEFAULT_MAX_PUBLISHER_BOT_ID),
  MAX_PUBLISHER_BOT_TOKEN_FILE: z.string().trim().min(1).optional(),
  MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE: z.string().trim().min(1).optional(),
  MAX_PUBLISHER_INIT_DATA_KEYS_FILE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  MAX_PUBLISHER_DISPATCH_ENABLED: envBoolean(false),
  PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: z.enum(['off', 'test', '5', '25', '100']).default('off'),
  PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: z
    .enum(['off', 'test', '5', '25', '100'])
    .default('off'),
  MAX_PUBLISHER_ACCESS_REFRESH_MODE: z.enum(['off', 'canary', 'on']).default('off'),
  PUBLISHER_POST_IMPORT_ENABLED: envBoolean(false),
  PUBLISHER_AUTO_REPLY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1_500),
  PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE: z.enum(['off', 'shadow', 'on']).default('on'),
  PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userBurstLimit.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userBurstLimit.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userBurstLimit),
  PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userRollingLimit.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.userRollingLimit.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userRollingLimit),
  PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatBurstLimit.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatBurstLimit.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatBurstLimit),
  PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatRollingLimit.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.chatRollingLimit.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatRollingLimit),
  PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.queueBacklogLimit.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.queueBacklogLimit.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.queueBacklogLimit),
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_REDIS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.redisTimeoutMs.min)
    .max(PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.redisTimeoutMs.max)
    .default(PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.redisTimeoutMs),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api2.max.ru'),
  MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: envBoolean(true),
  MAX_JOIN_DENY_CHAT_IDS: z.string().optional(),

  DATABASE_URL: z.string().min(10),
  PRISMA_PG_POOL_MAX: z.coerce.number().int().positive().optional(),
  PRISMA_PG_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PRISMA_PG_POOL_MAX_LIFETIME_SEC: z.coerce.number().int().positive().optional(),
  PRISMA_PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PRISMA_POOL_MAX: z.coerce.number().int().positive().optional(),
  PRISMA_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PRISMA_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  REDIS_URL: z.string().url(),

  INIT_DATA_HMAC_SECRET: z.string().optional(),
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(3600),
  MINIAPP_SESSION_TTL_SEC: z.coerce.number().int().min(3_600).max(86_400).default(28_800),
  MINIAPP_SESSION_REDIS_TIMEOUT_MS: z.coerce.number().int().min(50).max(2_000).default(500),
  SYSTEM_ADMIN_USER_IDS: z.string().optional(),
  MAJOR_NETWORKS_ROLLOUT: z.enum(['off', 'test', 'on']).default('off'),
  SAFETY_DESK_ALLOWED_HOSTS: z.string().optional(),
  RUNTIME_OVERVIEW_READER_TOKEN_SHA256: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  ),
  ADMIN_ACCESS_CODE: z
    .string()
    .trim()
    .min(6)
    .max(256)
    .refine((value) => !DISALLOWED_ADMIN_ACCESS_CODES.has(value.toLowerCase()), {
      message: 'ADMIN_ACCESS_CODE must not use a documented placeholder',
    })
    .optional(),

  WEBHOOK_GLOBAL_RPS_LIMIT: z.coerce.number().int().positive().default(300),
  WEBHOOK_BURST_LIMIT: z.coerce.number().int().positive().default(450),
  WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(1_048_576),
  WEBHOOK_ACK_DEADLINE_MS: z.coerce.number().int().min(1_000).max(18_000).default(18_000),
  WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(10).max(5_000).default(100),
  WEBHOOK_RECEIPT_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(1_024).default(64),
  WEBHOOK_MEMBERSHIP_CACHE_MAX_IN_FLIGHT: z.coerce.number().int().min(2).max(1_024).default(64),
  CHAT_CONTEXT_LOCAL_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  CHAT_CONTEXT_LOCAL_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(536_870_912)
    .default(134_217_728),
  CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(65_536).default(2_048),
  CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRY_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(536_870_912)
    .default(134_217_728),
  CHAT_CONTEXT_LOCAL_CACHE_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
  CHAT_CONTEXT_LOCAL_CACHE_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(2_048).default(128),
  ENQUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  ENQUEUE_BATCH_SIZE: z.coerce.number().int().positive().default(400),
  ENQUEUE_CONCURRENCY: z.coerce.number().int().positive().default(32),
  ENQUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(120),
  WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: z.coerce.number().int().positive().default(90),
  WEBHOOK_ROUTING_CHAT_ASSIGNMENT_CAPACITY: z.coerce
    .number()
    .int()
    .min(1000)
    .max(1000000)
    .default(50000),
  WEBHOOK_ROUTING_QUEUE_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_MIN_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_SHARE: z.coerce
    .number()
    .min(0.5)
    .max(1)
    .default(0.7),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_MIN: z.coerce.number().int().positive().default(4),
  MAX_WEBHOOK_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MAX_WEBHOOK_STALE_INGRESS_MS: z.coerce.number().int().positive().default(300_000),
  MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS: z.coerce.number().int().positive().default(600_000),
  WEBHOOK_DYNAMIC_LEASES_MODE: z.enum(WEBHOOK_DYNAMIC_LEASES_MODES).default('off'),
  WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: z.enum(DEFAULT_WEBHOOK_WORKER_GROUP_NAMES).optional(),
  WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS: z.string().optional(),
  WEBHOOK_DYNAMIC_LEASES_HEARTBEAT_MS: z.coerce.number().int().positive().default(3_000),
  WEBHOOK_DYNAMIC_LEASES_LEASE_TTL_MS: z.coerce.number().int().positive().default(12_000),
  WEBHOOK_DYNAMIC_LEASES_HANDOFF_TTL_MS: z.coerce.number().int().positive().default(12_000),
  WEBHOOK_DYNAMIC_LEASES_REBALANCE_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  WEBHOOK_DYNAMIC_LEASES_SUPPRESS_LAG_SEC: z.coerce.number().int().positive().default(10),
  WEBHOOK_DYNAMIC_LEASES_SUMMARY_TTL_MS: z.coerce.number().int().positive().default(20_000),
  QUEUE_LAG_DEGRADE_SEC: z.coerce.number().int().positive().default(10),
  READY_QUEUE_LAG_SUSTAIN_SEC: z.coerce.number().int().positive().default(20),
  READY_QUEUE_LAG_SEVERE_SEC: z.coerce.number().int().positive().default(30),
  READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(2_000),
  READINESS_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(2_500),
  READINESS_DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
  READINESS_STALE_FALLBACK_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  DEGRADE_STABILIZE_SEC: z.coerce.number().int().positive().default(300),
  RAW_PAYLOAD_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.01),
  PARTICIPANT_REPORTS_MODE: z.enum(['off', 'canary', 'on']).default('off'),
  PARTICIPANT_REPORTS_CANARY_CHAT_IDS: z.string().default(''),
  PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED: envBoolean(false),
  PARTICIPANT_REPORTS_DETAIL_RETENTION_DAYS: z.coerce
    .number()
    .refine((value) => [30, 90, 180].includes(value))
    .default(30),
  WEBHOOK_COMPLETED_RETENTION_ENABLED: envBoolean(false),
  WEBHOOK_FAILED_RETENTION_ENABLED: envBoolean(false),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  WEBHOOK_FAILED_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  MODERATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  USER_DISPLAY_NAME_RETENTION_DAYS: z.coerce.number().int().min(90).default(180),
  MAX_API_METRICS_STORAGE_LAYOUT: z.enum(['legacy', 'minute']).default('minute'),
  MAX_API_GLOBAL_RPS: z.coerce.number().int().positive().max(30).default(30),
  MAX_API_GLOBAL_BURST: z.coerce.number().int().min(0).max(29).optional(),
  MAX_API_GLOBAL_RPS_CRITICAL: z.coerce.number().int().positive().optional(),
  MAX_API_GLOBAL_RPS_INTERACTIVE: z.coerce.number().int().positive().optional(),
  MAX_API_GLOBAL_RPS_BACKGROUND: z.coerce.number().int().positive().optional(),
  MAX_API_MANAGED_REFRESH_RPS: z.coerce.number().int().min(0).default(2),
  MAX_MUTED_USER_API_PROTECTION_ENABLED: envBoolean(true),
  MAX_API_CHAT_RPS: z.coerce.number().int().positive().default(5),
  MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: z.coerce.number().int().min(0).default(1_000),
  MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE: z.coerce.number().int().min(0).default(2_500),
  MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: z.coerce.number().int().min(0).default(1_500),
  MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: z.coerce.number().int().min(0).default(5_000),
  MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: z.coerce.number().int().positive().default(25),
  MAX_API_LIST_BOT_CHATS_CACHE_SEC: z.coerce.number().int().min(0).default(120),
  MAX_API_CHAT_SNAPSHOT_CACHE_SEC: z.coerce.number().int().min(0).default(300),
  MANAGED_ENTITY_HEADER_CACHE_SEC: z.coerce.number().int().positive().default(3600),
  MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX: z.coerce.number().int().positive().default(2),
  MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: z.coerce.number().int().min(0).default(12),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL: z.coerce.number().int().positive().default(2_000),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE: z.coerce.number().int().positive().default(3_000),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_BACKGROUND: z.coerce.number().int().positive().default(5_000),
  CHAT_ADMIN_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: envBoolean(false),
  SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_USER_FACING_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_RESET_MS: z.coerce.number().int().positive().default(45_000),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(2),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_WINDOW_MS: z.coerce.number().int().positive().default(45_000),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_DURATION_SEC: z.coerce.number().int().positive().default(120),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_POSITIVE_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(90),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(25),
  MAX_API_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_OPEN_SEC: z.coerce.number().int().positive().default(20),
  MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: z.coerce.number().int().positive().default(60),
  MAX_ROUTED_MUTATIONS_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('shadow'),
  MAX_FIXED_MODERATOR_SELECTION_ENABLED: envBoolean(false),
  MAX_FIXED_MODERATOR_SELECTION_ENTITY_IDS: z.string().default(''),
  MAX_ROUTED_MUTATIONS_CANARY_PERCENT: z.coerce.number().min(0).max(100).default(1),
  MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS: z.string().default(''),
  MAX_CROSS_BOT_EDIT_DELETE_ENABLED: envBoolean(false),
  MODERATION_DELETE_INTENT_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('off'),
  MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: z.string().default(''),
  MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: z.string().default(''),
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: envBoolean(false),
  MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: envBoolean(true),
  MODERATION_DELETE_INTENT_RETRY_HORIZON_MS: z.coerce.number().int().positive().default(86_400_000),
  MODERATION_DELETE_INTENT_RETRY_BASE_MS: z.coerce.number().int().positive().default(5_000),
  MODERATION_DELETE_INTENT_RETRY_MAX_MS: z.coerce.number().int().positive().default(300_000),
  MODERATION_DELETE_INTENT_CAPABILITY_RETRY_MS: z.coerce.number().int().positive().default(30_000),
  MODERATION_DELETE_INTENT_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  MODERATION_DELETE_INTENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  MODERATION_DELETE_INTENT_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  MODERATION_DELETE_INTENT_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  MODERATION_DELETE_INTENT_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MODERATION_DELETE_INTENT_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  MODERATION_DELETE_INTENT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(90),
  MESSAGE_RETENTION_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('off'),
  ERASER_ENABLED: envBoolean(false),
  ERASER_CONTROL_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  ERASER_CONTROL_TOKEN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional(),
  ),
  MESSAGE_RETENTION_CANARY_CHAT_IDS: z.string().default(''),
  MODERATION_DELETE_INTENT_PURGE_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(40),
  MODERATION_DELETE_INTENT_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  PROFANITY_V2_ROLLOUT_MODE: z.enum(['on', 'legacy']).default('on'),
  PHOTO_DUPLICATE_ROLLOUT_MODE: z.enum(PHOTO_DUPLICATE_ROLLOUT_MODES).default('shadow'),
  MESSAGE_DUPLICATE_ENABLED: envBoolean(true),
  MESSAGE_DUPLICATE_MEDIA_SHARED_ADMISSION_ENABLED: envBoolean(false),
  MESSAGE_DUPLICATE_ALLOWED_HOSTS: z.string().default('i.oneme.ru,fd.oneme.ru,*.okcdn.ru'),
  MESSAGE_DUPLICATE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(25_165_824)
    .default(8_388_608),
  PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS: photoDuplicateExactChatIdsSchema.default(''),
  PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS: photoDuplicateExactChatIdsSchema.default(''),
  PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS:
    photoDuplicateAllowedMatchKindsSchema.default('canonical_sha256'),
  PHOTO_DUPLICATE_MAX_ACTION: z.enum(PHOTO_DUPLICATE_MAX_ACTIONS).default('DELETE_MESSAGE'),
  PHOTO_DUPLICATE_ALLOWED_HOSTS: z.string().default('i.oneme.ru,fd.oneme.ru'),
  PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(5_000),
  PHOTO_DUPLICATE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(33_554_432)
    .default(16_777_216),
  PHOTO_DUPLICATE_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .max(100_000_000)
    .default(40_000_000),
  PHOTO_NATIVE_SANDBOX_SOCKET_PATH: z.literal('/run/maxim-photo/native-photo.sock').optional(),
  PHOTO_DUPLICATE_HISTORY_MAX_ITEMS: z.coerce.number().int().min(10).max(2_000).default(250),
  COMMERCIAL_LLM_SHADOW_ENABLED: envBoolean(false),
  COMMERCIAL_LLM_ENFORCEMENT_ENABLED: envBoolean(false),
  COMMERCIAL_LLM_POOL_WORKERS_ENABLED: envBoolean(false),
  COMMERCIAL_LLM_POOL_ENABLED: envBoolean(false),
  COMMERCIAL_LLM_POOL_4B_POLICY: z
    .enum(['confirm-positive', 'direct-4b'])
    .default('confirm-positive'),
  COMMERCIAL_LLM_ENDPOINT: z
    .literal('http://gemma-commercial-shadow:8080')
    .default('http://gemma-commercial-shadow:8080'),
  COMMERCIAL_OCR_ROLLOUT_MODE: z.enum(COMMERCIAL_OCR_ROLLOUT_MODES).default('off'),
  IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: z
    .enum(IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODES)
    .default('shadow'),
  COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: z
    .string()
    .trim()
    .max(100)
    .regex(/^\/run\/maxim-ocr\/[A-Za-z0-9._-]+\.sock$/u)
    .optional(),
  COMMERCIAL_OCR_CANARY_CHAT_IDS: commercialOcrExactChatIdsSchema.default(''),
  COMMERCIAL_OCR_VERSION: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
    .default(COMMERCIAL_OCR_DEFAULT_VERSION),
  COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS: z.coerce.number().int().min(1).max(10_000).default(16),
  COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS: z.coerce.number().int().min(1).max(1_000).default(10),
  COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(4),
  COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: z
    .string()
    .trim()
    .max(4_096)
    .refine(isCanonicalEd25519SpkiBase64, 'must be empty or canonical Ed25519 SPKI DER base64')
    .default(''),
  COMMERCIAL_OCR_MAX_JOB_AGE_MS: z.coerce.number().int().min(1_000).max(600_000).default(300_000),
  COMMERCIAL_OCR_RESERVATION_TTL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(660_000)
    .default(600_000),
  COMMERCIAL_OCR_CACHE_TTL_SEC: z.coerce
    .number()
    .int()
    .min(60)
    .max(31 * 24 * 60 * 60)
    .default(7 * 24 * 60 * 60),
  COMMERCIAL_OCR_MAX_INPUT_PIXELS: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .max(100_000_000)
    .default(40_000_000),
  COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: z.coerce
    .number()
    .int()
    .min(250_000)
    .max(12_000_000)
    .default(3_000_000),
  COMMERCIAL_OCR_MAX_SIDE: z.coerce.number().int().min(512).max(4_096).default(2_000),
  COMMERCIAL_OCR_TESSERACT_BINARY: z.string().trim().min(1).max(512).default('tesseract'),
  COMMERCIAL_OCR_TESSDATA_PREFIX: z.string().trim().min(1).max(1_024).optional(),
  COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(10_000),
  COMMERCIAL_OCR_TESSERACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: z.coerce.number().int().min(1).max(256).default(16),
  COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(250),
  COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(16 * 1024 * 1024)
    .default(4 * 1024 * 1024),
  OMP_THREAD_LIMIT: z.coerce.number().int().min(1).max(8).default(1),
  BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  BACKGROUND_GOVERNOR_CACHE_TTL_MS: z.coerce.number().int().positive().default(2_000),
  BACKGROUND_GOVERNOR_SOFT_QUEUE_LAG_SEC: z.coerce.number().positive().default(3),
  BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.3),
  BACKGROUND_GOVERNOR_WORKER_SKEW_PRESSURE: z.coerce.number().int().positive().default(4),
  BACKGROUND_GOVERNOR_WORKER_SKEW_SHARE: z.coerce.number().min(0.5).max(1).default(0.75),
  BACKGROUND_GOVERNOR_SLOW_RETRY_AFTER_MS: z.coerce.number().int().positive().default(45_000),
  BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  BACKGROUND_GOVERNOR_BOT_LOAD_SLOW_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.35),
  BACKGROUND_GOVERNOR_BOT_LOAD_PAUSE_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.7),
  BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED: envBoolean(false),
  BACKGROUND_GOVERNOR_SYSTEM_LOAD_SLOW_THRESHOLD: z.coerce.number().positive().default(0.85),
  BACKGROUND_GOVERNOR_SYSTEM_LOAD_PAUSE_THRESHOLD: z.coerce.number().positive().default(1.25),
  BACKGROUND_GOVERNOR_IOWAIT_SLOW_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.15),
  BACKGROUND_GOVERNOR_IOWAIT_PAUSE_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.35),
  SYSTEM_RUNTIME_DIAGNOSTICS_PROBLEM_CHAT_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  SYSTEM_WEBHOOK_SLO_WINDOW_SEC: z.coerce.number().int().positive().max(86_400).default(900),
  SYSTEM_WEBHOOK_SLO_TARGET_MS: z.coerce.number().int().positive().default(400),
  SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: z.coerce.number().int().positive().default(2_000),
  SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT: z.coerce.number().int().positive().default(5000),
  WEBHOOK_CANONICAL_EXECUTION_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('shadow'),
  WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT: z.coerce.number().min(0).max(100).default(1),
  WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS: z.string().default(''),
  MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('shadow'),
  MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT: z.coerce.number().min(0).max(100).default(1),
  MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_ENTITY_IDS: z.string().default(''),
  MAX_ACTION_DISPATCH_ENABLED: envBoolean(true),
  MAX_ACTION_FAILED_RETENTION_AGE_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),
  MAX_ACTION_FAILED_RETENTION_COUNT: z.coerce.number().int().positive().default(1000),
  MAX_ACTION_LEDGER_WATCHDOG_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('shadow'),
  MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT: z.coerce.number().min(0).max(100).default(1),
  MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS: z.string().default(''),
  APP_ROLE: z.enum(APP_ROLES).default('all'),
  APP_SERVICE_NAME: z.enum(RUNTIME_SERVICE_NAMES).optional(),
  BOT_OWNERSHIP_FOUNDATION_ENABLED: envBoolean(true),
  BOT_OWNERSHIP_REPAIR_RUNNER_ENABLED: envBoolean(false),
  BOT_OWNERSHIP_REPAIR_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  BOT_OWNERSHIP_REPAIR_LOCK_TTL_MS: z.coerce.number().int().positive().default(60_000),
  BOT_OWNERSHIP_REPAIR_BATCH_SIZE: z.coerce.number().int().positive().default(250),
  BOT_OWNERSHIP_REBALANCE_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('shadow'),
  BOT_OWNERSHIP_REBALANCE_CANARY_PERCENT: z.coerce.number().min(0).max(100).default(1),
  BOT_OWNERSHIP_REBALANCE_CANARY_ENTITY_IDS: z.string().default(''),
  BOT_OWNERSHIP_REBALANCE_MAX_MOVES_PER_RUN: z.coerce.number().int().positive().default(25),
  CHAT_ROUTING_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  CHAT_ROUTING_RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(250),
  CHAT_ROUTING_RECONCILE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  MODERATION_ENABLED_QUEUES: z.string().optional(),
  MODERATION_BACKGROUND_TASKS_ENABLED: envBoolean(true),
  MODERATION_LINK_STRUCTURED_TARGETS_ENABLED: envBoolean(true),
  MODERATION_LINK_PROFILE_MENTIONS_ENABLED: envBoolean(false),
  MODERATION_LINK_FORWARDED_TARGETS_ENABLED: envBoolean(true),
  MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: envBoolean(true),
  MODERATION_LINK_HISTORY_SCAN_ENABLED: envBoolean(false),
  MODERATION_LINK_HISTORY_DELETE_ENABLED: envBoolean(false),
  MODERATION_LINK_HISTORY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  MODERATION_LINK_HISTORY_SCAN_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  MODERATION_LINK_HISTORY_SCAN_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE: z.coerce.number().int().min(1).max(99).default(50),
  MODERATION_LINK_HISTORY_SCAN_SUCCESS_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  MODERATION_LINK_HISTORY_SCAN_ERROR_BACKOFF_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  MODERATION_LINK_HISTORY_DISCOVERY_OVERLAP_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  MODERATION_LINK_HISTORY_REPAIR_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60_000),
  MODERATION_LINK_HISTORY_REPAIR_SLICE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60_000),
  MODERATION_CONCURRENCY_LEGACY: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_CRITICAL: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_JOIN: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_0: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_1: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_2: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_3: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_4: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_5: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_6: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_7: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_8: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_9: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_10: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_11: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_12: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_13: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_14: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_15: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_BACKGROUND: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY: z.coerce.number().int().positive().default(8),
  REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: z.coerce.number().int().min(0).default(8),
  CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS: z.coerce.number().int().min(0).default(150),
  CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  CHANNEL_AUTO_POST_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  CHANNEL_AUTO_POST_STARTUP_JITTER_MS: z.coerce.number().int().min(0).default(15_000),
  CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN: z.coerce.number().int().positive().default(3),
  CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
  VK_SERVICE_TOKEN: z.string().min(10).optional(),
  VK_API_BASE_URL: z.string().url().default('https://api.vk.ru'),
  VK_API_VERSION: z.string().trim().min(1).default('5.199'),
  VK_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  VK_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  VK_API_RPS: z.coerce.number().int().positive().default(5),
  VK_API_RATE_LIMIT_WAIT_MS: z.coerce.number().int().min(0).default(2_000),
  VK_PARSING_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  VK_PARSING_MIN_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  VK_PARSING_MAX_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  VK_PARSING_FETCH_COUNT: z.coerce.number().int().min(1).max(100).default(100),
  VK_PARSING_MIN_PAGES: z.coerce.number().int().min(1).max(10).default(3),
  VK_PARSING_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(5),
  VK_PARSING_MISSING_CONFIRMATION_THRESHOLD: z.coerce.number().int().min(1).max(10).default(3),
  VK_PARSING_QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  VK_BOT_REVIEW_ENABLED: envBoolean(true),
  VK_PARSING_LEASE_TTL_MS: z.coerce.number().int().positive().default(120_000),
  VK_PARSING_MEDIA_PREFLIGHT_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: z.coerce.number().int().positive().default(120_000),
  VK_PARSING_MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(3),
  KARAVAN_MARKETPLACE_ENABLED: envBoolean(false),
  KARAVAN_MARKETPLACE_AUTHORITY_TOKEN: z.string().min(32).optional(),
  KARAVAN_MARKETPLACE_COMMAND_TOKEN: z.string().min(32).optional(),
  KARAVAN_MARKETPLACE_API_BASE_URL: z.string().url().optional(),
  KARAVAN_SELLER_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,100}$/u)
    .optional(),
  KARAVAN_STOREFRONT_RELAY_ENABLED: envBoolean(false),
  STATISTICS_EXCHANGE_V3_ENABLED: envBoolean(false),
  STATISTICS_CENTRAL_ENABLED: envBoolean(false),
  STATISTICS_CENTRAL_MODE: z.enum(['LEGACY', 'CENTRAL']).default('LEGACY'),
  STATISTICS_CENTRAL_EXCHANGE_EPOCH: z.string().uuid().optional(),
  SVYAZKA_STATISTICS_EXPORT_TOKEN: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  SVYAZKA_STATISTICS_V2_USERS: z
    .string()
    .regex(/^(\*|[1-9]\d{0,19}(?:\s*,\s*[1-9]\d{0,19})*)$/u)
    .default('323459159'),
  SVYAZKA_ANALYTICS_TOKEN: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  SVYAZKA_PROFILE_TOKEN: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  SVYAZKA_INTEGRATION_TOKEN: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  KARAVAN_API_BASE_URL: z.string().url().optional(),
  KARAVAN_INTEGRATION_TOKEN: z.string().min(16).optional(),
  KARAVAN_STOREFRONT_CATALOG_URL: z
    .string()
    .url()
    .default('https://max.ru/se13381675_1_bot?startapp='),
  KARAVAN_STOREFRONT_CREATE_URL: z
    .string()
    .url()
    .default('https://max.ru/se13381675_bot?startapp=storefront'),
  KARAVAN_STOREFRONT_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  KARAVAN_STOREFRONT_CACHE_TTL_SEC: z.coerce.number().int().min(1).max(3600).default(120),
  KARAVAN_STOREFRONT_RELAY_LOCK_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC: z.coerce.number().int().positive().default(5),
  BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE: z.coerce.number().int().positive().default(4),
  BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE: z.coerce.number().min(0.5).max(1).default(0.75),
  GLOBAL_SPAMMER_ARCHIVE_RUNNER_ENABLED: envBoolean(true),
  GLOBAL_SPAMMER_ARCHIVE_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
  GLOBAL_SPAMMER_ARCHIVE_LIMIT: z.coerce.number().int().min(1).max(5000).default(1000),
  SPAMMER_PROFILE_CACHE_ENABLED: envBoolean(false),
  SPAMMER_READ_MODEL_SHADOW_ENABLED: envBoolean(false),
  SPAMMER_READ_MODEL_SHADOW_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED: envBoolean(false),
  SPAMMER_DENORM_ASYNC_ENABLED: envBoolean(true),
  SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: envBoolean(false),
  SPAMMER_OBSERVATION_FAST_PATH_ENABLED: envBoolean(false),
  SPAMMER_OBSERVATION_FAST_PATH_SOURCES: z.string().optional(),
  ACTION_CONCURRENCY: z.coerce.number().int().positive().default(8),
  MAX_ACTION_CRITICAL_CONCURRENCY: z.coerce.number().int().positive().default(3),
  MAX_ACTION_INTERACTIVE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_ACTION_BACKGROUND_CONCURRENCY: z.coerce.number().int().positive().default(1),
  CHANNEL_STATS_STARTUP_SYNC_ENABLED: envBoolean(false),
  CHANNEL_STATS_STARTUP_MAX_CHANNELS: z.coerce.number().int().min(0).default(6),
  CHANNEL_STATS_STARTUP_STALE_MS: z.coerce.number().int().positive().default(21_600_000),
  CHANNEL_STATS_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  CHANNEL_STATS_STARTUP_JITTER_MS: z.coerce.number().int().min(0).default(15_000),
  CHANNEL_STATS_STARTUP_MAX_PAGES: z.coerce.number().int().positive().default(20),
  MANUAL_FANOUT_LOOKUP_SPACING_MS: z.coerce.number().int().min(0).default(180),
  MANUAL_FANOUT_ACTION_SPACING_MS: z.coerce.number().int().min(0).default(120),
  JSON_BODY_LIMIT: z.coerce.number().int().positive().default(33_554_432),
});

export type EnvSchema = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const parsed = envSchema.safeParse(resolvePublisherRuntimeSecrets(config));

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }

  if (parsed.data.COMMERCIAL_LLM_POOL_ENABLED && !parsed.data.COMMERCIAL_LLM_POOL_WORKERS_ENABLED)
    throw new Error(
      'Environment validation failed: COMMERCIAL_LLM_POOL_ENABLED requires COMMERCIAL_LLM_POOL_WORKERS_ENABLED',
    );

  if (
    parsed.data.ERASER_ENABLED &&
    (!parsed.data.ERASER_CONTROL_URL || !parsed.data.ERASER_CONTROL_TOKEN)
  )
    throw new Error(
      'Environment validation failed: ERASER_ENABLED requires independent control URL and token',
    );
  if (parsed.data.ERASER_CONTROL_URL) {
    const origin = new URL(parsed.data.ERASER_CONTROL_URL);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !['http:', 'https:'].includes(origin.protocol) ||
      !['', '/'].includes(origin.pathname)
    )
      throw new Error(
        'Environment validation failed: ERASER_CONTROL_URL must be an HTTP origin without credentials or path',
      );
  }

  if (
    parsed.data.SVYAZKA_STATISTICS_EXPORT_TOKEN &&
    [parsed.data.SVYAZKA_ANALYTICS_TOKEN, parsed.data.SVYAZKA_PROFILE_TOKEN].includes(
      parsed.data.SVYAZKA_STATISTICS_EXPORT_TOKEN,
    )
  )
    throw new Error(
      'Environment validation failed: SVYAZKA_STATISTICS_EXPORT_TOKEN must use a separate credential',
    );

  if (
    parsed.data.APP_SERVICE_NAME &&
    RUNTIME_SERVICE_PROFILES[parsed.data.APP_SERVICE_NAME].appRole !== parsed.data.APP_ROLE
  ) {
    throw new Error(
      `Environment validation failed: ${parsed.data.APP_SERVICE_NAME} service requires ${RUNTIME_SERVICE_PROFILES[parsed.data.APP_SERVICE_NAME].appRole} role`,
    );
  }

  if (
    parsed.data.PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT <
    parsed.data.PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT
  ) {
    throw new Error(
      'Environment validation failed: PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT must be greater than or equal to PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT',
    );
  }
  if (
    parsed.data.PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT <
    parsed.data.PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT
  ) {
    throw new Error(
      'Environment validation failed: PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT must be greater than or equal to PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT',
    );
  }
  if (
    parsed.data.PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT <
    parsed.data.PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT
  ) {
    throw new Error(
      'Environment validation failed: PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT must be greater than or equal to PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT',
    );
  }
  if (
    parsed.data.PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT <
    parsed.data.PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT
  ) {
    throw new Error(
      'Environment validation failed: PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT must be greater than or equal to PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT',
    );
  }
  if (
    parsed.data.MODERATION_DELETE_INTENT_LEASE_MS <= parsed.data.MODERATION_DELETE_INTENT_TIMEOUT_MS
  ) {
    throw new Error(
      'Environment validation failed: MODERATION_DELETE_INTENT_LEASE_MS must be greater than MODERATION_DELETE_INTENT_TIMEOUT_MS',
    );
  }
  if (
    parsed.data.MODERATION_DELETE_INTENT_RETRY_MAX_MS <
    parsed.data.MODERATION_DELETE_INTENT_RETRY_BASE_MS
  ) {
    throw new Error(
      'Environment validation failed: MODERATION_DELETE_INTENT_RETRY_MAX_MS must be greater than or equal to MODERATION_DELETE_INTENT_RETRY_BASE_MS',
    );
  }
  if (
    parsed.data.COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS >
    parsed.data.COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS
  ) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS must not exceed COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS',
    );
  }
  if (
    (parsed.data.COMMERCIAL_OCR_ROLLOUT_MODE === 'baseline' ||
      parsed.data.COMMERCIAL_OCR_ROLLOUT_MODE === 'canary' ||
      parsed.data.COMMERCIAL_OCR_ROLLOUT_MODE === 'on') &&
    parsed.data.COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS >
      parsed.data.COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS
  ) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS must not exceed COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS',
    );
  }
  if (
    parsed.data.APP_SERVICE_NAME === 'api-moderation-background' &&
    !parsed.data.PHOTO_NATIVE_SANDBOX_SOCKET_PATH
  ) {
    throw new Error(
      'Environment validation failed: PHOTO_NATIVE_SANDBOX_SOCKET_PATH is required for api-moderation-background',
    );
  }
  if (
    parsed.data.PHOTO_NATIVE_SANDBOX_SOCKET_PATH &&
    (parsed.data.PHOTO_DUPLICATE_MAX_BYTES > 16_777_216 ||
      parsed.data.PHOTO_DUPLICATE_MAX_PIXELS > 40_000_000)
  ) {
    throw new Error(
      'Environment validation failed: photo input limits exceed the native sandbox boundary',
    );
  }
  if (
    parsed.data.APP_SERVICE_NAME === 'api-media-analysis' &&
    !parsed.data.COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH
  ) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH is required for api-media-analysis',
    );
  }
  if (
    (parsed.data.COMMERCIAL_OCR_ROLLOUT_MODE === 'canary' ||
      parsed.data.COMMERCIAL_OCR_ROLLOUT_MODE === 'on') &&
    !parsed.data.COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64
  ) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64 is required for canary or on commercial OCR rollout',
    );
  }
  if (
    parsed.data.COMMERCIAL_OCR_RESERVATION_TTL_MS <
    parsed.data.COMMERCIAL_OCR_MAX_JOB_AGE_MS + 60_000
  ) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_RESERVATION_TTL_MS must cover COMMERCIAL_OCR_MAX_JOB_AGE_MS plus the 60000ms source clock-skew window',
    );
  }
  if (parsed.data.COMMERCIAL_OCR_MAX_OUTPUT_PIXELS > parsed.data.COMMERCIAL_OCR_MAX_INPUT_PIXELS) {
    throw new Error(
      'Environment validation failed: COMMERCIAL_OCR_MAX_OUTPUT_PIXELS must not exceed COMMERCIAL_OCR_MAX_INPUT_PIXELS',
    );
  }

  if (parsed.data.KARAVAN_MARKETPLACE_ENABLED) {
    const required = [
      'KARAVAN_MARKETPLACE_AUTHORITY_TOKEN',
      'KARAVAN_MARKETPLACE_COMMAND_TOKEN',
      'KARAVAN_MARKETPLACE_API_BASE_URL',
      'KARAVAN_SELLER_BOT_USERNAME',
    ] as const;
    const missing = required.filter((key) => !parsed.data[key]);
    if (missing.length)
      throw new Error(
        `Environment validation failed: KARAVAN_MARKETPLACE_ENABLED requires ${missing.join(', ')}`,
      );
    const url = new URL(parsed.data.KARAVAN_MARKETPLACE_API_BASE_URL!);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error(
        'Environment validation failed: KARAVAN_MARKETPLACE_API_BASE_URL must be an HTTPS origin without credentials, query or fragment',
      );
    if (
      parsed.data.KARAVAN_MARKETPLACE_AUTHORITY_TOKEN ===
        parsed.data.KARAVAN_MARKETPLACE_COMMAND_TOKEN ||
      [
        parsed.data.KARAVAN_MARKETPLACE_AUTHORITY_TOKEN,
        parsed.data.KARAVAN_MARKETPLACE_COMMAND_TOKEN,
      ].includes(parsed.data.KARAVAN_INTEGRATION_TOKEN)
    )
      throw new Error(
        'Environment validation failed: Karavan marketplace secrets must be independent',
      );
  }
  if (parsed.data.KARAVAN_STOREFRONT_RELAY_ENABLED) {
    const missingKeys = [
      parsed.data.KARAVAN_API_BASE_URL ? null : 'KARAVAN_API_BASE_URL',
      parsed.data.KARAVAN_INTEGRATION_TOKEN ? null : 'KARAVAN_INTEGRATION_TOKEN',
    ].filter((key): key is string => key !== null);

    if (missingKeys.length > 0) {
      throw new Error(
        `Environment validation failed: KARAVAN_STOREFRONT_RELAY_ENABLED requires ${missingKeys.join(', ')}`,
      );
    }
  }

  if (parsed.data.NODE_ENV === 'production') {
    assertProductionPublicHttpsOrigin('APP_BASE_URL', parsed.data.APP_BASE_URL);
    assertProductionPublicHttpsOrigin('MAX_WEBHOOK_BASE_URL', parsed.data.MAX_WEBHOOK_BASE_URL);
    assertProductionPublicHttpsOrigin(
      'KARAVAN_STOREFRONT_CATALOG_URL',
      parsed.data.KARAVAN_STOREFRONT_CATALOG_URL,
    );
    assertProductionPublicHttpsOrigin(
      'KARAVAN_STOREFRONT_CREATE_URL',
      parsed.data.KARAVAN_STOREFRONT_CREATE_URL,
    );
    assertProductionCurrentMaxApiHost(parsed.data.MAX_API_BASE_URL);

    if (!parsed.data.ADMIN_ACCESS_CODE) {
      throw new Error('Environment validation failed: ADMIN_ACCESS_CODE is required in production');
    }

    for (const [key, value] of [
      ['MAX_WEBHOOK_SECRET_PATH', parsed.data.MAX_WEBHOOK_SECRET_PATH],
      ['MAX_WEBHOOK_HEADER_SECRET', parsed.data.MAX_WEBHOOK_HEADER_SECRET],
      ['MAX_WEBHOOK_HEADER_SECRET_PREVIOUS', parsed.data.MAX_WEBHOOK_HEADER_SECRET_PREVIOUS],
    ] as const) {
      if (!value) {
        continue;
      }
      const normalized = value.trim();
      if (
        !PRODUCTION_WEBHOOK_SECRET_PATTERN.test(normalized) ||
        DISALLOWED_PRODUCTION_WEBHOOK_SECRETS.has(normalized.toLowerCase())
      ) {
        throw new Error(
          `Environment validation failed: ${key} must be a non-default URL-safe secret (16-128 chars, A-Z/a-z/0-9/_/-) in production`,
        );
      }
    }
  }

  try {
    const additionalBots = parseAdditionalMaxBotsJson(parsed.data.MAX_BOTS_JSON);
    const resolvedBots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: parsed.data.MAX_BOT_ID,
        label: parsed.data.MAX_BOT_LABEL,
        characterName: parsed.data.MAX_BOT_CHARACTER_NAME,
        speechPersona: parsed.data.MAX_BOT_SPEECH_PERSONA,
        token: parsed.data.MAX_BOT_TOKEN,
        tokenPrevious: parsed.data.MAX_BOT_TOKEN_PREVIOUS,
        webhookSecretPath: parsed.data.MAX_WEBHOOK_SECRET_PATH,
        webhookHeaderSecret: parsed.data.MAX_WEBHOOK_HEADER_SECRET,
        webhookHeaderSecretPrevious: parsed.data.MAX_WEBHOOK_HEADER_SECRET_PREVIOUS,
        contactId: parsed.data.MAX_BOT_CONTACT_ID,
        state: parsed.data.MAX_BOT_STATE,
        ownershipWeight: parsed.data.MAX_BOT_OWNERSHIP_WEIGHT,
      },
      additionalBotsJson: parsed.data.MAX_BOTS_JSON,
    });
    resolveMaxEntryBotConfig(resolvedBots, parsed.data.MAX_ENTRY_BOT_ID);

    if (parsed.data.NODE_ENV === 'production') {
      for (const bot of additionalBots) {
        for (const [key, value] of [
          [`MAX_BOTS_JSON.${bot.id}.webhookSecretPath`, bot.webhookSecretPath],
          [`MAX_BOTS_JSON.${bot.id}.webhookHeaderSecret`, bot.webhookHeaderSecret],
          [`MAX_BOTS_JSON.${bot.id}.webhookHeaderSecretPrevious`, bot.webhookHeaderSecretPrevious],
        ] as const) {
          if (!value) {
            continue;
          }

          const normalized = value.trim();
          if (
            !PRODUCTION_WEBHOOK_SECRET_PATTERN.test(normalized) ||
            DISALLOWED_PRODUCTION_WEBHOOK_SECRETS.has(normalized.toLowerCase())
          ) {
            throw new Error(
              `Environment validation failed: ${key} must be a non-default URL-safe secret (16-128 chars, A-Z/a-z/0-9/_/-) in production`,
            );
          }
        }
      }
    }
  } catch (error: unknown) {
    throw new Error(
      `Environment validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parsed.data;
}

function resolvePublisherRuntimeSecrets(config: Record<string, unknown>): Record<string, unknown> {
  if (readTrimmedEnvValue(config.APP_ROLE) !== 'publisher') {
    return config;
  }
  if (readTrimmedEnvValue(config.APP_SERVICE_NAME) !== 'api-publisher') {
    throw new Error('Environment validation failed: publisher role requires api-publisher service');
  }

  const leakedKeys = ['MAX_BOT_TOKEN', 'MAX_BOT_TOKEN_PREVIOUS', 'MAX_BOTS_JSON'].filter(
    (key) => readTrimmedEnvValue(config[key]).length > 0,
  );
  if (leakedKeys.length > 0) {
    throw new Error(
      `Environment validation failed: publisher runtime must not inherit main bot credentials (${leakedKeys.join(', ')})`,
    );
  }

  const publisherBotId =
    readTrimmedEnvValue(config.MAX_PUBLISHER_BOT_ID) || DEFAULT_MAX_PUBLISHER_BOT_ID;
  for (const key of ['MAX_BOT_ID', 'MAX_ENTRY_BOT_ID'] as const) {
    const configured = readTrimmedEnvValue(config[key]);
    if (configured && configured !== publisherBotId) {
      throw new Error(
        `Environment validation failed: ${key} must equal MAX_PUBLISHER_BOT_ID in publisher runtime`,
      );
    }
  }

  const tokenFile = readTrimmedEnvValue(config.MAX_PUBLISHER_BOT_TOKEN_FILE);
  const webhookFile = readTrimmedEnvValue(config.MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE);
  const dialogSigningKeyFile = readTrimmedEnvValue(config.MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE);
  if (!tokenFile || !webhookFile || !dialogSigningKeyFile) {
    throw new Error(
      'Environment validation failed: publisher runtime requires file-mounted bot, webhook, and dialog signing credentials',
    );
  }
  const token = readPublisherActionTokenFile(tokenFile);
  const webhook = readPublisherWebhookCredentialFile(webhookFile);
  const dialogSigningKeys = readPublisherDialogSigningKeysFile(dialogSigningKeyFile);
  if (webhook.botId !== publisherBotId || dialogSigningKeys.botId !== publisherBotId) {
    throw new Error(
      'Environment validation failed: publisher credential bot id does not match MAX_PUBLISHER_BOT_ID',
    );
  }

  return {
    ...config,
    MAX_BOT_ID: publisherBotId,
    MAX_BOT_LABEL: 'Публик',
    MAX_BOT_CHARACTER_NAME: 'Публик',
    MAX_BOT_SPEECH_PERSONA: 'neutral',
    MAX_BOT_STATE: 'active',
    MAX_BOT_OWNERSHIP_WEIGHT: 1,
    MAX_ENTRY_BOT_ID: publisherBotId,
    MAX_BOT_TOKEN: token,
    MAX_BOT_TOKEN_PREVIOUS: undefined,
    MAX_BOTS_JSON: undefined,
    MAX_WEBHOOK_SECRET_PATH: webhook.secretPath,
    MAX_WEBHOOK_HEADER_SECRET: webhook.headerSecrets[0],
    MAX_WEBHOOK_HEADER_SECRET_PREVIOUS: webhook.headerSecrets[1],
  };
}

function readTrimmedEnvValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
