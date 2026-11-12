import { z } from 'zod';
import { broadcastTextFormatSchema } from './broadcast-common.js';

export const channelDialogTypeSchema = /*#__PURE__*/ z.enum(['comments', 'suggest']);
export type ChannelDialogType = z.infer<typeof channelDialogTypeSchema>;
export const MAX_CHANNEL_DIALOG_SUGGEST_IMAGES = 10;
export const MAX_CHANNEL_DIALOG_ATTACHMENTS = 5;
export const MAX_CHANNEL_DIALOG_COMMENT_FILES = 3;
export const MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH = 8_000_000;
export const MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 = 24_000_000;
export const MAX_CHANNEL_SUGGESTION_VIDEO_BYTES = 24_000_000;
export const MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH = 32_000_000;

export const channelSuggestionVideoInputSchema = /*#__PURE__*/ z.object({
  base64: z.string().trim().min(4).max(MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH),
  mimeType: z.enum(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']),
  fileName: z.string().trim().max(128).default(''),
});
export type ChannelSuggestionVideoInput = z.infer<typeof channelSuggestionVideoInputSchema>;

export const publishChannelEngagementRequestSchema = /*#__PURE__*/ z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .default('Есть идея или обратная связь? Нажмите кнопку ниже.'),
  commentsButtonText: z.string().trim().min(1).max(32).default('💬 Комментарии'),
  suggestButtonText: z.string().trim().min(1).max(32).default('📰 Предложить пост'),
});
export type PublishChannelEngagementRequest = z.infer<typeof publishChannelEngagementRequestSchema>;

export const publishChannelEngagementResultSchema = /*#__PURE__*/ z.object({
  chatId: z.string(),
  sent: z.boolean(),
  messageId: z.string().nullable(),
  updatedExisting: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable().default(null),
});
export type PublishChannelEngagementResult = z.infer<typeof publishChannelEngagementResultSchema>;

export const channelDialogImageInputSchema = /*#__PURE__*/ z
  .object({
    base64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base64'],
        message: 'Добавьте фото.',
      });
    }

    if (!value.mimeType.trim() || !value.mimeType.toLowerCase().startsWith('image/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат фото.',
      });
    }
  });
export type ChannelDialogImageInput = z.infer<typeof channelDialogImageInputSchema>;

export const channelDialogAttachmentKindSchema = /*#__PURE__*/ z.enum(['image', 'file']);
export type ChannelDialogAttachmentKind = z.infer<typeof channelDialogAttachmentKindSchema>;

export const channelDialogAttachmentInputSchema = /*#__PURE__*/ z
  .object({
    type: channelDialogAttachmentKindSchema,
    base64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base64'],
        message: value.type === 'image' ? 'Добавьте фото.' : 'Добавьте файл.',
      });
    }

    if (value.type === 'image') {
      if (!value.mimeType.trim() || !value.mimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mimeType'],
          message: 'Неверный формат фото.',
        });
      }
      return;
    }

    if (!value.mimeType.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат файла.',
      });
    }
  });
export type ChannelDialogAttachmentInput = z.infer<typeof channelDialogAttachmentInputSchema>;

