import { z } from 'zod';
import { offsetTimestampSchema } from './validator-compat.js';
import { MAX_HTTP_BUTTON_URL_LENGTH, normalizeHttpButtonUrl } from './button-url.js';

export const MAX_PUBLICATION_IMAGES = 10;
export const MAX_PUBLICATION_IMAGE_BASE64_LENGTH = 12_000_000;
export const MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH = 32_000_000;
export const MAX_PUBLICATION_VIDEO_BASE64_LENGTH = 32_000_000;
export const MAX_PUBLICATION_BUTTONS = 8;
export const MAX_PUBLICATION_RECURRENCE_OCCURRENCES = 365;
export const MAX_PUBLICATION_EXPLICIT_SLOTS = 300;
export const MAX_PUBLICATION_LIST_CURSOR_LENGTH = 1_024;
export const MAX_PUBLICATION_CALENDAR_WINDOW_DAYS = 62;
export const MAX_LEGACY_PUBLICATION_LIST_LIMIT = 30;
export const MAX_PUBLICATION_TEXT_LENGTH = 4_000;
export const MAX_PUBLICATION_DELETE_AFTER_MINUTES = 30 * 24 * 60;

export const publicationPostPublishSchema = z.object({
  pin: z.enum(['none', 'silent', 'notify']).default('none'),
  deleteAfterMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PUBLICATION_DELETE_AFTER_MINUTES)
    .nullable()
    .default(null),
});
export type PublicationPostPublish = z.infer<typeof publicationPostPublishSchema>;

export const publicationPostActionStatusSchema = z.enum([
  'NONE',
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'AMBIGUOUS',
  'SKIPPED',
]);
export const publicationPostActionCommandSchema = z.enum([
  'cancel_delete',
  'reschedule_delete',
  'retry_delete',
  'retry_pin',
]);
export type PublicationPostActionCommand = z.infer<typeof publicationPostActionCommandSchema>;
export type { PublicationPostActionRequest } from './publication-post-action-request.js';
export const publicationPostActionsSchema = z.object({
  version: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  busy: z.boolean().optional(),
  allowedActions: z.array(publicationPostActionCommandSchema).optional(),
  pinStatus: publicationPostActionStatusSchema,
  pinError: z.string().nullable(),
  deleteStatus: publicationPostActionStatusSchema,
  deleteAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  deleteError: z.string().nullable(),
});
export type PublicationPostActions = z.infer<typeof publicationPostActionsSchema>;

export const publicationErrorCodeSchema = z.enum([
  'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
  'PUBLICATION_REVISION_CONFLICT',
  'PUBLICATION_SCHEDULE_CONFLICT',
  'PUBLICATION_SCHEDULE_EMPTY',
]);
export type PublicationErrorCode = z.infer<typeof publicationErrorCodeSchema>;

export const publicationLifecycleSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELED',
  'ERROR',
]);
export const publicationAudienceSelectionSchema = z.enum([
  'SELECTED',
  'ALL_CHATS',
  'ALL_CHANNELS',
  'ALL_MANAGED',
]);
export const publicationAudienceModeSchema = z.enum(['SNAPSHOT', 'DYNAMIC']);
export const publicationEntityTypeSchema = z.enum(['chat', 'channel']);
export const publicationTextFormatSchema = z.enum(['plain', 'markdown']);
export const publicationIntentSchema = z.enum(['draft', 'publish']);
export const publicationOccurrenceStatusSchema = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'SENT',
  'PARTIAL',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);
export const publicationDispatchIssueSchema = z.enum([
  'actor_access_required',
  'target_setup_required',
  'temporarily_unavailable',
]);
export const publicationDeliveryStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);

export type PublicationLifecycle = z.infer<typeof publicationLifecycleSchema>;
export type PublicationAudienceSelection = z.infer<typeof publicationAudienceSelectionSchema>;
export type PublicationAudienceMode = z.infer<typeof publicationAudienceModeSchema>;
export type PublicationEntityType = z.infer<typeof publicationEntityTypeSchema>;
export type PublicationTextFormat = z.infer<typeof publicationTextFormatSchema>;
export type PublicationIntent = z.infer<typeof publicationIntentSchema>;
export type PublicationOccurrenceStatus = z.infer<typeof publicationOccurrenceStatusSchema>;
export type PublicationDispatchIssue = z.infer<typeof publicationDispatchIssueSchema>;
export type PublicationDeliveryStatus = z.infer<typeof publicationDeliveryStatusSchema>;

