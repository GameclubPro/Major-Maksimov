import { z } from 'zod';

export const moderationMessageContentSchema = z.object({
  // PostgreSQL LEFT counts Unicode code points; allow surrogate pairs without losing saved text.
  text: z
    .string()
    .max(32000)
    .refine((text) => Array.from(text).length <= 16000),
  truncated: z.boolean(),
  attachments: z
    .array(z.enum(['image', 'video', 'audio', 'file', 'sticker', 'contact', 'location', 'other']))
    .max(32),
});
export type ModerationMessageContent = z.infer<typeof moderationMessageContentSchema>;

export const moderationMessageDetailsSchema = z.object({
  eventId: z.string(),
  state: z.enum(['saved', 'partial', 'not_captured', 'expired']),
  content: moderationMessageContentSchema.nullable(),
  sourceAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type ModerationMessageDetails = z.infer<typeof moderationMessageDetailsSchema>;
