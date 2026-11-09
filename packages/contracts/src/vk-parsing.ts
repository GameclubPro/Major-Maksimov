import { z } from 'zod';
import {
  normalizeVkParsingSourceLink,
  VK_PARSING_MAX_DELETE_AFTER_MINUTES,
  VK_PARSING_MAX_SOURCE_LINK_URL_LENGTH,
} from './vk-parsing-common.js';
export {
  buildVkParsingSourceLink,
  normalizeVkParsingSourceLink,
  VK_PARSING_MAX_DELETE_AFTER_MINUTES,
  VK_PARSING_MAX_SOURCE_LINK_URL_LENGTH,
} from './vk-parsing-common.js';
import { utcTimestampSchema } from './validator-compat.js';

import { broadcastTextFormatSchema } from './broadcast-common.js';
import {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH,
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  VK_PARSING_MAX_VIDEOS,
} from './vk-parsing-common.js';

export {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH,
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  VK_PARSING_MAX_VIDEOS,
};

export const vkParsingSourceStatusSchema = z.enum(['ACTIVE', 'DISABLED']);
export type VkParsingSourceStatus = z.infer<typeof vkParsingSourceStatusSchema>;

export const vkParsingSourceSyncStatusSchema = z.enum([
  'IDLE',
  'QUEUED',
  'SYNCING',
  'BACKOFF',
  'ERROR',
]);
export type VkParsingSourceSyncStatus = z.infer<typeof vkParsingSourceSyncStatusSchema>;

export const vkParsingPostStatusSchema = z.enum([
  'NEW',
  'PUBLISHED',
  'FAILED',
  'CHANGED_AFTER_PUBLISH',
  'UNAVAILABLE',
  'SKIPPED',
]);
export type VkParsingPostStatus = z.infer<typeof vkParsingPostStatusSchema>;

export const vkParsingPublishModeSchema = z.enum(['IMMEDIATE', 'QUEUE', 'REVIEW', 'BOT_REVIEW']);
export type VkParsingPublishMode = z.infer<typeof vkParsingPublishModeSchema>;

export const vkBotReviewSettingsRequestSchema = z.object({
  action: z.enum(['CONNECT', 'PAUSE', 'RESUME']),
});
export type VkBotReviewSettingsRequest = z.infer<typeof vkBotReviewSettingsRequestSchema>;

export const vkBotReviewStateSchema = z.object({
  available: z.boolean(),
  inboxConnected: z.boolean(),
  isRecipient: z.boolean(),
  recipientConfigured: z.boolean(),
  paused: z.boolean(),
  pendingCount: z.number().int().min(0),
  botUrl: z.string().url(),
});
export type VkBotReviewState = z.infer<typeof vkBotReviewStateSchema>;

export const vkBotReviewSummarySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
  deliveryState: z.string(),
  lastError: z.string().nullable(),
});

export const vkParsingSourcePrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);
export type VkParsingSourcePriority = z.infer<typeof vkParsingSourcePrioritySchema>;

export const vkParsingBulkPresetSchema = z.enum(['NEWS', 'SLOW', 'REVIEW', 'CLEAN']);
export type VkParsingBulkPreset = z.infer<typeof vkParsingBulkPresetSchema>;

export const vkParsingPostSkipReasonSchema = z.enum([
  'AD',
  'EMPTY_AFTER_LINK_FILTER',
  'NO_SUPPORTED_CONTENT',
]);
export type VkParsingPostSkipReason = z.infer<typeof vkParsingPostSkipReasonSchema>;

export const vkParsingPostFilterStatusSchema = z.union([
  z.literal('ALL'),
  z.literal('QUEUED'),
  vkParsingPostStatusSchema,
]);
export type VkParsingPostFilterStatus = z.infer<typeof vkParsingPostFilterStatusSchema>;

export const vkParsingTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

export const vkParsingUnsupportedAttachmentSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().default(''),
    title: z.string().nullable().default(null),
    url: z.string().url().nullable().default(null),
    count: z.number().int().min(1).default(1),
    reason: z.string().nullable().default(null),
  })
  .passthrough();
export type VkParsingUnsupportedAttachment = z.infer<typeof vkParsingUnsupportedAttachmentSchema>;

export const vkParsingSourceLinkUrlSchema = z
  .string()
  .trim()
  .max(VK_PARSING_MAX_SOURCE_LINK_URL_LENGTH)
  .refine((value) => value === '' || normalizeVkParsingSourceLink(value) !== null, {
    message: 'Укажите HTTPS-ссылку без логина и пароля.',
  })
  .transform((value) => (value === '' ? '' : normalizeVkParsingSourceLink(value)!));