export const createChannelDialogMessageRequestSchema = /*#__PURE__*/ z
  .object({
    token: z.string().trim().min(16).max(256),
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u)
      .optional(),
    text: z.string().trim().max(2_000).default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    video: channelSuggestionVideoInputSchema.optional(),
    replyToMessageId: z.string().trim().min(1).max(191).nullable().optional(),
    attachments: z
      .array(channelDialogAttachmentInputSchema)
      .max(MAX_CHANNEL_DIALOG_ATTACHMENTS)
      .default([]),
    imageBase64: z.string().trim().max(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    images: z
      .array(channelDialogImageInputSchema)
      .max(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.video &&
      (value.images.length > 0 || value.attachments.length > 0 || value.imageBase64)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['video'],
        message: 'Добавьте фотографии или одно видео в отдельном предложении.',
      });
    }
    if (
      value.images.length === 0 &&
      value.imageBase64 &&
      (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageMimeType'],
        message: 'Неверный формат фото.',
      });
    }

    const legacyImageAttachment =
      value.images.length === 0 && value.imageBase64
        ? {
            type: 'image' as const,
            base64: value.imageBase64.trim(),
            mimeType: value.imageMimeType.trim(),
            fileName: value.imageFileName.trim(),
          }
        : null;
    const normalizedAttachments = [
      ...value.attachments,
      ...(legacyImageAttachment ? [legacyImageAttachment] : []),
    ];
    const normalizedMedia = [
      ...normalizedAttachments,
      ...value.images.map((image) => ({
        type: 'image' as const,
        base64: image.base64,
        mimeType: image.mimeType,
        fileName: image.fileName,
      })),
    ];

    if (normalizedAttachments.length > MAX_CHANNEL_DIALOG_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: `Можно добавить до ${MAX_CHANNEL_DIALOG_ATTACHMENTS} вложений.`,
      });
    }

    const fileAttachments = normalizedAttachments.filter(
      (attachment) => attachment.type === 'file',
    );
    if (fileAttachments.length > MAX_CHANNEL_DIALOG_COMMENT_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: `Можно прикрепить до ${MAX_CHANNEL_DIALOG_COMMENT_FILES} файлов.`,
      });
    }

    const totalBase64Length = normalizedMedia.reduce(
      (acc, attachment) => acc + attachment.base64.trim().length,
      0,
    );
    if (totalBase64Length > MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: 'Суммарный размер вложений слишком большой.',
      });
    }
  })
  .transform((value) => ({
    ...value,
    images:
      value.images.length > 0
        ? value.images
        : value.imageBase64
          ? [
              {
                base64: value.imageBase64.trim(),
                mimeType: value.imageMimeType.trim(),
                fileName: value.imageFileName.trim(),
              },
            ]
          : [],
    attachments: [
      ...value.attachments,
      ...(value.images.length === 0 && value.imageBase64
        ? [
            {
              type: 'image' as const,
              base64: value.imageBase64.trim(),
              mimeType: value.imageMimeType.trim(),
              fileName: value.imageFileName.trim(),
              width: undefined,
              height: undefined,
            },
          ]
        : []),
    ].slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS),
  }));
export type CreateChannelDialogMessageRequest = z.infer<
  typeof createChannelDialogMessageRequestSchema
>;

export const channelDialogReactionGroupSchema = /*#__PURE__*/ z.object({
  emoji: z.string().trim().min(1).max(16),
  count: z.number().int().min(1),
  reactedByMe: z.boolean().default(false),
});
export type ChannelDialogReactionGroup = z.infer<typeof channelDialogReactionGroupSchema>;

export const channelDialogReplyPreviewSchema = /*#__PURE__*/ z.object({
  messageId: z.string(),
  authorDisplayName: z.string().nullable(),
  text: z.string(),
});
export type ChannelDialogReplyPreview = z.infer<typeof channelDialogReplyPreviewSchema>;

export const channelDialogSuggestionReviewStatusSchema = /*#__PURE__*/ z.enum([
  'pending',
  'published',
  'cancelled',
]);
export type ChannelDialogSuggestionReviewStatus = z.infer<
  typeof channelDialogSuggestionReviewStatusSchema
>;

export const channelSuggestionDeliveryStateSchema = /*#__PURE__*/ z.enum([
  'queued',
  'delivered',
  'partially_delivered',
  'no_reachable_editor',
  'uncertain',
]);
export type ChannelSuggestionDeliveryState = z.infer<typeof channelSuggestionDeliveryStateSchema>;

export const channelSuggestionDeliverySummarySchema = /*#__PURE__*/ z.object({
  state: channelSuggestionDeliveryStateSchema,
  deliveredCount: z.number().int().min(0),
  targetCount: z.number().int().min(0),
  pendingCount: z.number().int().min(0),
  unreachableCount: z.number().int().min(0),
});
export type ChannelSuggestionDeliverySummary = z.infer<
  typeof channelSuggestionDeliverySummarySchema
>;

export const channelDialogSuggestionDeliverySchema = /*#__PURE__*/ z
  .object({
    state: channelSuggestionDeliveryStateSchema,
    // FLAG: Normalize legacy wire counts for two-way rollout compatibility without exposing topology.
    deliveredCount: z.number().int().min(0).optional(),
    targetCount: z.number().int().min(0).optional(),
    pendingCount: z.number().int().min(0).optional(),
    unreachableCount: z.number().int().min(0).optional(),
  })
  .strict()
  .transform((value) => ({
    state: value.state,
    deliveredCount: 0 as const,
    targetCount: 0 as const,
    pendingCount: 0 as const,
    unreachableCount: 0 as const,
  }));