function isValidPublicationButtonUrl(value: string): boolean {
  const normalized = normalizeHttpButtonUrl(value);
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const startPayload = (parsed.searchParams.get('start') ?? '').trim();
    return !startPayload.startsWith('pmh-') && !startPayload.startsWith('pm2_');
  } catch {
    return false;
  }
}

export const publicationButtonSchema = z.object({
  text: z.string().trim().min(1).max(32),
  url: z
    .string()
    .trim()
    .max(MAX_HTTP_BUTTON_URL_LENGTH)
    .refine((value) => isValidPublicationButtonUrl(value), {
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    }),
  row: z.number().int().min(0).max(9).default(0),
});
export type PublicationButton = z.infer<typeof publicationButtonSchema>;

export const publicationImageInputSchema = z.object({
  type: z.literal('image'),
  base64: z.string().trim().min(1).max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH),
  mimeType: z.string().trim().toLowerCase().startsWith('image/').max(128),
  fileName: z.string().trim().max(128).default(''),
});

export const publicationVideoInputSchema = z.object({
  type: z.literal('video'),
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  base64: z.string().trim().max(MAX_PUBLICATION_VIDEO_BASE64_LENGTH).default(''),
  mimeType: z.string().trim().max(128).default(''),
  fileName: z.string().trim().max(128).default(''),
});

export const publicationImageReferenceInputSchema = z.object({
  type: z.literal('image-ref'),
  assetId: z.string().trim().min(1),
  sourcePublicationId: z.string().trim().min(1).max(256).optional(),
});

export const publicationVideoReferenceInputSchema = z.object({
  type: z.literal('video-ref'),
  assetId: z.string().trim().min(1),
  sourcePublicationId: z.string().trim().min(1).max(256).optional(),
});

export const publicationMediaInputSchema = z.discriminatedUnion('type', [
  publicationImageInputSchema,
  publicationVideoInputSchema,
  publicationImageReferenceInputSchema,
  publicationVideoReferenceInputSchema,
]);
export type PublicationMediaInput = z.infer<typeof publicationMediaInputSchema>;

export const publicationAssetSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'video']),
  mimeType: z.string(),
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
});
export type PublicationAsset = z.infer<typeof publicationAssetSchema>;

export const MAX_PUBLICATION_VIDEO_UPLOAD_BYTES = 100_000_000;
export const publicationVideoUploadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/u);
export const createPublicationVideoUploadSchema = z
  .object({
    requestId: publicationVideoUploadIdSchema,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u),
    mimeType: z.enum(['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm']),
    sizeBytes: z.number().int().positive().max(MAX_PUBLICATION_VIDEO_UPLOAD_BYTES),
  })
  .strict();
export type CreatePublicationVideoUpload = z.infer<typeof createPublicationVideoUploadSchema>;
export const publicationVideoUploadStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PENDING'), uploadId: publicationVideoUploadIdSchema }),
  z.object({
    status: z.literal('UPLOADING'),
    uploadId: publicationVideoUploadIdSchema,
    url: z.string().url().max(8192),
    expiresAt: z.string().datetime(),
  }),
  z.object({ status: z.literal('PROCESSING'), uploadId: publicationVideoUploadIdSchema }),
  z.object({
    status: z.literal('READY'),
    uploadId: publicationVideoUploadIdSchema,
    asset: publicationAssetSchema,
  }),
  z.object({
    status: z.literal('FAILED'),
    uploadId: publicationVideoUploadIdSchema,
    message: z.string(),
  }),
]);
export type PublicationVideoUploadStatus = z.infer<typeof publicationVideoUploadStatusSchema>;