export const vkParsingDeleteAfterMinutesSchema = z
  .number()
  .int()
  .min(1)
  .max(VK_PARSING_MAX_DELETE_AFTER_MINUTES)
  .nullable();

export const vkParsingSettingsSchema = z.object({
  sourceLinkEnabled: z.boolean().default(false),
  sourceLinkUrl: vkParsingSourceLinkUrlSchema.default(''),
  deleteAfterMinutes: vkParsingDeleteAfterMinutesSchema.default(null),
  chatId: z.string(),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishEnabledAt: z.string().datetime().nullable().default(null),
  autoPublishKillSwitchEnabled: z.boolean().default(false),
  stripLinksEnabled: z.boolean().default(false),
  skipAdsEnabled: z.boolean().default(false),
  appendChannelLinkEnabled: z.boolean().default(false),
  channelLinkText: z
    .string()
    .trim()
    .max(VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH)
    .default(VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT),
  schedulerTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  quietHoursStart: vkParsingTimeOfDaySchema.nullable().default(null),
  quietHoursEnd: vkParsingTimeOfDaySchema.nullable().default(null),
  workHoursStart: vkParsingTimeOfDaySchema.default('09:00'),
  workHoursEnd: vkParsingTimeOfDaySchema.default('22:00'),
  distributeEvenlyEnabled: z.boolean().default(true),
  roundRobinEnabled: z.boolean().default(true),
  circuitBreakerEnabled: z.boolean().default(true),
  circuitBreakerWindowMinutes: z.number().int().min(1).max(1440).default(10),
  circuitBreakerPostLimit: z.number().int().min(1).max(500).default(10),
  updatedAt: z.string().datetime().nullable().default(null),
});
export type VkParsingSettings = z.infer<typeof vkParsingSettingsSchema>;

export const vkParsingSourceSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  ownerId: z.number().int(),
  wallOwnerId: z.number().int(),
  screenName: z.string(),
  title: z.string(),
  url: z.string().url(),
  status: vkParsingSourceStatusSchema,
  importEnabled: z.boolean().default(true),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishEnabledAt: z.string().datetime().nullable().default(null),
  autoPublishPausedAt: z.string().datetime().nullable().default(null),
  autoPublishPausedReason: z.string().nullable().default(null),
  publishIntervalMinutes: z.number().int().min(5).max(10080).default(60),
  dailyLimit: z.number().int().min(1).max(500).default(3),
  minPublishIntervalMinutes: z.number().int().min(0).max(1440).default(30),
  publishMode: vkParsingPublishModeSchema.default('QUEUE'),
  priority: vkParsingSourcePrioritySchema.default('NORMAL'),
  quietHoursStart: vkParsingTimeOfDaySchema.nullable().default(null),
  quietHoursEnd: vkParsingTimeOfDaySchema.nullable().default(null),
  lastAutoPublishedAt: z.string().datetime().nullable().default(null),
  newPostCount: z.number().int().min(0).default(0),
  queuedPostCount: z.number().int().min(0).default(0),
  publishedPostCount: z.number().int().min(0).default(0),
  skippedPostCount: z.number().int().min(0).default(0),
  failedPostCount: z.number().int().min(0).default(0),
  syncStatus: vkParsingSourceSyncStatusSchema.default('IDLE'),
  nextSyncAt: z.string().datetime().nullable().default(null),
  nextRetryAt: z.string().datetime().nullable().default(null),
  lastSyncAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable().default(null),
  syncStartedAt: z.string().datetime().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  terminalFailureCount: z.number().int().min(0).default(0),
  circuitOpenedAt: z.string().datetime().nullable().default(null),
  circuitReasonCode: z.string().nullable().default(null),
  circuitReason: z.string().nullable().default(null),
  circuitRetryAt: z.string().datetime().nullable().default(null),
  lastErrorCode: z.string().nullable().default(null),
  lastImportedCount: z.number().int().min(0).default(0),
  lastFetchedCount: z.number().int().min(0).default(0),
  lastFetchedPages: z.number().int().min(0).default(0),
  lastFetchedOffsets: z.array(z.number().int().min(0)).default([]),
  lastVkNewestPostId: z.number().int().nullable().default(null),
  lastVkNewestPublishedAt: z.string().datetime().nullable().default(null),
  adaptiveIntervalMs: z.number().int().min(0).nullable().default(null),
  lastSyncDurationMs: z.number().int().min(0).nullable().default(null),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VkParsingSource = z.infer<typeof vkParsingSourceSchema>;

