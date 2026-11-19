import { z } from 'zod';

const managedEntityTypeSchema = z.enum(['chat', 'channel']);
const managedGiveawayImageBase64MaxLength = 8_000_000;

export const managedGiveawayStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'DRAWING',
  'COMPLETED',
  'CANCELED',
]);
export const giveawayEligibilityStateSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED']);
export const managedGiveawayWinnerStatusSchema = z.enum([
  'SELECTED',
  'CLAIMED',
  'DELIVERED',
  'EXPIRED',
  'REROLLED',
]);

export type ManagedGiveawayStatus = z.infer<typeof managedGiveawayStatusSchema>;
export type GiveawayEligibilityState = z.infer<typeof giveawayEligibilityStateSchema>;
export type ManagedGiveawayWinnerStatus = z.infer<typeof managedGiveawayWinnerStatusSchema>;

export const MANAGED_GIVEAWAY_MAX_PRIZES = 10;
export const MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS = 10;
export const MANAGED_GIVEAWAY_TITLE_MAX_LENGTH = 120;
export const MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH = 2_000;
export const MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH = 120;

const managedGiveawayTitleSchema = z.string().trim().min(1).max(MANAGED_GIVEAWAY_TITLE_MAX_LENGTH);
const managedGiveawayDescriptionSchema = z
  .string()
  .trim()
  .max(MANAGED_GIVEAWAY_DESCRIPTION_MAX_LENGTH)
  .default('');
const managedGiveawayPrizeTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MANAGED_GIVEAWAY_PRIZE_TITLE_MAX_LENGTH);

export const managedGiveawayPrizeDraftSchema = z.object({
  position: z.number().int().min(1).max(MANAGED_GIVEAWAY_MAX_PRIZES),
  title: managedGiveawayPrizeTitleSchema,
  displayTitle: managedGiveawayPrizeTitleSchema.optional(),
});
export type ManagedGiveawayPrizeDraft = z.infer<typeof managedGiveawayPrizeDraftSchema>;

export const updateManagedGiveawayRequestSchema = z
  .object({
    title: managedGiveawayTitleSchema,
    description: managedGiveawayDescriptionSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(managedGiveawayImageBase64MaxLength).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime(),
    claimHours: z.number().int().min(1).max(336).default(24),
    requiredChannelIds: z
      .array(z.string().trim().min(1).max(128))
      .max(MANAGED_GIVEAWAY_MAX_REQUIRED_CHANNELS)
      .default([]),
    prizes: z.array(managedGiveawayPrizeDraftSchema).min(1).max(MANAGED_GIVEAWAY_MAX_PRIZES),
  })
  .superRefine((value, ctx) => {
    const startsAt = value.startsAt ? Date.parse(value.startsAt) : Date.now();
    const endsAt = Date.parse(value.endsAt);

    if (!Number.isFinite(endsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Укажите корректное время завершения.',
      });
    } else if (endsAt <= startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Завершение должно быть позже старта.',
      });
    }

    if (value.imageEnabled) {
      if (!value.imageBase64.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageBase64'],
          message: 'Добавьте изображение розыгрыша.',
        });
      }

      if (!value.imageMimeType.trim() || !value.imageMimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imageMimeType'],
          message: 'Поддерживаются только изображения.',
        });
      }
    }

    const positions = new Set<number>();
    for (const [index, prize] of value.prizes.entries()) {
      if (positions.has(prize.position)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prizes', index, 'position'],
          message: 'Позиции призов не должны повторяться.',
        });
      }
      positions.add(prize.position);
    }

    const normalizedRequiredChannels = new Set<string>();
    for (const [index, channelId] of value.requiredChannelIds.entries()) {
      const key = channelId.trim().toLowerCase().replace(/\s+/gu, '');
      if (normalizedRequiredChannels.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredChannelIds', index],
          message: 'Каналы не должны повторяться.',
        });
      }
      normalizedRequiredChannels.add(key);
    }
  });
export type UpdateManagedGiveawayRequest = z.infer<typeof updateManagedGiveawayRequestSchema>;

export const managedGiveawayDraftRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
});

export const managedGiveawayPrizeSchema = z.object({
  id: z.string(),
  position: z.number().int().min(1),
  title: managedGiveawayPrizeTitleSchema,
  displayTitle: managedGiveawayPrizeTitleSchema,
});
export type ManagedGiveawayPrize = z.infer<typeof managedGiveawayPrizeSchema>;

export const managedGiveawayWinnerSchema = z.object({
  id: z.string(),
  prizeId: z.string(),
  prizePosition: z.number().int().min(1),
  prizeTitle: managedGiveawayPrizeTitleSchema,
  prizeDisplayTitle: managedGiveawayPrizeTitleSchema,
  entryId: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  status: managedGiveawayWinnerStatusSchema,
  selectedAt: z.string().datetime(),
  claimDeadlineAt: z.string().datetime().nullable(),
  claimedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  expiredAt: z.string().datetime().nullable(),
  rerolledAt: z.string().datetime().nullable(),
});
export type ManagedGiveawayWinner = z.infer<typeof managedGiveawayWinnerSchema>;