export const publicationDraftContentInputSchema = z
  .object({
    postPublish: publicationPostPublishSchema.optional(),
    text: z.string().max(MAX_PUBLICATION_TEXT_LENGTH).default(''),
    textFormat: publicationTextFormatSchema.default('plain'),
    buttons: z.array(publicationButtonSchema).max(MAX_PUBLICATION_BUTTONS).default([]),
    media: z.array(publicationMediaInputSchema).max(MAX_PUBLICATION_IMAGES).default([]),
  })
  .superRefine((value, ctx) => {
    const videos = value.media.filter((item) => item.type === 'video' || item.type === 'video-ref');
    const images = value.media.filter((item) => item.type === 'image' || item.type === 'image-ref');
    const inlineImageBase64Length = value.media.reduce(
      (total, item) => total + (item.type === 'image' ? item.base64.length : 0),
      0,
    );
    if (inlineImageBase64Length > MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }
    if (videos.length > 1 || (videos.length > 0 && images.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Добавьте либо до 10 фото, либо одно видео.',
      });
    }
    const video = videos[0];
    if (video?.type === 'video') {
      const hasPayload = video.payload !== null && Object.keys(video.payload).length > 0;
      const hasBytes = video.base64.length > 0;
      if (hasPayload === hasBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media'],
          message: 'Добавьте видеофайл или сохранённое видео.',
        });
      }
      if (hasBytes && !video.mimeType.toLowerCase().startsWith('video/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media'],
          message: 'Неверный формат видео.',
        });
      }
    }
  });
export const publicationContentInputSchema = publicationDraftContentInputSchema.superRefine(
  (value, ctx) => {
    if (value.text.trim().length === 0 && value.media.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст, добавьте фото или видео.',
      });
    }
  },
);
export type PublicationContentInput = z.infer<typeof publicationContentInputSchema>;

export const publicationContentSchema = z.object({
  postPublish: publicationPostPublishSchema.optional(),
  revision: z.number().int().min(1),
  text: z.string(),
  textFormat: publicationTextFormatSchema,
  buttons: z.array(publicationButtonSchema),
  media: z.array(publicationAssetSchema),
});
export type PublicationContent = z.infer<typeof publicationContentSchema>;

export const publicationTargetInputSchema = z.object({
  chatId: z.string().trim().min(1),
  entityType: publicationEntityTypeSchema,
});
export type PublicationTargetInput = z.infer<typeof publicationTargetInputSchema>;

export const publicationAudienceInputSchema = z
  .object({
    selection: publicationAudienceSelectionSchema.default('SELECTED'),
    mode: publicationAudienceModeSchema.default('SNAPSHOT'),
    targets: z.array(publicationTargetInputSchema).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.selection === 'SELECTED' && value.targets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'Выберите хотя бы один чат или канал.',
      });
    }
    const uniqueTargets = new Set(value.targets.map((target) => target.chatId));
    if (uniqueTargets.size !== value.targets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'Один получатель выбран несколько раз.',
      });
    }
  });
export type PublicationAudienceInput = z.infer<typeof publicationAudienceInputSchema>;

export const publicationTargetSchema = publicationTargetInputSchema.extend({
  title: z.string(),
  avatarUrl: z.string().url().nullable().default(null),
  link: z.string().url().nullable().default(null),
});
export type PublicationTarget = z.infer<typeof publicationTargetSchema>;

const publicationTimezoneSchema = z.string().trim().min(1).max(128).default('Europe/Moscow');
const publicationDateTimeSchema = offsetTimestampSchema;
const publicationLocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

// Omission preserves the five-minute behavior of persisted legacy schedules.
export const publicationLatePolicySchema = z.object({
  mode: z.enum(['recover', 'strict']),
  maxDelayMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60),
  catchUp: z.enum(['latest', 'all']),
});
export type PublicationLatePolicy = z.infer<typeof publicationLatePolicySchema>;
export const DEFAULT_PUBLICATION_LATE_POLICY: PublicationLatePolicy = {
  mode: 'recover',
  maxDelayMinutes: 24 * 60,
  catchUp: 'latest',
};