export const vkParsingPostSchema = z.object({
  botReview: vkBotReviewSummarySchema.nullable().optional(),
  id: z.string(),
  sourceId: z.string(),
  chatId: z.string(),
  sourceTitle: z.string(),
  sourceUrl: z.string().url(),
  sourcePublishMode: vkParsingPublishModeSchema.default('QUEUE'),
  vkOwnerId: z.number().int(),
  vkPostId: z.number().int(),
  vkPublishedAt: z.string().datetime().nullable(),
  text: z.string(),
  textFormat: broadcastTextFormatSchema.default('plain'),
  url: z.string().url(),
  photoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_PHOTOS).default([]),
  videoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_VIDEOS).default([]),
  linkUrls: z.array(z.string().url()).max(VK_PARSING_MAX_LINKS).default([]),
  attachmentTypes: z.array(z.string()).default([]),
  unsupportedAttachments: z.array(vkParsingUnsupportedAttachmentSchema).default([]),
  hasUnsupportedAttachments: z.boolean().default(false),
  isAdvertising: z.boolean().default(false),
  advertisingMarkers: z.array(z.string()).default([]),
  status: vkParsingPostStatusSchema,
  contentHash: z.string().default(''),
  publishedContentHash: z.string().nullable().default(null),
  publishedMessageId: z.string().nullable(),
  publishedUrl: z.string().url().nullable(),
  autoDeleteAt: z.string().datetime().nullable().default(null),
  deletedAt: z.string().datetime().nullable().default(null),
  publishedAtMax: z.string().datetime().nullable(),
  autoPublishedAt: z.string().datetime().nullable().default(null),
  autoPublishError: z.string().nullable().default(null),
  skippedAt: z.string().datetime().nullable().default(null),
  skipReason: vkParsingPostSkipReasonSchema.nullable().default(null),
  lastSeenAt: z.string().datetime().nullable().default(null),
  missingSinceAt: z.string().datetime().nullable().default(null),
  missingSeenCount: z.number().int().min(0).default(0),
  lastAvailabilityCheckedAt: z.string().datetime().nullable().default(null),
  unavailableAt: z.string().datetime().nullable().default(null),
  publishQueuedAt: z.string().datetime().nullable().default(null),
  publishScheduledAt: z.string().datetime().nullable().default(null),
  publishCancelledAt: z.string().datetime().nullable().default(null),
  publishCancelledByUserId: z.string().nullable().default(null),
  publishLockedAt: z.string().datetime().nullable().default(null),
  publishAttemptCount: z.number().int().min(0).default(0),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VkParsingPost = z.infer<typeof vkParsingPostSchema>;

export const vkParsingCapabilitySchema = z.object({
  enabled: z.boolean().default(false),
  canUse: z.boolean().default(false),
  reasonCode: z.enum(['NOT_CONFIGURED', 'ACCESS_DENIED', 'NOT_FOUND']).nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type VkParsingCapability = z.infer<typeof vkParsingCapabilitySchema>;

export const vkParsingFeedPaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  total: z.number().int().min(0).default(0),
  hasMore: z.boolean().default(false),
  nextOffset: z.number().int().min(0).nullable().default(null),
});
export type VkParsingFeedPagination = z.infer<typeof vkParsingFeedPaginationSchema>;

export const vkParsingHealthSummarySchema = z.object({
  chatId: z.string(),
  generatedAt: z.string().datetime(),
  vkApiRps: z.number().min(0).default(0),
  vkApiErrorRate: z.number().min(0).max(1).default(0),
  sourceCount: z.number().int().min(0).default(0),
  staleSourceCount: z.number().int().min(0).default(0),
  importLagSeconds: z.number().int().min(0).nullable().default(null),
  publishLagSeconds: z.number().int().min(0).nullable().default(null),
  publishBacklogAgeSeconds: z.number().int().min(0).nullable().default(null),
  publishBacklog: z.number().int().min(0).default(0),
  staleSyncLockCount: z.number().int().min(0).default(0),
  circuitOpenSourceCount: z.number().int().min(0).default(0),
  importSuccessRate: z.number().min(0).max(1).default(1),
  p95SyncDurationMs: z.number().int().min(0).nullable().default(null),
  mediaFailureRatio: z.number().min(0).max(1).default(0),
  recentErrors: z
    .array(
      z.object({
        code: z.string(),
        count: z.number().int().min(0),
      }),
    )
    .default([]),
});
export type VkParsingHealthSummary = z.infer<typeof vkParsingHealthSummarySchema>;