export type ChannelDialogSuggestionDelivery = z.infer<typeof channelDialogSuggestionDeliverySchema>;

export const channelDialogAttachmentSchema = /*#__PURE__*/ z.object({
  kind: channelDialogAttachmentKindSchema,
  url: z.string().trim().url().nullable().default(null),
  previewUrl: z.string().trim().url().nullable().default(null),
  fileName: z.string().trim().max(128).nullable().default(null),
  mimeType: z.string().trim().max(128).nullable().default(null),
  size: z.number().int().min(0).nullable().default(null),
  width: z.number().int().min(1).nullable().optional(),
  height: z.number().int().min(1).nullable().optional(),
});
export type ChannelDialogAttachment = z.infer<typeof channelDialogAttachmentSchema>;

export const channelDialogMessageSchema = /*#__PURE__*/ z.object({
  id: z.string(),
  type: channelDialogTypeSchema,
  text: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string().nullable(),
  isAdmin: z.boolean().default(false),
  avatarUrl: z.string().trim().url().nullable().default(null),
  textFormat: broadcastTextFormatSchema.optional(),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  replyTo: channelDialogReplyPreviewSchema.nullable().optional(),
  attachments: z
    .array(channelDialogAttachmentSchema)
    .max(MAX_CHANNEL_DIALOG_ATTACHMENTS)
    .default([]),
  reactionGroups: z.array(channelDialogReactionGroupSchema).default([]),
  canEdit: z.boolean().default(false),
  canDelete: z.boolean().default(false),
  canDeleteAsAdmin: z.boolean().default(false),
  delivered: z.boolean().optional(),
  suggestionDelivery: channelDialogSuggestionDeliverySchema.optional(),
  reviewStatus: channelDialogSuggestionReviewStatusSchema.optional(),
  publishedUrl: z.string().trim().max(2_048).nullable().optional(),
  hasImage: z.boolean().optional(),
  imageCount: z.number().int().min(0).optional(),
  imageFileName: z.string().trim().max(128).nullable().optional(),
  imageFileNames: z
    .array(z.string().trim().max(128))
    .max(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES)
    .optional(),
  hasVideo: z.boolean().optional(),
  videoFileName: z.string().trim().max(128).nullable().optional(),
});
export type ChannelDialogMessage = z.infer<typeof channelDialogMessageSchema>;

export const channelDialogNotificationModeSchema = /*#__PURE__*/ z.enum(['off', 'replies', 'all']);
export type ChannelDialogNotificationMode = z.infer<typeof channelDialogNotificationModeSchema>;

export const channelDialogNotificationScopeSchema = /*#__PURE__*/ z.enum([
  'thread',
  'channel',
  'all_channels',
]);
export type ChannelDialogNotificationScope = z.infer<typeof channelDialogNotificationScopeSchema>;

export const channelDialogScopedNotificationSettingsSchema = /*#__PURE__*/ z.object({
  mode: channelDialogNotificationModeSchema.default('off'),
  explicit: z.boolean().default(false),
});
export type ChannelDialogScopedNotificationSettings = z.infer<
  typeof channelDialogScopedNotificationSettingsSchema
>;

export const channelDialogNotificationSettingsSchema = /*#__PURE__*/ z.object({
  mode: channelDialogNotificationModeSchema.default('off'),
  canUseAll: z.boolean().default(true),
  scope: channelDialogNotificationScopeSchema.default('thread'),
  thread: channelDialogScopedNotificationSettingsSchema.default({
    mode: 'off',
    explicit: false,
  }),
  channel: channelDialogScopedNotificationSettingsSchema.default({
    mode: 'off',
    explicit: false,
  }),
  allChannels: channelDialogScopedNotificationSettingsSchema.default({
    mode: 'off',
    explicit: false,
  }),
  availableChannelCount: z.number().int().min(0).optional(),
});
export type ChannelDialogNotificationSettings = z.infer<
  typeof channelDialogNotificationSettingsSchema
>;