export const publicationNowScheduleSchema = z.object({
  mode: z.literal('now'),
  timezone: publicationTimezoneSchema,
});
export const publicationOnceScheduleSchema = z.object({
  mode: z.literal('once'),
  latePolicy: publicationLatePolicySchema.optional(),
  timezone: publicationTimezoneSchema,
  at: publicationDateTimeSchema,
  replaceConflicts: z.boolean().default(false),
});
export const publicationSlotsScheduleSchema = z.object({
  mode: z.literal('slots'),
  latePolicy: publicationLatePolicySchema.optional(),
  timezone: publicationTimezoneSchema,
  slots: z
    .array(publicationDateTimeSchema)
    .min(1)
    .max(
      MAX_PUBLICATION_EXPLICIT_SLOTS,
      `Можно запланировать не более ${MAX_PUBLICATION_EXPLICIT_SLOTS} отправок.`,
    ),
  replaceConflicts: z.boolean().default(false),
});
export const publicationRecurrenceScheduleSchema = z
  .object({
    mode: z.literal('recurrence'),
    latePolicy: publicationLatePolicySchema.optional(),
    timezone: publicationTimezoneSchema,
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(31).default(1),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    times: z.array(publicationLocalTimeSchema).min(1).max(12),
    startsAt: publicationDateTimeSchema.nullable().default(null),
    endsAt: publicationDateTimeSchema.nullable().default(null),
    maxOccurrences: z
      .number()
      .int()
      .min(1)
      .max(MAX_PUBLICATION_RECURRENCE_OCCURRENCES)
      .nullable()
      .default(null),
    replaceConflicts: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.frequency === 'weekly' && value.weekdays.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Выберите хотя бы один день недели.',
      });
    }
    if (new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Дни недели не должны повторяться.',
      });
    }
    if (new Set(value.times).size !== value.times.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['times'],
        message: 'Время публикации не должно повторяться.',
      });
    }
    if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Дата завершения должна быть позже даты начала.',
      });
    }
  });

export const publicationScheduleInputSchema = z.discriminatedUnion('mode', [
  publicationNowScheduleSchema,
  publicationOnceScheduleSchema,
  publicationSlotsScheduleSchema,
  publicationRecurrenceScheduleSchema,
]);
export type PublicationScheduleInput = z.infer<typeof publicationScheduleInputSchema>;

export const publicationCalendarAvailabilityRequestSchema = z
  .object({
    audience: publicationAudienceInputSchema,
    from: publicationDateTimeSchema,
    to: publicationDateTimeSchema,
    excludePublicationId: z.string().trim().min(1).max(256).optional(),
  })
  .superRefine((value, ctx) => {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Конец периода должен быть позже начала.',
      });
      return;
    }
    if (to - from > MAX_PUBLICATION_CALENDAR_WINDOW_DAYS * 24 * 60 * 60_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `Период календаря не может быть больше ${MAX_PUBLICATION_CALENDAR_WINDOW_DAYS} дней.`,
      });
    }
  });
export type PublicationCalendarAvailabilityRequest = z.infer<
  typeof publicationCalendarAvailabilityRequestSchema
>;

export const publicationCalendarAvailabilitySlotSchema = z.object({
  scheduledAt: publicationDateTimeSchema,
  targetCount: z.number().int().min(1),
});
export type PublicationCalendarAvailabilitySlot = z.infer<
  typeof publicationCalendarAvailabilitySlotSchema
>;

export const publicationCalendarAvailabilityResponseSchema = z.object({
  from: publicationDateTimeSchema,
  to: publicationDateTimeSchema,
  slots: z.array(publicationCalendarAvailabilitySlotSchema).default([]),
});
export type PublicationCalendarAvailabilityResponse = z.infer<
  typeof publicationCalendarAvailabilityResponseSchema
>;

export const publicationScheduleSchema = publicationScheduleInputSchema.and(
  z.object({
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELED', 'ERROR']),
    revision: z.number().int().min(1),
    nextOccurrenceAt: publicationDateTimeSchema.nullable(),
    lastError: z.string().nullable(),
  }),
);
export type PublicationSchedule = z.infer<typeof publicationScheduleSchema>;

const publicationMutationBaseSchema = z.object({
  title: z.string().trim().max(120).default(''),
  content: publicationContentInputSchema,
  audience: publicationAudienceInputSchema,
  schedule: publicationScheduleInputSchema.nullable().default(null),
  intent: publicationIntentSchema.default('publish'),
});

export const createPublicationRequestSchema = publicationMutationBaseSchema
  .extend({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  })
  .superRefine((value, ctx) => {
    if (value.intent === 'publish' && value.schedule === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule'],
        message: 'Выберите время публикации.',
      });
    }
  });
export type CreatePublicationRequest = z.infer<typeof createPublicationRequestSchema>;