export const vkParsingFeedSchema = z.object({
  capabilities: vkParsingCapabilitySchema.default({
    enabled: false,
    canUse: false,
    reasonCode: null,
    reason: null,
  }),
  settings: vkParsingSettingsSchema.default({
    sourceLinkEnabled: false,
    sourceLinkUrl: '',
    deleteAfterMinutes: null,
    chatId: '',
    autoPublishEnabled: false,
    autoPublishEnabledAt: null,
    autoPublishKillSwitchEnabled: false,
    stripLinksEnabled: false,
    skipAdsEnabled: false,
    appendChannelLinkEnabled: false,
    channelLinkText: VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
    schedulerTimezone: 'Europe/Moscow',
    quietHoursStart: null,
    quietHoursEnd: null,
    workHoursStart: '09:00',
    workHoursEnd: '22:00',
    distributeEvenlyEnabled: true,
    roundRobinEnabled: true,
    circuitBreakerEnabled: true,
    circuitBreakerWindowMinutes: 10,
    circuitBreakerPostLimit: 10,
    updatedAt: null,
  }),
  sources: z.array(vkParsingSourceSchema).default([]),
  posts: z.array(vkParsingPostSchema).default([]),
  queue: z.array(vkParsingPostSchema).default([]),
  auditEvents: z
    .array(
      z.object({
        id: z.string(),
        action: z.string(),
        actorUserId: z.string(),
        payload: z.record(z.string(), z.unknown()).default({}),
        createdAt: z.string().datetime(),
      }),
    )
    .default([]),
  pagination: vkParsingFeedPaginationSchema.default({
    limit: 50,
    offset: 0,
    total: 0,
    hasMore: false,
    nextOffset: null,
  }),
  summary: vkParsingHealthSummarySchema.nullable().default(null),
});
export type VkParsingFeed = z.infer<typeof vkParsingFeedSchema>;

export const vkParsingFeedQuerySchema = z.object({
  status: vkParsingPostFilterStatusSchema.default('ALL'),
  sourceId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type VkParsingFeedQuery = z.infer<typeof vkParsingFeedQuerySchema>;

export const updateVkParsingSettingsRequestSchema = z
  .object({
    sourceLinkEnabled: z.boolean().optional(),
    sourceLinkUrl: vkParsingSourceLinkUrlSchema.optional(),
    deleteAfterMinutes: vkParsingDeleteAfterMinutesSchema.optional(),
    autoPublishMode: z.enum(['AUTO', 'MANUAL', 'PAUSED']).optional(),
    autoPublishEnabled: z.boolean().optional(),
    autoPublishKillSwitchEnabled: z.boolean().optional(),
    stripLinksEnabled: z.boolean().optional(),
    skipAdsEnabled: z.boolean().optional(),
    appendChannelLinkEnabled: z.boolean().optional(),
    channelLinkText: z.string().trim().max(VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH).optional(),
    schedulerTimezone: z.string().trim().min(1).max(64).optional(),
    quietHoursStart: vkParsingTimeOfDaySchema.nullable().optional(),
    quietHoursEnd: vkParsingTimeOfDaySchema.nullable().optional(),
    workHoursStart: vkParsingTimeOfDaySchema.optional(),
    workHoursEnd: vkParsingTimeOfDaySchema.optional(),
    distributeEvenlyEnabled: z.boolean().optional(),
    roundRobinEnabled: z.boolean().optional(),
    circuitBreakerEnabled: z.boolean().optional(),
    circuitBreakerWindowMinutes: z.number().int().min(1).max(1440).optional(),
    circuitBreakerPostLimit: z.number().int().min(1).max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  })
  .superRefine((value, ctx) => {
    if (value.autoPublishMode === undefined) {
      return;
    }
    if (
      value.autoPublishEnabled !== undefined ||
      value.autoPublishKillSwitchEnabled !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoPublishMode'],
        message: 'Передайте либо готовый режим автопубликации, либо отдельные флаги.',
      });
    }
  });
export type UpdateVkParsingSettingsRequest = z.infer<typeof updateVkParsingSettingsRequestSchema>;

