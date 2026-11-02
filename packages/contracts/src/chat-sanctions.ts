import { z } from 'zod';

export const chatSanctionsQuerySchema = z.object({
  status: z.enum(['active', 'archive', 'review', 'all']).default('active'),
  action: z.enum(['all', 'MUTE', 'BAN']).default('all'),
  search: z.string().trim().max(100).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type ChatSanctionsQuery = z.infer<typeof chatSanctionsQuerySchema>;

export const chatSanctionItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userDisplayName: z.string(),
  avatarUrl: z.string().url().nullable(),
  profileHandoffUrl: z.string().url().nullable(),
  action: z.enum(['MUTE', 'BAN']),
  status: z.enum(['active', 'expired', 'released', 'replaced', 'review']),
  ruleCode: z.string(),
  reason: z.string().nullable(),
  operator: z.enum(['ADMIN', 'BOT']),
  actorDisplayName: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  permanent: z.boolean(),
  releaseAction: z.enum(['UNMUTE', 'UNBAN']).nullable(),
  banOnRejoin: z.boolean().optional(),
});
export type ChatSanctionItem = z.infer<typeof chatSanctionItemSchema>;

export const chatSanctionsPageSchema = z.object({
  items: z.array(chatSanctionItemSchema),
  serverTime: z.string().datetime(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type ChatSanctionsPage = z.infer<typeof chatSanctionsPageSchema>;