// FLAG: PATCH omission must preserve stored fields; only supplied nested objects keep defaults.
export const updatePublicationRequestSchema = publicationMutationBaseSchema
  .extend({
    title: publicationMutationBaseSchema.shape.title.removeDefault(),
    schedule: publicationMutationBaseSchema.shape.schedule.removeDefault(),
    intent: publicationMutationBaseSchema.shape.intent.removeDefault(),
  })
  .partial()
  .extend({
    expectedRevision: z.number().int().min(1),
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  });
export type UpdatePublicationRequest = z.infer<typeof updatePublicationRequestSchema>;

export const testPublicationRequestSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  content: publicationContentInputSchema,
  sourceTarget: publicationTargetInputSchema,
});
export type TestPublicationRequest = z.infer<typeof testPublicationRequestSchema>;

export const publicationDeliveryStatsSchema = z.object({
  total: z.number().int().min(0),
  pending: z.number().int().min(0),
  dispatchPending: z.number().int().min(0).optional(),
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
  ambiguous: z.number().int().min(0),
  canceled: z.number().int().min(0),
});
export type PublicationDeliveryStats = z.infer<typeof publicationDeliveryStatsSchema>;

export const publicationOccurrenceSummarySchema = z.object({
  id: z.string(),
  scheduledAt: publicationDateTimeSchema,
  status: publicationOccurrenceStatusSchema,
  dispatchIssue: publicationDispatchIssueSchema.nullable().optional().default(null),
  dispatchBlockedSince: publicationDateTimeSchema.nullable().optional(),
  dispatchCheckedAt: publicationDateTimeSchema.nullable().optional(),
  requiresScheduleDecision: z.boolean().optional(),
  delivery: publicationDeliveryStatsSchema,
  canRetry: z.boolean(),
  contentRevision: z.number().int().min(1).optional(),
  usesLatestContent: z.boolean().optional(),
});
export type PublicationOccurrenceSummary = z.infer<typeof publicationOccurrenceSummarySchema>;

export const publicationSummarySchema = z.object({
  access: z.object({ canManageAllTargets: z.boolean() }).optional(),
  requiresScheduleDecision: z.boolean().optional(),
  postPublish: publicationPostPublishSchema.optional(),
  id: z.string(),
  title: z.string(),
  lifecycle: publicationLifecycleSchema,
  version: z.number().int().min(1),
  contentPreview: z.string(),
  contentPreviewFormat: publicationTextFormatSchema.default('plain'),
  targetCount: z.number().int().min(0),
  targetPreviews: z.array(publicationTargetSchema).max(6),
  targetOverflowCount: z.number().int().min(0),
  audienceSelection: publicationAudienceSelectionSchema,
  audienceMode: publicationAudienceModeSchema,
  mediaCount: z.number().int().min(0),
  hasVideo: z.boolean(),
  schedule: publicationScheduleSchema.nullable(),
  dispatchIssue: publicationDispatchIssueSchema.nullable().optional().default(null),
  delivery: publicationDeliveryStatsSchema,
  actionableDelivery: publicationDeliveryStatsSchema.optional(),
  createdAt: publicationDateTimeSchema,
  updatedAt: publicationDateTimeSchema,
});
export type PublicationSummary = z.infer<typeof publicationSummarySchema>;

export const publicationDetailsSchema = publicationSummarySchema.extend({
  content: publicationContentSchema,
  targets: z.array(publicationTargetSchema),
  occurrences: z.array(publicationOccurrenceSummarySchema),
});
export type PublicationDetails = z.infer<typeof publicationDetailsSchema>;

export const publicationTargetsRefreshResponseSchema = z
  .object({
    accepted: z.literal(true),
    queuedCount: z.number().int().min(0),
    operationId: z.string().uuid().optional(),
  })
  .strict();
export type PublicationTargetsRefreshResponse = z.infer<
  typeof publicationTargetsRefreshResponseSchema
>;

export const publicationListViewSchema = z.enum([
  'current',
  'plan',
  'drafts',
  'schedules',
  'history',
]);
export const publicationListStatusFilterSchema = z.enum([
  'active',
  'paused',
  'completed',
  'failed',
]);