export const updateVkParsingSourceRequestSchema = z
  .object({
    importEnabled: z.boolean().optional(),
    autoPublishEnabled: z.boolean().optional(),
    publishIntervalMinutes: z.number().int().min(5).max(10080).optional(),
    dailyLimit: z.number().int().min(1).max(500).optional(),
    minPublishIntervalMinutes: z.number().int().min(0).max(1440).optional(),
    publishMode: vkParsingPublishModeSchema.optional(),
    priority: vkParsingSourcePrioritySchema.optional(),
    quietHoursStart: vkParsingTimeOfDaySchema.nullable().optional(),
    quietHoursEnd: vkParsingTimeOfDaySchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateVkParsingSourceRequest = z.infer<typeof updateVkParsingSourceRequestSchema>;

export const bulkUpdateVkParsingSourcesRequestSchema = z.object({
  sourceIds: z.array(z.string().min(1)).min(1).max(50),
  preset: vkParsingBulkPresetSchema,
});
export type BulkUpdateVkParsingSourcesRequest = z.infer<
  typeof bulkUpdateVkParsingSourcesRequestSchema
>;

export const addVkParsingSourceRequestSchema = z.object({
  url: z.string().trim().min(2).max(512),
});
export type AddVkParsingSourceRequest = z.infer<typeof addVkParsingSourceRequestSchema>;

export const publishVkParsingPostRequestSchema = z
  .object({
    text: z.string().max(VK_PARSING_MAX_PUBLISH_TEXT_LENGTH).default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    photoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_PHOTOS).default([]),
    videoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_VIDEOS).default([]),
    linkUrls: z.array(z.string().url()).max(VK_PARSING_MAX_LINKS).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.text.trim().length === 0 &&
      value.photoUrls.length === 0 &&
      value.videoUrls.length === 0 &&
      value.linkUrls.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Добавьте текст, фото, видео или ссылку.',
      });
    }
    if (value.photoUrls.length > 0 && value.videoUrls.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['videoUrls'],
        message: 'В одном VK-посте можно опубликовать либо фото, либо видео.',
      });
    }
  });
export type PublishVkParsingPostRequest = z.infer<typeof publishVkParsingPostRequestSchema>;

export const scheduleVkParsingPostRequestSchema = z.object({
  scheduledAt: utcTimestampSchema,
});
export type ScheduleVkParsingPostRequest = z.infer<typeof scheduleVkParsingPostRequestSchema>;

export const vkParsingDryRunResultSchema = z.object({
  chatId: z.string(),
  sourceId: z.string().nullable().default(null),
  generatedAt: z.string().datetime(),
  globalEnabled: z.boolean().default(false),
  killSwitchEnabled: z.boolean().default(false),
  baselineAt: z.string().datetime().nullable().default(null),
  eligibleNow: z.number().int().min(0).default(0),
  latestImportedVkPublishedAt: z.string().datetime().nullable().default(null),
  sourcesWithoutSuccessfulSync: z.number().int().min(0).default(0),
});
export type VkParsingDryRunResult = z.infer<typeof vkParsingDryRunResultSchema>;

export const rollbackVkParsingRequestSchema = z.object({
  since: z.string().datetime(),
  until: z.string().datetime(),
  sourceId: z.string().trim().min(1).optional(),
  deleteMessages: z.boolean().default(false),
});
export type RollbackVkParsingRequest = z.infer<typeof rollbackVkParsingRequestSchema>;

export const rollbackVkParsingResultSchema = z.object({
  matched: z.number().int().min(0).default(0),
  deleted: z.number().int().min(0).default(0),
  queued: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  posts: z.array(vkParsingPostSchema).default([]),
});
export type RollbackVkParsingResult = z.infer<typeof rollbackVkParsingResultSchema>;

export const vkParsingRefreshResultSchema = vkParsingFeedSchema.extend({
  imported: z.number().int().min(0).default(0),
  queued: z.number().int().min(0).default(0),
});
export type VkParsingRefreshResult = z.infer<typeof vkParsingRefreshResultSchema>;

export const publishVkParsingPostResultSchema = z.object({
  post: vkParsingPostSchema,
  queued: z.number().int().min(0).default(0),
  // Rolling-deploy compatibility for an old API that still completed the send inline.
  messageId: z.string().optional(),
  url: z.string().url().nullable().optional(),
});
export type PublishVkParsingPostResult = z.infer<typeof publishVkParsingPostResultSchema>;

export const retryVkParsingPostResultSchema = z.object({
  post: vkParsingPostSchema,
  queued: z.number().int().min(0).default(0),
});
export type RetryVkParsingPostResult = z.infer<typeof retryVkParsingPostResultSchema>;