export const channelDialogResponseSchema = /*#__PURE__*/ z.object({
  chatId: z.string(),
  entityTitle: z.string().trim().nullable().optional(),
  type: channelDialogTypeSchema,
  introText: z.string().nullable().default(null),
  messages: z.array(channelDialogMessageSchema),
  hasMoreMessages: z.boolean().optional(),
  notificationSettings: channelDialogNotificationSettingsSchema.default({
    mode: 'off',
    canUseAll: true,
    scope: 'thread',
    thread: {
      mode: 'off',
      explicit: false,
    },
    channel: {
      mode: 'off',
      explicit: false,
    },
    allChannels: {
      mode: 'off',
      explicit: false,
    },
  }),
});
export type ChannelDialogResponse = z.infer<typeof channelDialogResponseSchema>;

export const channelSuggestionRedirectResponseSchema = /*#__PURE__*/ z.object({
  url: z.string().trim().url(),
  title: z.string().trim().max(256).nullable().default(null),
});
export type ChannelSuggestionRedirectResponse = z.infer<
  typeof channelSuggestionRedirectResponseSchema
>;

export const createChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type CreateChannelDialogMessageResponse = z.infer<
  typeof createChannelDialogMessageResponseSchema
>;

export const updateChannelDialogMessageRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
  text: z.string().trim().max(2_000).default(''),
});
export type UpdateChannelDialogMessageRequest = z.infer<
  typeof updateChannelDialogMessageRequestSchema
>;

export const updateChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type UpdateChannelDialogMessageResponse = z.infer<
  typeof updateChannelDialogMessageResponseSchema
>;

export const toggleChannelDialogReactionRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
  emoji: z.string().trim().min(1).max(16),
});
export type ToggleChannelDialogReactionRequest = z.infer<
  typeof toggleChannelDialogReactionRequestSchema
>;

export const toggleChannelDialogReactionResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  message: channelDialogMessageSchema,
});
export type ToggleChannelDialogReactionResponse = z.infer<
  typeof toggleChannelDialogReactionResponseSchema
>;

export const updateChannelDialogNotificationsRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
  mode: channelDialogNotificationModeSchema,
  scope: channelDialogNotificationScopeSchema.default('thread'),
});
export type UpdateChannelDialogNotificationsRequest = z.infer<
  typeof updateChannelDialogNotificationsRequestSchema
>;

export const updateChannelDialogNotificationsResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  notificationSettings: channelDialogNotificationSettingsSchema,
});
export type UpdateChannelDialogNotificationsResponse = z.infer<
  typeof updateChannelDialogNotificationsResponseSchema
>;

export const deleteChannelDialogMessageRequestSchema = /*#__PURE__*/ z.object({
  token: z.string().trim().min(16).max(256),
});
export type DeleteChannelDialogMessageRequest = z.infer<
  typeof deleteChannelDialogMessageRequestSchema
>;

export const deleteChannelDialogMessageResponseSchema = /*#__PURE__*/ z.object({
  ok: z.boolean(),
  deletedMessageId: z.string(),
});
export type DeleteChannelDialogMessageResponse = z.infer<
  typeof deleteChannelDialogMessageResponseSchema
>;

export const commentRestrictionSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(['MUTE', 'BAN']).nullable(),
  expiresAt: z.string().datetime().nullable(),
  reason: z.string().max(300),
  revision: z.number().int().nonnegative(),
});
export type CommentRestriction = z.infer<typeof commentRestrictionSchema>;

export const commentModerationStateSchema = z.object({
  canManage: z.boolean(),
  restriction: commentRestrictionSchema,
});

export const commentRestrictionsPageSchema = z.object({
  items: z.array(commentRestrictionSchema),
  nextCursor: z.string().nullable(),
});

export const updateCommentRestrictionRequestSchema = z
  .object({
    token: z.string().trim().min(16).max(256),
    action: z.enum(['MUTE', 'BAN', 'RELEASE']),
    durationSeconds: z.union([z.literal(3600), z.literal(86400), z.literal(604800)]).optional(),
    reason: z.string().trim().max(300).default(''),
    expectedRevision: z.number().int().nonnegative(),
    sourceMessageId: z.string().trim().min(1).max(191).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === 'MUTE') !== (value.durationSeconds !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: 'Укажите срок только для мута.',
      });
    }
  });
export type UpdateCommentRestrictionRequest = z.infer<typeof updateCommentRestrictionRequestSchema>;