export const publicationListCursorPayloadSchema = z.object({
  v: z.literal(1),
  updatedAt: publicationDateTimeSchema,
  id: z.string().trim().min(1).max(256),
  view: publicationListViewSchema,
  query: z.string().max(120),
  entityType: publicationEntityTypeSchema.optional(),
  status: publicationListStatusFilterSchema.optional(),
});
export type PublicationListCursorPayload = z.infer<typeof publicationListCursorPayloadSchema>;

export function encodePublicationListCursor(payload: PublicationListCursorPayload): string {
  const parsed = publicationListCursorPayloadSchema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodePublicationListCursor(value: string): PublicationListCursorPayload | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PUBLICATION_LIST_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    return null;
  }

  try {
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(
      `${normalized.replace(/-/gu, '+').replace(/_/gu, '/')}${padding}`,
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const parsed = publicationListCursorPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const listPublicationsQuerySchema = z.object({
  view: publicationListViewSchema.default('plan'),
  cursor: z.string().trim().min(1).max(MAX_PUBLICATION_LIST_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  query: z.string().trim().max(120).default(''),
  entityType: publicationEntityTypeSchema.optional(),
  status: publicationListStatusFilterSchema.optional(),
});
export type ListPublicationsQuery = z.infer<typeof listPublicationsQuerySchema>;

export const listPublicationsResponseSchema = z.object({
  items: z.array(publicationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListPublicationsResponse = z.infer<typeof listPublicationsResponseSchema>;

export const legacyPublicationKindSchema = z.enum(['autopost', 'broadcast']);
export type LegacyPublicationKind = z.infer<typeof legacyPublicationKindSchema>;

export const legacyPublicationListKindSchema = z.enum(['all', 'autopost', 'broadcast']);
export const legacyPublicationListViewSchema = z.enum(['active', 'history']);

export const legacyPublicationListCursorPayloadSchema = z.object({
  v: z.literal(1),
  updatedAt: publicationDateTimeSchema,
  id: z.string().trim().min(1).max(256),
  itemKind: legacyPublicationKindSchema,
  view: legacyPublicationListViewSchema,
  kind: legacyPublicationListKindSchema,
  entityType: publicationEntityTypeSchema.optional(),
  query: z.string().max(120),
});
export type LegacyPublicationListCursorPayload = z.infer<
  typeof legacyPublicationListCursorPayloadSchema
>;

export function encodeLegacyPublicationListCursor(
  payload: LegacyPublicationListCursorPayload,
): string {
  const parsed = legacyPublicationListCursorPayloadSchema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodeLegacyPublicationListCursor(
  value: string,
): LegacyPublicationListCursorPayload | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PUBLICATION_LIST_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    return null;
  }

  try {
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(
      `${normalized.replace(/-/gu, '+').replace(/_/gu, '/')}${padding}`,
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const parsed = legacyPublicationListCursorPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const listLegacyPublicationsQuerySchema = z.object({
  view: legacyPublicationListViewSchema.default('active'),
  kind: legacyPublicationListKindSchema.default('all'),
  entityType: publicationEntityTypeSchema.optional(),
  query: z.string().trim().max(120).default(''),
  cursor: z.string().trim().min(1).max(MAX_PUBLICATION_LIST_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LEGACY_PUBLICATION_LIST_LIMIT).default(30),
});
export type ListLegacyPublicationsQuery = z.infer<typeof listLegacyPublicationsQuerySchema>;

export const legacyPublicationSourceSchema = z.object({
  chatId: z.string(),
  entityType: publicationEntityTypeSchema,
  title: z.string(),
  avatarUrl: z.string().url().nullable(),
  link: z.string().trim().max(2_048).nullable(),
});
export type LegacyPublicationSource = z.infer<typeof legacyPublicationSourceSchema>;

const legacyPublicationSummaryBaseSchema = z.object({
  id: z.string(),
  source: legacyPublicationSourceSchema,
  title: z.string(),
  contentPreview: z.string(),
  targetCount: z.number().int().min(1),
  mediaCount: z.number().int().min(0),
  hasVideo: z.boolean(),
  scheduleTimezone: z.string().trim().min(1).max(128),
  nextRunAt: publicationDateTimeSchema.nullable(),
  createdAt: publicationDateTimeSchema,
  updatedAt: publicationDateTimeSchema,
  lastError: z.string().nullable(),
});

export const legacyAutopostPublicationSummarySchema = legacyPublicationSummaryBaseSchema.extend({
  kind: z.literal('autopost'),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'ERROR']),
});
export type LegacyAutopostPublicationSummary = z.infer<
  typeof legacyAutopostPublicationSummarySchema
>;

export const legacyBroadcastPublicationSummarySchema = legacyPublicationSummaryBaseSchema.extend({
  kind: z.literal('broadcast'),
  status: z.enum(['ACTIVE', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELED']),
});
export type LegacyBroadcastPublicationSummary = z.infer<
  typeof legacyBroadcastPublicationSummarySchema
>;

export const legacyPublicationSummarySchema = z.discriminatedUnion('kind', [
  legacyAutopostPublicationSummarySchema,
  legacyBroadcastPublicationSummarySchema,
]);
export type LegacyPublicationSummary = z.infer<typeof legacyPublicationSummarySchema>;

export const listLegacyPublicationsResponseSchema = z.object({
  items: z.array(legacyPublicationSummarySchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().min(0),
});
export type ListLegacyPublicationsResponse = z.infer<typeof listLegacyPublicationsResponseSchema>;

export const publicationCapacityWaitReasonSchema = z.enum([
  'max_rate_limit',
  'local_capacity',
  'circuit_open',
]);
export type PublicationCapacityWaitReason = z.infer<typeof publicationCapacityWaitReasonSchema>;

export const publicationDeliverySchema = z.object({
  dispatchStopped: z.boolean().optional(),
  deadlineAt: publicationDateTimeSchema.nullable().optional(),
  nextAttemptAt: publicationDateTimeSchema.nullable().optional(),
  waitReason: publicationCapacityWaitReasonSchema.nullable().optional(),
  firstDeferredAt: publicationDateTimeSchema.nullable().optional(),
  postActions: publicationPostActionsSchema.optional(),
  id: z.string(),
  occurrenceId: z.string(),
  target: publicationTargetSchema,
  status: publicationDeliveryStatusSchema,
  contentRevision: z.number().int().min(1).optional(),
  usesLatestContent: z.boolean().optional(),
  attemptCount: z.number().int().min(0),
  remoteMessageId: z.string().nullable(),
  lastError: z.string().nullable(),
  sentAt: publicationDateTimeSchema.nullable(),
});
export type PublicationDelivery = z.infer<typeof publicationDeliverySchema>;

export const listPublicationDeliveriesQuerySchema = z.object({
  occurrenceId: z.string().trim().min(1).optional(),
  status: publicationDeliveryStatusSchema.optional(),
  excludeStatus: publicationDeliveryStatusSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListPublicationDeliveriesQuery = z.infer<typeof listPublicationDeliveriesQuerySchema>;

export const listPublicationDeliveriesResponseSchema = z.object({
  items: z.array(publicationDeliverySchema),
  nextCursor: z.string().nullable(),
});
export type ListPublicationDeliveriesResponse = z.infer<
  typeof listPublicationDeliveriesResponseSchema
>;

export const publicationActionRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
});
export type PublicationActionRequest = z.infer<typeof publicationActionRequestSchema>;

export const publicationRetryContentModeSchema = z.enum(['original', 'latest']);
export type PublicationRetryContentMode = z.infer<typeof publicationRetryContentModeSchema>;

export const retryPublicationOccurrenceRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
    contentMode: publicationRetryContentModeSchema.optional(),
    expectedPublicationVersion: z.number().int().min(1).optional(),
    expectedContentRevision: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.contentMode !== 'latest') {
      return;
    }
    if (value.expectedPublicationVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedPublicationVersion'],
        message: 'Версия публикации обязательна для повтора актуального содержимого.',
      });
    }
    if (value.expectedContentRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedContentRevision'],
        message: 'Версия содержимого обязательна для безопасного повтора.',
      });
    }
  });
export type RetryPublicationOccurrenceRequest = z.infer<
  typeof retryPublicationOccurrenceRequestSchema
>;

export const resolvePublicationAmbiguousDeliveryRequestSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  deliveryId: z.string().trim().min(1),
  resolution: z.enum(['mark_sent', 'mark_failed']),
});
export type ResolvePublicationAmbiguousDeliveryRequest = z.infer<
  typeof resolvePublicationAmbiguousDeliveryRequestSchema
>;