export const managedGiveawaySummarySchema = z.object({
  id: z.string(),
  title: managedGiveawayTitleSchema,
  status: managedGiveawayStatusSchema,
  hasImage: z.boolean(),
  entriesCount: z.number().int().min(0),
  verifiedEntriesCount: z.number().int().min(0),
  pendingEntriesCount: z.number().int().min(0),
  winnersCount: z.number().int().min(0),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  publicationUrl: z.string().nullable(),
  resultsUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedGiveawaySummary = z.infer<typeof managedGiveawaySummarySchema>;

export const managedGiveawayPublicChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  link: z.string().nullable(),
});
export type ManagedGiveawayPublicChannel = z.infer<typeof managedGiveawayPublicChannelSchema>;

export const managedGiveawayDetailsSchema = managedGiveawaySummarySchema.extend({
  draftRevision: z.number().int().positive().optional(),
  sourceChatId: z.string(),
  entityType: managedEntityTypeSchema,
  description: managedGiveawayDescriptionSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
  claimHours: z.number().int().min(1).max(336),
  requiredChannelIds: z.array(z.string()),
  requiredChannels: z.array(managedGiveawayPublicChannelSchema).optional(),
  publicationMessageId: z.string().nullable(),
  resultsMessageId: z.string().nullable(),
  prizes: z.array(managedGiveawayPrizeSchema),
  winners: z.array(managedGiveawayWinnerSchema),
});
export type ManagedGiveawayDetails = z.infer<typeof managedGiveawayDetailsSchema>;

export const managedGiveawayPublicWinnerSchema = z.object({
  prizePosition: z.number().int().min(1),
  prizeTitle: managedGiveawayPrizeTitleSchema,
  prizeDisplayTitle: managedGiveawayPrizeTitleSchema,
  displayName: z.string().nullable(),
  status: managedGiveawayWinnerStatusSchema,
});
export type ManagedGiveawayPublicWinner = z.infer<typeof managedGiveawayPublicWinnerSchema>;

export const managedGiveawayPublicSchema = z.object({
  id: z.string(),
  serverTime: z.string().datetime().optional(),
  sourceChatId: z.string(),
  sourceTitle: z.string(),
  sourceLink: z.string().nullable(),
  sourceAvatarUrl: z.string().trim().url().nullable().optional(),
  entityType: managedEntityTypeSchema,
  title: managedGiveawayTitleSchema,
  description: managedGiveawayDescriptionSchema,
  status: managedGiveawayStatusSchema,
  imageEnabled: z.boolean(),
  imageBase64: z.string(),
  imageMimeType: z.string(),
  imageFileName: z.string(),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime(),
  claimHours: z.number().int().min(1).max(336),
  requiredChannelIds: z.array(z.string()),
  requiredChannels: z.array(managedGiveawayPublicChannelSchema),
  entriesCount: z.number().int().min(0),
  winnersCount: z.number().int().min(0),
  publishedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  publicationUrl: z.string().nullable(),
  resultsUrl: z.string().nullable(),
  prizes: z.array(managedGiveawayPrizeSchema),
  winners: z.array(managedGiveawayPublicWinnerSchema),
});
export type ManagedGiveawayPublic = z.infer<typeof managedGiveawayPublicSchema>;

export const managedGiveawayParticipantStateSchema = z.object({
  joined: z.boolean(),
  checkedAt: z.string().datetime().nullable().optional(),
  entryId: z.string().nullable(),
  eligibilityState: giveawayEligibilityStateSchema.nullable(),
  eligibilityReason: z.string().nullable(),
  missingChannelIds: z.array(z.string()),
  joinedAt: z.string().datetime().nullable(),
  isWinner: z.boolean(),
  winnerId: z.string().nullable(),
  winnerStatus: managedGiveawayWinnerStatusSchema.nullable(),
  claimDeadlineAt: z.string().datetime().nullable(),
  prizePosition: z.number().int().min(1).nullable(),
  prizeTitle: z.string().nullable(),
  prizeDisplayTitle: z.string().nullable(),
  canClaim: z.boolean(),
  claimBotUrl: z.string().nullable(),
});
export type ManagedGiveawayParticipantState = z.infer<typeof managedGiveawayParticipantStateSchema>;

export const rerollManagedGiveawayWinnerRequestSchema = z.object({
  winnerId: z.string().trim().min(1),
});
export type RerollManagedGiveawayWinnerRequest = z.infer<
  typeof rerollManagedGiveawayWinnerRequestSchema
>;

export const markManagedGiveawayWinnerDeliveredRequestSchema = z.object({
  winnerId: z.string().trim().min(1),
});
export type MarkManagedGiveawayWinnerDeliveredRequest = z.infer<
  typeof markManagedGiveawayWinnerDeliveredRequestSchema
>;

export const managedGiveawayHandoffRequestSchema = z.object({
  giveawayId: z.string().trim().min(1).nullable().default(null),
});
export type ManagedGiveawayHandoffRequest = z.infer<typeof managedGiveawayHandoffRequestSchema>;

export const claimManagedGiveawayResponseSchema = z.object({
  ok: z.literal(true),
  winner: managedGiveawayWinnerSchema,
});
export type ClaimManagedGiveawayResponse = z.infer<typeof claimManagedGiveawayResponseSchema>;
